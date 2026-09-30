from __future__ import annotations

import csv
import calendar
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, Response, jsonify, render_template, request, send_file, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.getenv("DATABASE_PATH", str(BASE_DIR / "progress_tracker.db"))).expanduser()
TIMEZONE = ZoneInfo(os.getenv("TRACKER_TIMEZONE", "Asia/Kolkata"))
BACKUP_SETTINGS_FILE = BASE_DIR / "backup_settings.json"
BACKUP_STATUS_FILE = BASE_DIR / "backup_status.json"
SCHEDULED_BACKUP_TASK = "ProgressTrackerAutomaticBackup"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


def today() -> date:
    return datetime.now(TIMEZONE).date()


def minutes_from_hours(hours: float) -> int:
    """Convert the legacy on-disk hour value to the app's minute display unit."""
    return round(hours * 60)


def connection() -> sqlite3.Connection:
    con = sqlite3.connect(DATABASE)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db() -> None:
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with connection() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS daily_logs (
                log_date TEXT PRIMARY KEY,
                reflection TEXT NOT NULL DEFAULT '',
                missed_reason TEXT NOT NULL DEFAULT '',
                missed_reason_note TEXT NOT NULL DEFAULT '',
                locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                log_date TEXT NOT NULL,
                name TEXT NOT NULL,
                hours REAL NOT NULL CHECK(hours > 0),
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(log_date) REFERENCES daily_logs(log_date) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(log_date);
            CREATE INDEX IF NOT EXISTS idx_tasks_name ON tasks(name);
            CREATE TABLE IF NOT EXISTS earned_badges (
                badge_id TEXT PRIMARY KEY,
                milestone_days INTEGER NOT NULL,
                badge_year INTEGER NOT NULL,
                badge_version TEXT NOT NULL DEFAULT 'v1',
                unlocked_on TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(milestone_days, badge_year)
            );
        """)
        columns = {row["name"] for row in con.execute("PRAGMA table_info(daily_logs)")}
        if "missed_reason" not in columns:
            con.execute("ALTER TABLE daily_logs ADD COLUMN missed_reason TEXT NOT NULL DEFAULT ''")
        if "missed_reason_note" not in columns:
            con.execute("ALTER TABLE daily_logs ADD COLUMN missed_reason_note TEXT NOT NULL DEFAULT ''")
        badge_columns = {row["name"] for row in con.execute("PRAGMA table_info(earned_badges)")}
        if "badge_version" not in badge_columns:
            con.execute("ALTER TABLE earned_badges ADD COLUMN badge_version TEXT NOT NULL DEFAULT 'v1'")


def default_backup_settings() -> dict:
    return {"folder": "", "frequency": "manual", "time": "03:00", "weekday": "SUN", "month_day": 1}


def load_backup_settings() -> dict:
    try:
        saved = json.loads(BACKUP_SETTINGS_FILE.read_text(encoding="utf-8"))
        return {**default_backup_settings(), **saved}
    except (OSError, ValueError, TypeError):
        return default_backup_settings()


def save_json(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_backup_status() -> dict:
    try:
        return json.loads(BACKUP_STATUS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"state": "not_configured"}


def backup_status(state: str, **details: object) -> None:
    save_json(BACKUP_STATUS_FILE, {
        "state": state,
        "updated_at": datetime.now(TIMEZONE).isoformat(timespec="seconds"),
        **details,
    })


def run_google_drive_backup() -> dict:
    """Write a consistent database snapshot to the Google Drive desktop folder."""
    settings = load_backup_settings()
    folder = str(settings.get("folder", "")).strip()
    if not folder:
        raise ValueError("Choose your Google Drive folder before running a backup.")
    backup_dir = Path(folder).expanduser()
    backup_status("uploading", message="Creating a secure database snapshot…")
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(TIMEZONE).strftime("%Y-%m-%d_%H-%M-%S-%f")
        destination = backup_dir / f"progress-tracker-{timestamp}.db"
        temporary = destination.with_suffix(".tmp")
        source = sqlite3.connect(DATABASE)
        copy = sqlite3.connect(temporary)
        try:
            source.backup(copy)
        finally:
            copy.close()
            source.close()
        temporary.replace(destination)
        result = {"state": "complete", "message": "Backup saved. Google Drive will upload it in the background.",
                  "file_name": destination.name, "size_bytes": destination.stat().st_size}
        backup_status(**result)
        return {**result, "updated_at": datetime.now(TIMEZONE).isoformat(timespec="seconds")}
    except Exception as error:
        if "temporary" in locals():
            temporary.unlink(missing_ok=True)
        backup_status("failed", message=str(error))
        raise


def task_command() -> str:
    return f'"{sys.executable}" "{Path(__file__).resolve()}" --run-scheduled-backup'


def configure_windows_backup_schedule(settings: dict) -> None:
    frequency = settings["frequency"]
    if os.name != "nt":
        raise RuntimeError("Automatic schedules are available when this app runs on Windows.")
    if frequency == "manual":
        subprocess.run(["schtasks", "/delete", "/tn", SCHEDULED_BACKUP_TASK, "/f"], capture_output=True, text=True)
        return
    arguments = ["schtasks", "/create", "/tn", SCHEDULED_BACKUP_TASK, "/tr", task_command(), "/sc", frequency.upper(), "/st", settings["time"], "/f"]
    if frequency == "weekly":
        arguments.extend(["/d", settings["weekday"]])
    elif frequency == "monthly":
        arguments.extend(["/d", str(settings["month_day"])])
    try:
        completed = subprocess.run(arguments, capture_output=True, text=True)
    except OSError as error:
        raise RuntimeError(f"Windows could not create the backup schedule: {error}") from error
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "Windows could not create the backup schedule.")


def lock_history(con: sqlite3.Connection) -> None:
    con.execute("UPDATE daily_logs SET locked = 1 WHERE log_date < ?", (today().isoformat(),))


def ensure_today_log(con: sqlite3.Connection) -> None:
    con.execute(
        "INSERT OR IGNORE INTO daily_logs (log_date) VALUES (?)", (today().isoformat(),)
    )


@app.before_request
def enforce_daily_lock() -> None:
    init_db()
    with connection() as con:
        lock_history(con)
        ensure_today_log(con)


def day_payload(con: sqlite3.Connection, log_date: str) -> dict:
    log = con.execute("SELECT * FROM daily_logs WHERE log_date = ?", (log_date,)).fetchone()
    tasks = con.execute("SELECT * FROM tasks WHERE log_date = ? ORDER BY created_at, id", (log_date,)).fetchall()
    return {
        "date": log_date,
        "reflection": log["reflection"] if log else "",
        "missed_reason": log["missed_reason"] if log else "",
        "missed_reason_note": log["missed_reason_note"] if log else "",
        "locked": bool(log["locked"]) if log else log_date < today().isoformat(),
        "total_hours": round(sum(task["hours"] for task in tasks), 2),
        "total_minutes": minutes_from_hours(sum(task["hours"] for task in tasks)),
        "tasks": [{**dict(task), "minutes": minutes_from_hours(task["hours"])} for task in tasks],
    }


def editable(con: sqlite3.Connection, log_date: str) -> tuple[bool, str | None]:
    if log_date != today().isoformat():
        return False, "Only today can be changed. Previous days are permanently locked."
    log = con.execute("SELECT locked FROM daily_logs WHERE log_date = ?", (log_date,)).fetchone()
    if log and log["locked"]:
        return False, "This daily record is locked."
    return True, None


def validation_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


BADGE_MILESTONES = (30, 60, 90, 120, 180, 240, 300, 365)
CURRENT_BADGE_VERSION = "v1"


def record_earned_badges(con: sqlite3.Connection, badge_year: int) -> tuple[int, dict[int, dict[str, object]]]:
    """Persist every completed calendar-year streak badge, without revoking awards."""
    rows = con.execute("""
        SELECT log_date FROM tasks WHERE log_date BETWEEN ? AND ?
        GROUP BY log_date ORDER BY log_date
    """, (f"{badge_year}-01-01", f"{badge_year}-12-31")).fetchall()
    streak = longest_streak = 0
    previous = None
    newly_unlocked: dict[int, date] = {}
    for row in rows:
        active_day = date.fromisoformat(row["log_date"])
        streak = streak + 1 if previous and active_day == previous + timedelta(days=1) else 1
        longest_streak = max(longest_streak, streak)
        previous = active_day
        if streak in BADGE_MILESTONES:
            newly_unlocked.setdefault(streak, active_day)
    for milestone, unlocked_on in newly_unlocked.items():
        con.execute("""
            INSERT OR IGNORE INTO earned_badges (badge_id, milestone_days, badge_year, badge_version, unlocked_on)
            VALUES (?, ?, ?, ?, ?)
        """, (f"{milestone}-day-badge-{badge_year}", milestone, badge_year, CURRENT_BADGE_VERSION, unlocked_on.isoformat()))
    stored = {row["milestone_days"]: {"unlocked_on": date.fromisoformat(row["unlocked_on"]), "version": row["badge_version"]}
              for row in con.execute("SELECT milestone_days, badge_version, unlocked_on FROM earned_badges WHERE badge_year=?", (badge_year,))}
    return longest_streak, stored


@app.get("/")
def index():
    return render_template("index.html", today=today().isoformat(), timezone=str(TIMEZONE))


@app.get("/badges/<path:filename>")
def badge_image(filename: str):
    return send_from_directory(BASE_DIR / "Badges", filename)


@app.get("/api/heatmap")
def heatmap():
    requested_year = request.args.get("year", type=int) or today().year
    if not 2000 <= requested_year <= today().year:
        return validation_error("Choose a valid year.")
    start = date(requested_year, 1, 1)
    end = min(date(requested_year, 12, 31), today())
    with connection() as con:
        rows = con.execute("""
            SELECT d.log_date, d.missed_reason, d.missed_reason_note, COALESCE(SUM(t.hours), 0) AS hours
            FROM daily_logs d LEFT JOIN tasks t ON d.log_date = t.log_date
            WHERE d.log_date BETWEEN ? AND ? GROUP BY d.log_date
        """, (start.isoformat(), end.isoformat())).fetchall()
        available = [row["year"] for row in con.execute("""
            SELECT DISTINCT substr(log_date, 1, 4) AS year FROM daily_logs
            UNION SELECT ? AS year ORDER BY year DESC
        """, (str(today().year),)).fetchall()]
    totals = {row["log_date"]: round(row["hours"], 2) for row in rows}
    missed_days = {row["log_date"]: {"reason": row["missed_reason"], "note": row["missed_reason_note"]}
                   for row in rows if row["missed_reason"]}
    return jsonify({"year": requested_year, "start": start.isoformat(), "end": end.isoformat(),
                    "days": totals, "missed_days": missed_days, "available_years": available})


@app.get("/api/day/<log_date>")
def get_day(log_date: str):
    try:
        requested = date.fromisoformat(log_date)
    except ValueError:
        return validation_error("Invalid date.")
    if requested > today():
        return validation_error("Future dates are not available.")
    with connection() as con:
        return jsonify(day_payload(con, log_date))


@app.post("/api/tasks")
def add_task():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    description = str(data.get("description", "")).strip()
    try:
        minutes = float(data.get("minutes"))
    except (TypeError, ValueError):
        return validation_error("Minutes must be a number.")
    if not name or len(name) > 160:
        return validation_error("Task name is required and must be 160 characters or fewer.")
    if not 0 < minutes <= 1440:
        return validation_error("Minutes must be greater than 0 and no more than 1,440.")
    if len(description) > 3000:
        return validation_error("Description must be 3,000 characters or fewer.")
    with connection() as con:
        allowed, message = editable(con, today().isoformat())
        if not allowed:
            return validation_error(message, 403)
        con.execute("INSERT INTO tasks (log_date, name, hours, description) VALUES (?, ?, ?, ?)",
                    (today().isoformat(), name, minutes / 60, description))
        record_earned_badges(con, today().year)
        con.execute("UPDATE daily_logs SET updated_at = CURRENT_TIMESTAMP WHERE log_date = ?", (today().isoformat(),))
        payload = day_payload(con, today().isoformat())
    return jsonify(payload), 201


@app.put("/api/tasks/<int:task_id>")
def update_task(task_id: int):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    description = str(data.get("description", "")).strip()
    try:
        minutes = float(data.get("minutes"))
    except (TypeError, ValueError):
        return validation_error("Minutes must be a number.")
    if not name or len(name) > 160 or not 0 < minutes <= 1440 or len(description) > 3000:
        return validation_error("Please provide a valid name, minutes (1–1,440), and description.")
    with connection() as con:
        task = con.execute("SELECT log_date FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not task:
            return validation_error("Task not found.", 404)
        allowed, message = editable(con, task["log_date"])
        if not allowed:
            return validation_error(message, 403)
        con.execute("UPDATE tasks SET name=?, hours=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (name, minutes / 60, description, task_id))
        payload = day_payload(con, task["log_date"])
    return jsonify(payload)


@app.delete("/api/tasks/<int:task_id>")
def delete_task(task_id: int):
    with connection() as con:
        task = con.execute("SELECT log_date FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not task:
            return validation_error("Task not found.", 404)
        allowed, message = editable(con, task["log_date"])
        if not allowed:
            return validation_error(message, 403)
        con.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        payload = day_payload(con, task["log_date"])
    return jsonify(payload)


@app.put("/api/reflection")
def reflection():
    reflection_text = str((request.get_json(silent=True) or {}).get("reflection", "")).strip()
    if len(reflection_text) > 5000:
        return validation_error("Reflection must be 5,000 characters or fewer.")
    with connection() as con:
        allowed, message = editable(con, today().isoformat())
        if not allowed:
            return validation_error(message, 403)
        con.execute("UPDATE daily_logs SET reflection=?, updated_at=CURRENT_TIMESTAMP WHERE log_date=?",
                    (reflection_text, today().isoformat()))
        payload = day_payload(con, today().isoformat())
    return jsonify(payload)


@app.put("/api/missed-day-reason")
def missed_day_reason():
    data = request.get_json(silent=True) or {}
    reason = str(data.get("reason", "")).strip().lower()
    note = str(data.get("note", "")).strip()
    valid_reasons = {"", "busy", "rest", "sick", "travel", "personal", "other"}
    if reason not in valid_reasons:
        return validation_error("Choose a valid missed-day reason.")
    if len(note) > 500:
        return validation_error("Your custom reason must be 500 characters or fewer.")
    if reason == "other" and not note:
        return validation_error("Add a custom reason before saving.")
    if reason != "other":
        note = ""
    with connection() as con:
        allowed, message = editable(con, today().isoformat())
        if not allowed:
            return validation_error(message, 403)
        con.execute("UPDATE daily_logs SET missed_reason=?, missed_reason_note=?, updated_at=CURRENT_TIMESTAMP WHERE log_date=?",
                    (reason, note, today().isoformat()))
        payload = day_payload(con, today().isoformat())
    return jsonify(payload)


@app.get("/api/stats")
def stats():
    with connection() as con:
        rows = con.execute("""
            SELECT d.log_date, COALESCE(SUM(t.hours),0) hours, COUNT(t.id) task_count
            FROM daily_logs d LEFT JOIN tasks t ON d.log_date=t.log_date
            GROUP BY d.log_date HAVING COUNT(t.id) > 0 ORDER BY d.log_date
        """).fetchall()
    totals = [(date.fromisoformat(r["log_date"]), float(r["hours"]), r["task_count"]) for r in rows]
    total_hours = sum(r[1] for r in totals)
    total_tasks = sum(r[2] for r in totals)
    current, longest, run = 0, 0, 0
    prev = None
    for item in totals:
        run = run + 1 if prev and item[0] == prev + timedelta(days=1) else 1
        longest = max(longest, run)
        prev = item[0]
    dates = {item[0] for item in totals}
    # A streak remains active throughout today, even before today's first task.
    # It only breaks once a full prior day has no recorded work.
    cursor = today() if today() in dates else today() - timedelta(days=1)
    while cursor in dates:
        current += 1
        cursor -= timedelta(days=1)
    best_day = max(totals, key=lambda r: r[1], default=None)
    months = Counter()
    for dt, hours, _ in totals:
        months[dt.strftime("%Y-%m")] += hours
    best_month = months.most_common(1)[0] if months else None
    return jsonify({"current_streak": current, "longest_streak": longest, "total_hours": round(total_hours, 2),
        "average_hours": round(total_hours / len(totals), 2) if totals else 0, "total_tasks": total_tasks,
        "productive_day": {"date": best_day[0].isoformat(), "hours": round(best_day[1], 2)} if best_day else None,
        "productive_month": {"month": best_month[0], "hours": round(best_month[1], 2)} if best_month else None})


@app.get("/api/achievements")
def achievements():
    """Return calendar-year streak badges in the same collection style as LeetCode."""
    requested_year = request.args.get("year", type=int) or today().year
    if not 2000 <= requested_year <= today().year:
        return validation_error("Choose a valid achievements year.")
    with connection() as con:
        longest_streak, unlocks = record_earned_badges(con, requested_year)
        years = [int(row["year"]) for row in con.execute("""
            SELECT DISTINCT substr(log_date, 1, 4) AS year FROM tasks
            UNION SELECT ? AS year ORDER BY year DESC
        """, (str(today().year),)).fetchall()]

    next_milestone = next((milestone for milestone in BADGE_MILESTONES if milestone not in unlocks), None)
    return jsonify({
        "year": requested_year,
        "available_years": years,
        "longest_streak": longest_streak,
        "next_milestone": next_milestone,
        "badges": [{
            "days": milestone,
            "image": f"/badges/{milestone}-days-{unlocks.get(milestone, {}).get('version', CURRENT_BADGE_VERSION)}.png",
            "unlocked": milestone in unlocks,
            "unlocked_on": unlocks[milestone]["unlocked_on"].isoformat() if milestone in unlocks else None,
            "remaining": max(0, milestone - longest_streak),
            "badge_id": f"{milestone}-day-badge-{requested_year}",
            "badge_version": unlocks.get(milestone, {}).get("version", CURRENT_BADGE_VERSION),
        } for milestone in BADGE_MILESTONES],
    })


@app.get("/api/progress")
def progress():
    """Return one complete, historic analytics period using only saved tasks."""
    period = request.args.get("period", "week")
    offset = request.args.get("offset", 0, type=int)
    if period not in {"week", "month", "year"}:
        return validation_error("Choose week, month, or year.")
    if offset is None or offset < 0 or offset > 5200:
        return validation_error("Choose a valid previous period.")

    current = today()
    def shift_month(value: date, months: int) -> date:
        index = value.year * 12 + value.month - 1 - months
        return date(index // 12, index % 12 + 1, 1)

    if period == "week":
        start = current - timedelta(days=current.weekday() + 7 * offset)
        end = start + timedelta(days=6)
        buckets = [start + timedelta(days=index) for index in range(7)]
        title = f"{start.strftime('%d %b')} – {end.strftime('%d %b %Y')}"
    elif period == "month":
        start = shift_month(current.replace(day=1), offset)
        end = date(start.year, start.month, calendar.monthrange(start.year, start.month)[1])
        buckets = [start + timedelta(days=index) for index in range((end - start).days + 1)]
        title = start.strftime("%B %Y")
    else:
        start = date(current.year - offset, 1, 1)
        end = date(start.year, 12, 31)
        buckets = [date(start.year, month, 1) for month in range(1, 13)]
        title = str(start.year)

    with connection() as con:
        task_rows = con.execute("""
            SELECT log_date, hours FROM tasks
            WHERE log_date BETWEEN ? AND ?
        """, (start.isoformat(), min(end, current).isoformat())).fetchall()
        earliest = con.execute("SELECT MIN(log_date) first_date FROM daily_logs").fetchone()["first_date"]
        history = con.execute("SELECT log_date, hours FROM tasks ORDER BY log_date").fetchall()

    values = [0.0] * len(buckets)
    sessions = [0] * len(buckets)
    keys = ({item.isoformat(): index for index, item in enumerate(buckets)} if period != "year"
            else {item.month: index for index, item in enumerate(buckets)})
    for row in task_rows:
        logged = date.fromisoformat(row["log_date"])
        key = logged.isoformat() if period != "year" else logged.month
        index = keys[key]
        values[index] += float(row["hours"])
        sessions[index] += 1

    cutoff = min(end, current)
    points = []
    for item, hours, count in zip(buckets, values, sessions):
        if period == "year":
            bucket_end = date(item.year, item.month, calendar.monthrange(item.year, item.month)[1])
            visible_days = max(0, (min(bucket_end, cutoff) - item).days + 1)
            item_date = item
            label, secondary = item.strftime("%b"), item.strftime("%Y")
        else:
            visible_days = 0 if item > cutoff else 1
            item_date = item
            label = item.strftime("%a") if period == "week" else str(item.day)
            secondary = f"{item.day} {item.strftime('%b')}" if period == "week" else item.strftime("%b")
        points.append({"date": item_date.isoformat(), "label": label, "secondary": secondary,
                       "hours": round(hours, 2), "sessions": count,
                       "average_session": round(hours / count, 2) if count else 0,
                       "is_today": item_date == current if period != "year" else item.month == current.month and item.year == current.year,
                       "is_future": visible_days == 0})

    period_values = [point["hours"] for point in points if not point["is_future"]]
    total = round(sum(period_values), 2)
    active = sum(value > 0 for value in period_values)
    day_count = max(1, sum(1 for point in points if not point["is_future"]))
    total_sessions = sum(sessions)
    previous_start = start - (end - start + timedelta(days=1))
    previous_end = start - timedelta(days=1)
    previous_total = sum(float(row["hours"]) for row in history
                         if previous_start <= date.fromisoformat(row["log_date"]) <= previous_end)
    change = round(((total - previous_total) / previous_total * 100), 1) if previous_total else None

    daily_totals: dict[date, float] = {}
    month_totals: Counter[str] = Counter()
    week_totals: Counter[str] = Counter()
    weekday_totals: Counter[int] = Counter()
    weekday_counts: Counter[int] = Counter()
    longest_session = 0.0
    for row in history:
        logged, hours = date.fromisoformat(row["log_date"]), float(row["hours"])
        daily_totals[logged] = daily_totals.get(logged, 0) + hours
        month_totals[logged.strftime("%Y-%m")] += hours
        monday = logged - timedelta(days=logged.weekday())
        week_totals[monday.isoformat()] += hours
        weekday_totals[logged.weekday()] += hours
        weekday_counts[logged.weekday()] += 1
        longest_session = max(longest_session, hours)
    best_day = max(daily_totals.items(), key=lambda item: item[1], default=None)
    best_week = max(week_totals.items(), key=lambda item: item[1], default=None)
    best_month = max(month_totals.items(), key=lambda item: item[1], default=None)
    productive_weekday = max(weekday_totals, key=weekday_totals.get) if weekday_totals else None
    dates_with_work = set(daily_totals)
    streak = 0
    cursor = current
    while cursor in dates_with_work:
        streak += 1
        cursor -= timedelta(days=1)
    achievements = [threshold for threshold in (50, 100, 250, 500) if sum(daily_totals.values()) >= threshold]
    has_more = bool(earliest and start > date.fromisoformat(earliest))
    return jsonify({
        "period": period, "offset": offset, "title": title, "start": start.isoformat(), "end": end.isoformat(),
        "points": points, "has_more": has_more, "total_hours": total, "active_periods": active,
        "average_hours": round(total / day_count, 2), "inactive_periods": max(0, day_count - active),
        "total_sessions": total_sessions, "average_session": round(total / total_sessions, 2) if total_sessions else 0,
        "comparison": {"percent": change, "previous_hours": round(previous_total, 2)},
        "insights": {"current_streak": streak, "longest_day": {"date": best_day[0].isoformat(), "hours": round(best_day[1], 2)} if best_day else None,
                     "best_week": {"date": best_week[0], "hours": round(best_week[1], 2)} if best_week else None,
                     "best_month": {"month": best_month[0], "hours": round(best_month[1], 2)} if best_month else None,
                     "longest_session": round(longest_session, 2),
                     "productive_weekday": calendar.day_name[productive_weekday] if productive_weekday is not None else None,
                     "achievements": achievements}
    })


@app.get("/api/progress/periods")
def progress_periods():
    """List analytics periods using the same titles shown above each chart."""
    period = request.args.get("period", "week")
    if period not in {"week", "month", "year"}:
        return validation_error("Choose week, month, or year.")

    current = today()
    with connection() as con:
        first_row = con.execute("SELECT MIN(log_date) AS first_date FROM tasks").fetchone()
    first_date = date.fromisoformat(first_row["first_date"]) if first_row["first_date"] else current

    if period == "week":
        current_start = current - timedelta(days=current.weekday())
        first_start = first_date - timedelta(days=first_date.weekday())
        oldest_offset = (current_start - first_start).days // 7
        periods = []
        for offset in range(oldest_offset + 1):
            start = current_start - timedelta(days=7 * offset)
            end = start + timedelta(days=6)
            periods.append({"offset": offset, "title": f"{start.strftime('%d %b')} – {end.strftime('%d %b %Y')}"})
    elif period == "month":
        oldest_offset = (current.year - first_date.year) * 12 + current.month - first_date.month
        periods = []
        for offset in range(oldest_offset + 1):
            index = current.year * 12 + current.month - 1 - offset
            start = date(index // 12, index % 12 + 1, 1)
            periods.append({"offset": offset, "title": start.strftime("%B %Y")})
    else:
        periods = [{"offset": offset, "title": str(current.year - offset)}
                   for offset in range(current.year - first_date.year + 1)]

    return jsonify({"period": period, "periods": periods})


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if len(query) < 2:
        return jsonify([])
    with connection() as con:
        rows = con.execute("SELECT * FROM tasks WHERE name LIKE ? OR description LIKE ? ORDER BY log_date DESC, id DESC LIMIT 100",
                           (f"%{query}%", f"%{query}%")).fetchall()
    return jsonify([{**dict(row), "minutes": minutes_from_hours(row["hours"])} for row in rows])


@app.get("/api/report/<month>")
def monthly_report(month: str):
    try:
        start = datetime.strptime(month, "%Y-%m").date().replace(day=1)
    except ValueError:
        return validation_error("Use YYYY-MM.")
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    with connection() as con:
        rows = con.execute("SELECT log_date, SUM(hours) hours, COUNT(*) count FROM tasks WHERE log_date >= ? AND log_date < ? GROUP BY log_date",
                           (start.isoformat(), end.isoformat())).fetchall()
    values = [(date.fromisoformat(r["log_date"]), float(r["hours"]), r["count"]) for r in rows]
    # longest run within the selected month
    run = best = 0; prev = None
    for dt, _, _ in values:
        run = run + 1 if prev and dt == prev + timedelta(days=1) else 1; best = max(best, run); prev = dt
    best_day = max(values, key=lambda x: x[1], default=None)
    return jsonify({"month": start.strftime("%B %Y"), "hours": round(sum(x[1] for x in values), 2),
                    "tasks": sum(x[2] for x in values), "average": round(sum(x[1] for x in values)/len(values), 2) if values else 0,
                    "best_day": best_day[0].isoformat() if best_day else None, "longest_streak": best})


def all_data(con: sqlite3.Connection) -> list[dict]:
    logs = con.execute("SELECT * FROM daily_logs ORDER BY log_date").fetchall()
    return [day_payload(con, row["log_date"]) for row in logs]


@app.get("/export/<format>")
def export(format: str):
    with connection() as con:
        data = all_data(con)
    if format == "json":
        return Response(json.dumps(data, indent=2), mimetype="application/json", headers={"Content-Disposition": "attachment; filename=progress-tracker.json"})
    flat = [{"Date": d["date"], "Locked": d["locked"], "Reflection": d["reflection"],
             "Task": t.get("name", ""), "Hours": t.get("hours", ""), "Description": t.get("description", "")}
            for d in data for t in (d["tasks"] or [{}])]
    if format == "csv":
        output = io.StringIO(); writer = csv.DictWriter(output, fieldnames=["Date", "Locked", "Reflection", "Task", "Hours", "Description"]); writer.writeheader(); writer.writerows(flat)
        return Response(output.getvalue(), mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=progress-tracker.csv"})
    if format == "xlsx":
        from openpyxl import Workbook
        book = Workbook(); sheet = book.active; sheet.title = "Progress"
        sheet.append(["Date", "Locked", "Reflection", "Task", "Hours", "Description"])
        for row in flat: sheet.append(list(row.values()))
        output = io.BytesIO(); book.save(output); output.seek(0)
        return send_file(output, as_attachment=True, download_name="progress-tracker.xlsx", mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    if format == "pdf":
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
        output = io.BytesIO(); pdf = canvas.Canvas(output, pagesize=letter); width, height = letter; y = height - 48
        pdf.setFont("Helvetica-Bold", 18); pdf.drawString(42, y, "Progress Tracker Export"); y -= 30
        pdf.setFont("Helvetica", 9)
        for row in flat:
            line = f"{row['Date']}  |  {row.get('Task','')}  |  {row.get('Hours','')} hr"
            if y < 42: pdf.showPage(); pdf.setFont("Helvetica", 9); y = height - 42
            pdf.drawString(42, y, line[:120]); y -= 14
        pdf.save(); output.seek(0)
        return send_file(output, as_attachment=True, download_name="progress-tracker.pdf", mimetype="application/pdf")
    return validation_error("Unsupported export format.", 404)


@app.get("/backup")
def backup():
    init_db()
    return send_file(DATABASE, as_attachment=True, download_name=f"progress-tracker-{today().isoformat()}.db")


@app.get("/api/settings/backup")
def get_backup_settings():
    return jsonify({"settings": load_backup_settings(), "status": load_backup_status()})


@app.post("/api/settings/backup")
def update_backup_settings():
    data = request.get_json(silent=True) or {}
    frequency = data.get("frequency", "manual")
    backup_time = str(data.get("time", "03:00"))
    weekday = data.get("weekday", "SUN")
    month_day = data.get("month_day", 1)
    folder = str(data.get("folder", "")).strip()
    if frequency not in {"manual", "daily", "weekly", "monthly"}:
        return validation_error("Choose a valid backup frequency.")
    try:
        datetime.strptime(backup_time, "%H:%M")
    except ValueError:
        return validation_error("Choose a valid backup time.")
    if weekday not in {"MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"}:
        return validation_error("Choose a valid day of the week.")
    try:
        month_day = int(month_day)
    except (TypeError, ValueError):
        return validation_error("Choose a valid day of the month.")
    if not 1 <= month_day <= 28:
        return validation_error("Choose a day from 1 to 28.")
    if frequency != "manual" and not folder:
        return validation_error("Enter the Google Drive folder for scheduled backups.")
    settings = {"folder": folder, "frequency": frequency, "time": backup_time, "weekday": weekday, "month_day": month_day}
    try:
        configure_windows_backup_schedule(settings)
        save_json(BACKUP_SETTINGS_FILE, settings)
        if frequency == "manual":
            backup_status("ready" if folder else "not_configured", message="Ready for a manual backup." if folder else "Choose a Google Drive folder to begin.")
        else:
            backup_status("scheduled", message=f"{frequency.title()} backup scheduled for {backup_time}.")
    except RuntimeError as error:
        return validation_error(str(error), 500)
    return jsonify({"settings": settings, "status": load_backup_status()})


@app.post("/api/settings/backup/run")
def run_backup_now():
    try:
        return jsonify(run_google_drive_backup())
    except (OSError, ValueError, sqlite3.Error) as error:
        return validation_error(f"Backup failed: {error}", 500)


@app.post("/restore")
def restore():
    upload = request.files.get("backup")
    if not upload or not upload.filename.lower().endswith(".db"):
        return validation_error("Choose a SQLite .db backup file.")
    temporary = Path(tempfile.mkstemp(suffix=".db")[1])
    try:
        upload.save(temporary)
        check = sqlite3.connect(temporary)
        check.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_logs'").fetchone() or (_ for _ in ()).throw(ValueError())
        check.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").fetchone() or (_ for _ in ()).throw(ValueError())
        check.close(); shutil.copy2(temporary, DATABASE)
    except Exception:
        return validation_error("That file is not a valid Progress Tracker backup.")
    finally:
        temporary.unlink(missing_ok=True)
    return jsonify({"ok": True})


if __name__ == "__main__":
    if "--run-scheduled-backup" in sys.argv:
        try:
            run_google_drive_backup()
        except Exception:
            sys.exit(1)
        sys.exit(0)
    init_db()
    app.run(debug=True, host="127.0.0.1", port=5000)

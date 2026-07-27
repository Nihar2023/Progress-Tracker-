from __future__ import annotations

import csv
import io
import json
import os
import shutil
import sqlite3
import tempfile
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, Response, jsonify, render_template, request, send_file

BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.getenv("DATABASE_PATH", str(BASE_DIR / "progress_tracker.db"))).expanduser()
TIMEZONE = ZoneInfo(os.getenv("TRACKER_TIMEZONE", "Asia/Kolkata"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


def today() -> date:
    return datetime.now(TIMEZONE).date()


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
        """)


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
        "locked": bool(log["locked"]) if log else log_date < today().isoformat(),
        "total_hours": round(sum(task["hours"] for task in tasks), 2),
        "tasks": [dict(task) for task in tasks],
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


@app.get("/")
def index():
    return render_template("index.html", today=today().isoformat(), timezone=str(TIMEZONE))


@app.get("/api/heatmap")
def heatmap():
    requested_year = request.args.get("year", type=int) or today().year
    if not 2000 <= requested_year <= today().year:
        return validation_error("Choose a valid year.")
    start = date(requested_year, 1, 1)
    end = min(date(requested_year, 12, 31), today())
    with connection() as con:
        rows = con.execute("""
            SELECT d.log_date, COALESCE(SUM(t.hours), 0) AS hours
            FROM daily_logs d LEFT JOIN tasks t ON d.log_date = t.log_date
            WHERE d.log_date BETWEEN ? AND ? GROUP BY d.log_date
        """, (start.isoformat(), end.isoformat())).fetchall()
        available = [row["year"] for row in con.execute("""
            SELECT DISTINCT substr(log_date, 1, 4) AS year FROM daily_logs
            UNION SELECT ? AS year ORDER BY year DESC
        """, (str(today().year),)).fetchall()]
    totals = {row["log_date"]: round(row["hours"], 2) for row in rows}
    return jsonify({"year": requested_year, "start": start.isoformat(), "end": end.isoformat(),
                    "days": totals, "available_years": available})


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
        hours = float(data.get("hours"))
    except (TypeError, ValueError):
        return validation_error("Hours must be a number.")
    if not name or len(name) > 160:
        return validation_error("Task name is required and must be 160 characters or fewer.")
    if not 0 < hours <= 24:
        return validation_error("Hours must be greater than 0 and no more than 24.")
    if len(description) > 3000:
        return validation_error("Description must be 3,000 characters or fewer.")
    with connection() as con:
        allowed, message = editable(con, today().isoformat())
        if not allowed:
            return validation_error(message, 403)
        con.execute("INSERT INTO tasks (log_date, name, hours, description) VALUES (?, ?, ?, ?)",
                    (today().isoformat(), name, hours, description))
        con.execute("UPDATE daily_logs SET updated_at = CURRENT_TIMESTAMP WHERE log_date = ?", (today().isoformat(),))
        return jsonify(day_payload(con, today().isoformat())), 201


@app.put("/api/tasks/<int:task_id>")
def update_task(task_id: int):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    description = str(data.get("description", "")).strip()
    try:
        hours = float(data.get("hours"))
    except (TypeError, ValueError):
        return validation_error("Hours must be a number.")
    if not name or len(name) > 160 or not 0 < hours <= 24 or len(description) > 3000:
        return validation_error("Please provide a valid name, hours (0–24), and description.")
    with connection() as con:
        task = con.execute("SELECT log_date FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not task:
            return validation_error("Task not found.", 404)
        allowed, message = editable(con, task["log_date"])
        if not allowed:
            return validation_error(message, 403)
        con.execute("UPDATE tasks SET name=?, hours=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (name, hours, description, task_id))
        return jsonify(day_payload(con, task["log_date"]))


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
        return jsonify(day_payload(con, task["log_date"]))


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
        return jsonify(day_payload(con, today().isoformat()))


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
    cursor = today()
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


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if len(query) < 2:
        return jsonify([])
    with connection() as con:
        rows = con.execute("SELECT * FROM tasks WHERE name LIKE ? OR description LIKE ? ORDER BY log_date DESC, id DESC LIMIT 100",
                           (f"%{query}%", f"%{query}%")).fetchall()
    return jsonify([dict(r) for r in rows])


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
    init_db()
    app.run(debug=True, host="127.0.0.1", port=5000)

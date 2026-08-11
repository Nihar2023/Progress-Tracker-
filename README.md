# Progress Tracker

A local Flask app for recording today’s work and preserving a locked, authentic history.

## Run it

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5000 in a browser.

The app stores everything locally in `progress_tracker.db`. It uses the `Asia/Kolkata` timezone by default; set `TRACKER_TIMEZONE` to an IANA timezone name before starting the app if needed.

## Locking behaviour

The server locks every record before the current local day on every request. Task and reflection mutation endpoints also only accept today’s record, so the rule is enforced even if someone bypasses the interface. Future dates do not have a write endpoint.

## Automatic Google Drive backups

Install and sign in to **Google Drive for desktop**, then create a folder in
*My Drive*, for example `G:\My Drive\Progress Tracker Backups`. Keep the live
database in this project folder; only backup copies should be in Google Drive.

In the app, open **Settings** (the gear icon), choose **Backup**, enter that
Google Drive folder, select *Manual only*, *Daily*, *Weekly*, or *Monthly*, and
save. The app creates a Windows Task Scheduler task for scheduled backups, so
the website does not need to be open. The computer must be on for a scheduled
backup to run.

Use **Back up now** to create a backup immediately. The Settings screen shows
its status, file name, size, and time. Google Drive for desktop uploads the
created `.db` file whenever it has an internet connection. To recover data,
download the newest backup from Google Drive and use the app's **Restore**
control.

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

Back up the database from the app before moving or reinstalling the project.

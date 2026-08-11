const $ = selector => document.querySelector(selector);
const today = window.TRACKER_TODAY;
let editing = null;
let timerStart = null;
let timerElapsed = 0;
let timerTick = null;
const TIMER_SETTINGS_KEY = 'progress-timer-settings';
let timerSettings = loadTimerSettings();
let soundPreview = null;
let previewSongId = null;
let previewTimeout = null;
let previewObjectUrl = null;
let alarmAudio = null;
let alarmContext = null;
let alarmTimeout = null;
const progressCharts = new Map();
const progressPanels = new Map();
let analyticsPeriod = 'week';
let analyticsOldestOffset = 0;
let analyticsLoading = false;
document.head.insertAdjacentHTML('beforeend', '<style>.analytics-summary,.analytics-insights{display:none}</style>');
document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/static/backup-theme.css">');

const fmt = hours => {
  const totalMinutes = Math.round(Number(hours || 0) * 60);
  return `${Math.floor(totalMinutes / 60)}.${String(totalMinutes % 60).padStart(2, '0')}`;
};
const fmtDuration = fmt;
const fetchJSON = async (url, options = {}) => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Something went wrong.');
  return data;
};
function toast(text) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2800);
}
function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}
function level(hours) {
  if (!hours) return 0;
  const progress = hours / Math.max(.25, goalHours());
  if (progress < .25) return 1;
  if (progress < .5) return 2;
  if (progress < .75) return 3;
  if (progress < 1) return 4;
  return 5;
}

function renderTasks(day) {
  $('#today-tasks').innerHTML = day.tasks.length ? day.tasks.map(task => `<div class="task"><span class="tick">✓</span><div class="task-main"><div class="task-name">${escapeHtml(task.name)}</div>${task.description ? `<div class="task-note">${escapeHtml(task.description)}</div>` : ''}</div><span class="task-hours">${fmt(task.hours)}</span><button class="mini" onclick="editTask(${task.id})">Edit</button><button class="mini" onclick="deleteTask(${task.id})">×</button></div>`).join('') : '<p class="task-note">No tasks yet. Start with one meaningful thing.</p>';
  $('#reflection').value = day.reflection || '';
}
async function loadToday() { renderTasks(await fetchJSON('/api/day/' + today)); }
async function refreshTodayStat() {
  const day = await fetchJSON('/api/day/' + today);
  const markup = `<div class="stat" id="today-hours-stat"><b>${fmt(day.total_hours)}</b><span>Today's hours</span></div>`;
  const existing = $('#today-hours-stat');
  if (existing) existing.outerHTML = markup;
  else $('#stats').insertAdjacentHTML('afterbegin', markup);
}

async function heatmap(year = $('#heatmap-year').value || today.slice(0, 4)) {
  const data = await fetchJSON('/api/heatmap?year=' + year);
  const element = $('#heatmap');
  const picker = $('#heatmap-year');
  if (!picker.options.length) picker.innerHTML = data.available_years.map(item => `<option value="${item}">${item}</option>`).join('');
  picker.value = data.year;
  element.innerHTML = '';
  let active = 0, hours = 0, streak = 0, maxStreak = 0;
  for (let month = 0; month < 12; month += 1) {
    const block = document.createElement('section');
    const grid = document.createElement('div');
    const first = new Date(data.year, month, 1, 12);
    const days = new Date(data.year, month + 1, 0).getDate();
    block.className = 'month-graph'; grid.className = 'month-grid';
    for (let blank = 0; blank < first.getDay(); blank += 1) grid.insertAdjacentHTML('beforeend', '<i class="day empty"></i>');
    for (let number = 1; number <= days; number += 1) {
      const calendarDate = new Date(data.year, month, number, 12);
      const key = calendarDate.toISOString().slice(0, 10);
      const dayHours = data.days[key] || 0;
      const cell = document.createElement('button');
      cell.className = 'day'; cell.dataset.level = level(dayHours); cell.title = `${key}: ${fmt(dayHours)}`;
      if (key <= data.end) {
        cell.onclick = () => showDay(key); hours += dayHours;
        if (dayHours > 0) { active += 1; streak += 1; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
      } else { cell.classList.add('future'); cell.disabled = true; }
      grid.append(cell);
    }
    block.append(grid, Object.assign(document.createElement('h3'), { textContent: first.toLocaleDateString(undefined, { month: 'short' }) }));
    element.append(block);
  }
  $('#year-hours').textContent = fmt(hours);
  $('#year-title').textContent = data.year;
  $('#year-active').textContent = active;
  $('#year-streak').textContent = maxStreak;
}
async function showDay(logDate) {
  const day = await fetchJSON('/api/day/' + logDate);
  const title = new Date(logDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  $('#day-detail').innerHTML = `<h2 class="day-title">${title}</h2>${day.locked ? '<p class="locked">This record is permanently locked.</p>' : ''}<p class="day-total">${fmt(day.total_hours)}</p><h3>Tasks</h3>${day.tasks.length ? day.tasks.map(task => `<div class="task"><span class="tick">✓</span><div class="task-main"><b>${escapeHtml(task.name)}</b>${task.description ? `<div class="task-note">${escapeHtml(task.description)}</div>` : ''}</div><span class="task-hours">${fmt(task.hours)}</span></div>`).join('') : '<p class="task-note">No work recorded.</p>'}<h3>Reflection</h3><p>${escapeHtml(day.reflection || 'No reflection recorded.')}</p>`;
  $('#day-dialog').showModal();
}
async function stats() {
  const data = await fetchJSON('/api/stats');
  const items = [['Current streak', data.current_streak + ' days'], ['Longest streak', data.longest_streak + ' days'], ['Total hours', fmt(data.total_hours)], ['Average / active day', fmt(data.average_hours)], ['Total tasks', data.total_tasks], ['Most productive day', data.productive_day ? `${data.productive_day.date} · ${fmt(data.productive_day.hours)}` : '—'], ['Most productive month', data.productive_month ? `${data.productive_month.month} · ${fmt(data.productive_month.hours)}` : '—']];
  $('#stats').innerHTML = items.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');
  await refreshTodayStat();
}

$('#task-form').onsubmit = async event => {
  event.preventDefault();
  try {
    let url = '/api/tasks', method = 'POST';
    if (editing) { url += '/' + editing; method = 'PUT'; }
    const day = await fetchJSON(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#task-name').value, minutes: $('#task-minutes').value, description: $('#task-desc').value }) });
    editing = null; event.target.reset(); event.target.querySelector('button').textContent = 'Add task';
    renderTasks(day); heatmap(); stats(); refreshAnalytics(); toast('Saved immediately.');
  } catch (error) { toast(error.message); }
};
window.editTask = async id => {
  const day = await fetchJSON('/api/day/' + today);
  const task = day.tasks.find(item => item.id === id);
  editing = id; $('#task-name').value = task.name; $('#task-minutes').value = task.minutes; $('#task-desc').value = task.description;
  $('#task-form button').textContent = 'Save changes'; $('#task-name').focus();
};
window.deleteTask = async id => {
  if (!confirm('Delete this task?')) return;
  try { renderTasks(await fetchJSON('/api/tasks/' + id, { method: 'DELETE' })); heatmap(); stats(); refreshAnalytics(); toast('Task deleted.'); } catch (error) { toast(error.message); }
};
$('#save-reflection').onclick = async () => {
  try { await fetchJSON('/api/reflection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reflection: $('#reflection').value }) }); $('#reflection-status').textContent = 'Saved immediately.'; } catch (error) { toast(error.message); }
};
let searchWait;
$('#search').oninput = event => {
  clearTimeout(searchWait);
  searchWait = setTimeout(async () => {
    const query = event.target.value.trim(); if (query.length < 2) { $('#results').innerHTML = ''; return; }
    const results = await fetchJSON('/api/search?q=' + encodeURIComponent(query));
    $('#results').innerHTML = results.length ? results.map(item => `<div class="result"><b>${escapeHtml(item.name)}</b> · ${fmt(item.hours)}<br><small>${item.log_date}${item.description ? ' — ' + escapeHtml(item.description) : ''}</small></div>`).join('') : '<p class="task-note">No matching tasks.</p>';
  }, 250);
};
$('#report-month').value = today.slice(0, 7);
$('#report-button').onclick = async () => {
  const report = await fetchJSON('/api/report/' + $('#report-month').value);
  $('#report').innerHTML = [['Hours', fmt(report.hours)], ['Tasks', report.tasks], ['Average', fmt(report.average)], ['Best day', report.best_day || '—'], ['Longest streak', report.longest_streak + ' days']].map(([label, value]) => `<div><b>${value}</b><small>${label}</small></div>`).join('');
};
$('#restore').onchange = async event => {
  if (!event.target.files[0] || !confirm('Restore this backup? Current data will be replaced.')) return;
  const form = new FormData(); form.append('backup', event.target.files[0]);
  try { await fetchJSON('/restore', { method: 'POST', body: form }); toast('Backup restored. Reloading…'); setTimeout(() => location.reload(), 700); } catch (error) { toast(error.message); }
};
function loadTimerSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(TIMER_SETTINGS_KEY) || '{}');
    const songs = Array.isArray(saved.songs) ? saved.songs : (saved.soundData ? [{ id: 'saved-alarm-sound', name: saved.soundName || 'Saved alarm sound', data: saved.soundData }] : []);
    return { songs, selectedSoundId: saved.selectedSoundId || songs[0]?.id || null, countdown: { duration: 3600, remaining: 3600, startedAt: null, running: false }, ...saved, songs, selectedSoundId: saved.selectedSoundId || songs[0]?.id || null, countdown: { duration: 3600, remaining: 3600, startedAt: null, running: false, ...(saved.countdown || {}) } };
  } catch (_) { return { songs: [], selectedSoundId: null, countdown: { duration: 3600, remaining: 3600, startedAt: null, running: false } }; }
}
function saveTimerSettings() { localStorage.setItem(TIMER_SETTINGS_KEY, JSON.stringify(timerSettings)); }
function formatTimer(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
function focusSeconds() { return timerElapsed + (timerStart ? (Date.now() - timerStart) / 1000 : 0); }
function countdownSeconds() {
  const timer = timerSettings.countdown;
  return timer.running && timer.startedAt ? Math.max(0, timer.remaining - (Date.now() - timer.startedAt) / 1000) : timer.remaining;
}
function renderFocusTimer() {
  const seconds = focusSeconds();
  $('#timer-display').textContent = formatTimer(seconds);
  $('#timer-start').disabled = Boolean(timerStart) || seconds > 0;
  $('#timer-start').textContent = seconds > 0 ? 'In progress' : 'Start';
  $('#timer-pause').disabled = !timerStart && seconds === 0;
  $('#timer-pause').textContent = timerStart ? 'Pause' : 'Resume';
  $('#timer-stop').disabled = seconds === 0;
}
function renderCountdownTimer() {
  const seconds = countdownSeconds();
  $('#countdown-display').textContent = formatTimer(seconds);
  $('#countdown-start').disabled = timerSettings.countdown.running || seconds === 0;
  $('#countdown-start').textContent = seconds < timerSettings.countdown.duration && !timerSettings.countdown.running ? 'Resume' : 'Start';
  $('#countdown-pause').disabled = !timerSettings.countdown.running && seconds === timerSettings.countdown.duration;
  $('#countdown-pause').textContent = timerSettings.countdown.running ? 'Pause' : 'Resume';
}
function updateTimer() {
  if (timerStart) renderFocusTimer();
  if (timerSettings.countdown.running) {
    if (countdownSeconds() <= 0) {
      timerSettings.countdown.running = false; timerSettings.countdown.startedAt = null; timerSettings.countdown.remaining = 0; saveTimerSettings(); renderCountdownTimer(); playAlarmSound(); toast('Timer finished.');
    } else renderCountdownTimer();
  }
}
function persistCountdown() {
  if (timerSettings.countdown.running) { timerSettings.countdown.remaining = countdownSeconds(); timerSettings.countdown.startedAt = Date.now(); saveTimerSettings(); }
}
function setCountdownFromInputs() {
  const hours = Math.min(99, Math.max(0, Number($('#countdown-hours').value) || 0));
  const minutes = Math.min(59, Math.max(0, Number($('#countdown-minutes').value) || 0));
  const seconds = Math.min(59, Math.max(0, Number($('#countdown-seconds').value) || 0));
  const total = hours * 3600 + minutes * 60 + seconds;
  timerSettings.countdown = { duration: total, remaining: total, startedAt: null, running: false }; saveTimerSettings(); renderCountdownTimer();
}
function updatePreviewButton(playing) {
  const button = $('#preview-alarm-sound');
  button.textContent = playing ? '❚❚' : '▶';
  button.setAttribute('aria-label', playing ? 'Stop alarm sound preview' : 'Play selected alarm sound');
}
function stopPreview() {
  clearTimeout(previewTimeout); previewTimeout = null;
  if (soundPreview) { soundPreview.pause(); soundPreview.currentTime = 0; soundPreview = null; }
  previewSongId = null;
  if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
  updatePreviewButton(false);
  renderAlarmSetting();
}
function playForThirtySeconds(source, songId = null) {
  stopPreview();
  previewObjectUrl = source.startsWith('blob:') ? source : null;
  const audio = new Audio(source); soundPreview = audio;
  previewSongId = songId;
  audio.play().catch(() => toast('Audio preview could not start.'));
  updatePreviewButton(songId === null);
  renderAlarmSetting();
  previewTimeout = setTimeout(stopPreview, 30000);
  audio.addEventListener('timeupdate', () => { if (audio.currentTime >= 30) stopPreview(); });
  audio.addEventListener('ended', () => { if (soundPreview === audio) stopPreview(); });
}
function setAlarmStopVisible(visible) { $('#countdown-stop-alarm').hidden = !visible; }
function stopAlarmSound() {
  clearTimeout(alarmTimeout); alarmTimeout = null;
  if (alarmAudio) { alarmAudio.pause(); alarmAudio.currentTime = 0; alarmAudio = null; }
  if (alarmContext) { alarmContext.close().catch(() => {}); alarmContext = null; }
  setAlarmStopVisible(false);
}
function playBuiltInAlarm() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext(); alarmContext = context; setAlarmStopVisible(true);
  [523, 659, 784].forEach((frequency, index) => {
    const oscillator = context.createOscillator(); const gain = context.createGain(); const start = context.currentTime + index * .25;
    oscillator.frequency.value = frequency; gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(.18, start + .02); gain.gain.exponentialRampToValueAtTime(.0001, start + .45);
    oscillator.connect(gain).connect(context.destination); oscillator.start(start); oscillator.stop(start + .48);
  });
  alarmTimeout = setTimeout(stopAlarmSound, 1300);
}
function selectedAlarmSong() { return timerSettings.songs.find(song => song.id === timerSettings.selectedSoundId); }
function playAlarmSound() {
  stopAlarmSound();
  const song = selectedAlarmSong();
  if (song) {
    const audio = new Audio(song.data); alarmAudio = audio; setAlarmStopVisible(true);
    audio.play().catch(() => { alarmAudio = null; playBuiltInAlarm(); });
    audio.addEventListener('ended', () => { if (alarmAudio === audio) stopAlarmSound(); });
  } else playBuiltInAlarm();
}
function renderAlarmSetting() {
  const selected = selectedAlarmSong();
  $('#alarm-sound-status').textContent = selected ? 'Alarm sound: ' + selected.name : 'Using the built-in alarm sound.';
  $('#alarm-song-list').innerHTML = timerSettings.songs.length ? timerSettings.songs.map(song => {
    const previewing = previewSongId === song.id && soundPreview;
    const chosen = song.id === timerSettings.selectedSoundId;
    return '<div class="alarm-song' + (chosen ? ' selected' : '') + '"><button class="mini song-preview" type="button" data-song-preview="' + song.id + '" aria-label="' + (previewing ? 'Stop' : 'Preview') + ' ' + escapeHtml(song.name) + '">' + (previewing ? '❚❚' : '▶') + '</button><span>' + escapeHtml(song.name) + '</span><button class="song-select" type="button" data-song-select="' + song.id + '" aria-label="' + (chosen ? 'Selected alarm sound' : 'Set as alarm sound') + '" aria-pressed="' + chosen + '">' + (chosen ? '■' : '□') + '</button></div>';
  }).join('') : '<p class="empty-sounds">Add MP3 or WAV files to build your sound library.</p>';
}

function formatBackupSize(bytes) {
  if (!Number.isFinite(Number(bytes))) return '';
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function installBackupSettings() {
  const dialog = $('#settings-dialog');
  const close = dialog.querySelector('.close');
  const title = $('#settings-title');
  const alarmPanel = document.createElement('section');
  alarmPanel.className = 'settings-panel'; alarmPanel.dataset.settingsPanel = 'alarm';
  [...dialog.children].filter(element => element !== close && element !== title).forEach(element => alarmPanel.append(element));
  const tabs = document.createElement('div');
  tabs.className = 'settings-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Settings sections');
  tabs.innerHTML = '<button class="settings-tab active" type="button" data-settings-tab="alarm" role="tab" aria-selected="true">Alarm</button><button class="settings-tab" type="button" data-settings-tab="backup" role="tab" aria-selected="false">Backup</button>';
  const days = Array.from({ length: 28 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join('');
  const backupPanel = document.createElement('section');
  backupPanel.className = 'settings-panel'; backupPanel.dataset.settingsPanel = 'backup'; backupPanel.hidden = true;
  backupPanel.innerHTML = `<div class="backup-hero"><div class="backup-cloud-icon" aria-hidden="true">↑</div><h3>Auto Backup</h3><p>Keep a safe copy of your progress in a Google Drive folder.</p></div><form id="backup-settings-form"><section class="backup-group"><h3>Backup Folder Path</h3><label class="sr-only" for="backup-folder">Google Drive backup folder</label><div class="backup-path-input"><span aria-hidden="true">▣</span><input id="backup-folder" type="text" placeholder="G:\\My Drive\\Progress Tracker Backups" autocomplete="off"></div><p class="field-hint">Choose a folder inside Google Drive for desktop where backups will be saved.</p></section><section class="backup-group"><h3>Backup Frequency</h3><input id="backup-frequency" type="hidden" value="manual"><div class="backup-frequency-options" role="radiogroup" aria-label="Backup frequency"><button type="button" data-backup-frequency="daily" role="radio" aria-checked="false">Daily</button><button type="button" data-backup-frequency="weekly" role="radio" aria-checked="false">Weekly</button><button type="button" data-backup-frequency="monthly" role="radio" aria-checked="false">Monthly</button></div><div class="backup-schedule-choice" id="backup-schedule-choice" hidden><div class="backup-choice-field" id="backup-time-field"><label for="backup-time">Time of day</label><input id="backup-time" type="time" value="03:00"><p class="field-hint">Select the time when the backup should run.</p></div><div class="backup-choice-field" id="backup-weekday-field" hidden><label for="backup-weekday">Day of week</label><select id="backup-weekday"><option value="MON">Monday</option><option value="TUE">Tuesday</option><option value="WED">Wednesday</option><option value="THU">Thursday</option><option value="FRI">Friday</option><option value="SAT">Saturday</option><option value="SUN">Sunday</option></select><p class="field-hint">Select the day when the backup should run each week.</p></div><div class="backup-choice-field" id="backup-month-day-field" hidden><label for="backup-month-day">Date of month</label><select id="backup-month-day">${days}</select><p class="field-hint">Select a date from 1 to 28 for your monthly backup.</p></div></div><p class="field-hint backup-frequency-hint" id="backup-frequency-hint">Choose how often you want automatic backups.</p></section><section class="backup-actions"><div><h3>Save Auto Backup Settings</h3><p>Save your backup schedule settings.</p></div><button class="primary" type="submit" id="save-backup-settings">Save Schedule</button></section></form><section class="backup-actions backup-now-action"><div><h3>Back Up Now</h3><p>Create a backup immediately.</p></div><button class="ghost backup-now" type="button" id="backup-now">Back Up Now</button></section><div class="backup-status-card" id="backup-status" aria-live="polite"><strong>Backup not configured</strong><span>Choose a Google Drive folder to begin.</span></div><div class="backup-safe-note"><span aria-hidden="true">◈</span><div><strong>Your data is safe</strong><p>Your backups can be restored whenever you need them.</p></div></div>`;
  title.textContent = 'Settings'; title.after(tabs); tabs.after(alarmPanel); alarmPanel.after(backupPanel);
  tabs.onclick = event => {
    const button = event.target.closest('[data-settings-tab]'); if (!button) return;
    document.querySelectorAll('[data-settings-tab]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
    document.querySelectorAll('[data-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== button.dataset.settingsTab; });
    title.textContent = button.dataset.settingsTab === 'backup' ? 'Backup' : 'Alarm settings';
  };
  document.querySelectorAll('[data-backup-frequency]').forEach(button => button.onclick = () => { $('#backup-frequency').value = button.dataset.backupFrequency; updateBackupScheduleFields(); });
  $('#backup-settings-form').onsubmit = saveBackupSettings;
  $('#backup-now').onclick = runBackupNow;
}
function updateBackupScheduleFields() {
  const frequency = $('#backup-frequency').value;
  $('#backup-schedule-choice').hidden = !['daily', 'weekly', 'monthly'].includes(frequency);
  $('#backup-time-field').hidden = frequency !== 'daily';
  $('#backup-weekday-field').hidden = frequency !== 'weekly';
  $('#backup-month-day-field').hidden = frequency !== 'monthly';
  document.querySelectorAll('[data-backup-frequency]').forEach(button => { const active = button.dataset.backupFrequency === frequency; button.classList.toggle('active', active); button.setAttribute('aria-checked', String(active)); });
  $('#backup-frequency-hint').hidden = frequency !== 'manual';
}
function renderBackupStatus(status = {}) {
  const card = $('#backup-status');
  const labels = { not_configured: 'Backup not configured', ready: 'Manual backup ready', scheduled: 'Automatic backup scheduled', uploading: 'Preparing backup…', complete: 'Backup complete', failed: 'Backup failed' };
  card.dataset.state = status.state || 'not_configured';
  const size = formatBackupSize(status.size_bytes);
  const when = status.updated_at ? new Date(status.updated_at).toLocaleString() : '';
  const details = [status.message, status.file_name, size, when].filter(Boolean).join(' · ');
  card.innerHTML = `<strong>${labels[status.state] || 'Backup status'}</strong><span>${escapeHtml(details || 'Choose a Google Drive folder to begin.')}</span>`;
}
function renderBackupSettings(data) {
  const settings = data.settings || {};
  $('#backup-folder').value = settings.folder || '';
  $('#backup-frequency').value = settings.frequency || 'manual';
  $('#backup-time').value = settings.time || '03:00';
  $('#backup-weekday').value = settings.weekday || 'SUN';
  $('#backup-month-day').value = String(settings.month_day || 1);
  updateBackupScheduleFields(); renderBackupStatus(data.status);
}
async function loadBackupSettings() {
  try { renderBackupSettings(await fetchJSON('/api/settings/backup')); }
  catch (error) { renderBackupStatus({ state: 'failed', message: error.message }); }
}
async function saveBackupSettings(event) {
  event.preventDefault();
  const button = $('#save-backup-settings'); button.disabled = true;
  try {
    const data = await fetchJSON('/api/settings/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: $('#backup-folder').value.trim(), frequency: $('#backup-frequency').value, time: $('#backup-time').value, weekday: $('#backup-weekday').value, month_day: $('#backup-month-day').value }) });
    renderBackupSettings(data); toast(data.settings.frequency === 'manual' ? 'Automatic backup is off. You can still back up now.' : 'Backup schedule saved.');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
}
async function runBackupNow() {
  const button = $('#backup-now'); button.disabled = true;
  renderBackupStatus({ state: 'uploading', message: 'Saving your backup to the Google Drive folder…' });
  try { renderBackupStatus(await fetchJSON('/api/settings/backup/run', { method: 'POST' })); toast('Backup created successfully.'); }
  catch (error) { renderBackupStatus({ state: 'failed', message: error.message }); toast(error.message); }
  finally { button.disabled = false; }
}
installBackupSettings();

$('#timer-open').onclick = () => { $('#timer-dialog').showModal(); renderFocusTimer(); renderCountdownTimer(); };
$('#settings-open').onclick = async () => { $('#settings-dialog').showModal(); renderAlarmSetting(); await loadBackupSettings(); };
document.querySelectorAll('[data-timer-mode]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-timer-mode]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
  $('#focus-timer-panel').hidden = button.dataset.timerMode !== 'focus'; $('#countdown-timer-panel').hidden = button.dataset.timerMode !== 'countdown'; $('#timer-title').textContent = button.textContent;
});
$('#timer-start').onclick = () => { if (!$('#timer-name').value.trim()) return toast('Name the task first.'); timerStart = Date.now(); renderFocusTimer(); };
$('#timer-pause').onclick = () => { if (timerStart) { timerElapsed = focusSeconds(); timerStart = null; } else { timerStart = Date.now(); } renderFocusTimer(); };
$('#timer-stop').onclick = () => { const seconds = focusSeconds(); if (!seconds) return; $('#task-name').value = $('#timer-name').value; $('#task-minutes').value = Math.max(1, Math.round(seconds / 60)); $('#task-desc').value = `Timer: ${formatTimer(seconds)}`; timerStart = null; timerElapsed = 0; renderFocusTimer(); $('#timer-dialog').close(); toast('Timer duration added to the form. Save it when ready.'); };
['hours', 'minutes', 'seconds'].forEach(unit => $(`#countdown-${unit}`).onchange = setCountdownFromInputs);
$('#countdown-start').onclick = () => { if (!countdownSeconds()) return toast('Set a time first.'); timerSettings.countdown.running = true; timerSettings.countdown.startedAt = Date.now(); saveTimerSettings(); renderCountdownTimer(); };
$('#countdown-pause').onclick = () => { if (timerSettings.countdown.running) { persistCountdown(); timerSettings.countdown.running = false; timerSettings.countdown.startedAt = null; } else if (timerSettings.countdown.remaining) { timerSettings.countdown.running = true; timerSettings.countdown.startedAt = Date.now(); } saveTimerSettings(); renderCountdownTimer(); };
$('#countdown-reset').onclick = setCountdownFromInputs;
$('#alarm-sound-file').onchange = event => { stopPreview(); const file = event.target.files[0]; const valid = file && /\.(mp3|wav)$/i.test(file.name); $('#preview-alarm-sound').disabled = !valid; $('#save-alarm-sound').disabled = !valid; if (file && !valid) toast('Choose an MP3 or WAV audio file.'); };
$('#preview-alarm-sound').onclick = () => { if (soundPreview) return stopPreview(); const file = $('#alarm-sound-file').files[0]; if (file) playForThirtySeconds(URL.createObjectURL(file)); };
$('#save-alarm-sound').onclick = () => { const file = $('#alarm-sound-file').files[0]; if (!file) return; if (file.size > 3500000) return toast('Choose an audio file smaller than 3.5 MB.'); const reader = new FileReader(); reader.onload = () => { const song = { id: 'sound-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), name: file.name, data: reader.result }; timerSettings.songs.push(song); timerSettings.selectedSoundId = song.id; try { saveTimerSettings(); } catch (_) { timerSettings.songs.pop(); timerSettings.selectedSoundId = timerSettings.songs[0]?.id || null; return toast('There is not enough browser storage for this sound.'); } $('#alarm-sound-file').value = ''; $('#preview-alarm-sound').disabled = true; $('#save-alarm-sound').disabled = true; renderAlarmSetting(); toast('Sound added and selected for the alarm.'); }; reader.readAsDataURL(file); };
$('#alarm-song-list').onclick = event => { const preview = event.target.closest('[data-song-preview]'); const select = event.target.closest('[data-song-select]'); if (preview) { const song = timerSettings.songs.find(item => item.id === preview.dataset.songPreview); if (!song) return; if (previewSongId === song.id && soundPreview) stopPreview(); else playForThirtySeconds(song.data, song.id); } if (select) { timerSettings.selectedSoundId = select.dataset.songSelect; saveTimerSettings(); renderAlarmSetting(); toast('Alarm sound selected.'); } };
$('#countdown-stop-alarm').onclick = stopAlarmSound;
$('#settings-dialog').addEventListener('close', stopPreview);
$('#timer-dialog').addEventListener('close', () => { if (timerStart) { timerElapsed = focusSeconds(); timerStart = null; } persistCountdown(); });
timerTick = setInterval(updateTimer, 250);
$('#countdown-hours').value = Math.floor(timerSettings.countdown.duration / 3600); $('#countdown-minutes').value = Math.floor(timerSettings.countdown.duration % 3600 / 60); $('#countdown-seconds').value = timerSettings.countdown.duration % 60;

function goalHours() { const saved = Number(localStorage.getItem('progress-daily-goal') || 6); return saved > 24 ? saved / 60 : saved; }
function intensity(hours, goal) {
  if (!hours) return '#3d3d3d';
  if (hours >= goal) return '#36b37e';
  const alpha = Math.min(.95, .38 + hours / Math.max(goal, 1) * .55);
  return `rgba(255, 161, 22, ${alpha})`;
}
function movingAverage(points) {
  return points.map((point, index) => {
    const nearby = points.slice(Math.max(0, index - 2), index + 1).filter(item => !item.is_future);
    return nearby.length ? +(nearby.reduce((sum, item) => sum + item.hours, 0) / nearby.length).toFixed(2) : null;
  });
}
function tooltipLabel(point) {
  const date = new Date(point.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [date, `Worked: ${fmtDuration(point.hours)}`, `Sessions: ${point.sessions}`, `Average session: ${fmtDuration(point.average_session)}`, `Tasks completed: ${point.sessions}`];
}
function progressChart(panel, data) {
  const canvas = panel.querySelector('canvas');
  const existing = progressCharts.get(data.offset);
  if (existing) existing.destroy();
  const goal = goalHours();
  const labels = data.points.map(point => data.period === 'week' ? [point.label, point.secondary] : point.label);
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Logged hours', data: data.points.map(point => point.hours), backgroundColor: context => intensity(data.points[context.dataIndex].hours, goal), hoverBackgroundColor: '#ffba4c', borderRadius: 7, borderSkipped: false, maxBarThickness: data.period === 'year' ? 42 : 26 },
      { type: 'line', label: 'Moving average', data: movingAverage(data.points), borderColor: '#7ee787', borderWidth: 2, pointRadius: 0, tension: .38, fill: false }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 480 }, interaction: { intersect: true, mode: 'index' },
      onClick: (_, active) => { if (!active.length) return; const point = data.points[active[0].index]; if (!point.is_future && data.period !== 'year') showDay(point.date); },
      plugins: {
        legend: { display: false },
        tooltip: { displayColors: false, backgroundColor: '#161616', titleColor: '#fff', bodyColor: '#dedede', padding: 12, callbacks: { title: items => tooltipLabel(data.points[items[0].dataIndex])[0], label: item => tooltipLabel(data.points[item.dataIndex]).slice(1) } }
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: '#b8b8b8', maxRotation: 0, autoSkip: data.period === 'month', font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: '#3a3a3a' }, border: { display: false }, ticks: { color: '#a9a9a9', callback: value => fmt(value) } }
      }
    },
    plugins: data.period === 'year' ? [] : [{
      id: 'goalLine', afterDraw: chartInstance => {
        const scale = chartInstance.scales.y; if (goal > scale.max) return;
        const y = scale.getPixelForValue(goal), context = chartInstance.ctx;
        context.save(); context.setLineDash([5, 5]); context.strokeStyle = '#ffca75'; context.lineWidth = 1;
        context.beginPath(); context.moveTo(chartInstance.chartArea.left, y); context.lineTo(chartInstance.chartArea.right, y); context.stroke();
        context.fillStyle = '#ffca75'; context.font = '11px system-ui'; context.fillText(`Goal ${goal}h`, chartInstance.chartArea.left + 6, y - 6); context.restore();
      }
    }]
  });
  progressCharts.set(data.offset, chart);
}
function card(label, value, detail = '') { return `<article class="analytics-stat"><span>${label}</span><strong>${value}</strong>${detail ? `<small>${detail}</small>` : ''}</article>`; }
function updateAnalyticsSummary(data) {
  if (!$('#analytics-summary')) return;
  const insight = data.insights;
  const longest = insight.longest_day ? `${fmt(insight.longest_day.hours)}` : '—';
  const bestWeek = insight.best_week ? fmt(insight.best_week.hours) : '—';
  const bestMonth = insight.best_month ? fmt(insight.best_month.hours) : '—';
  $('#analytics-summary').innerHTML = [
    card('Total hours', fmt(data.total_hours), comparisonText(data.comparison)),
    card('Average / day', fmt(data.average_hours), `${data.total_sessions} sessions`),
    card('Longest study day', longest, insight.longest_day?.date || 'No sessions yet'),
    card('Current streak', `${insight.current_streak} days`, 'Consecutive active days'),
    card('Best week', bestWeek, insight.best_week?.date || 'No history yet'),
    card('Best month', bestMonth, insight.best_month?.month || 'No history yet'),
    card('Productive days', data.active_periods, `of ${data.active_periods + data.inactive_periods} available`),
    card('Inactive days', data.inactive_periods, 'No logged hours')
  ].join('');
  $('#analytics-insights').innerHTML = `<span class="insight-pill">${insight.productive_weekday ? `Peak day: ${insight.productive_weekday}` : 'Peak day: —'}</span><span class="insight-pill">Avg session: ${fmtDuration(data.average_session)}</span><span class="insight-pill">Longest session: ${fmtDuration(insight.longest_session)}</span>${[50, 100, 250, 500].map(amount => `<span class="achievement-pill ${insight.achievements.includes(amount) ? 'earned' : ''}">${insight.achievements.includes(amount) ? '✓' : '○'} ${amount}h</span>`).join('')}`;
}
function comparisonText(comparison) {
  if (comparison.percent === null) return 'No previous period to compare';
  return `${comparison.percent >= 0 ? '↑' : '↓'} ${Math.abs(comparison.percent)}% vs previous period`;
}
function makePanel(data) {
  const panel = document.createElement('article');
  panel.className = 'analytics-panel'; panel.dataset.offset = data.offset;
  const noHours = !data.points.some(point => point.hours > 0);
  panel.innerHTML = `<div class="period-heading"><div><span class="period-kicker">${data.offset === 0 ? 'CURRENT PERIOD' : 'HISTORICAL PERIOD'}</span><h3>${data.title}</h3></div><span class="period-total">${fmt(data.total_hours)}</span></div><div class="panel-chart ${noHours ? 'panel-empty' : ''}">${noHours ? '<div class="empty-analytics"><span aria-hidden="true">◔</span><strong>No tracked hours yet</strong><p>Start tracking your first session.</p></div>' : '<canvas aria-label="Interactive logged-hours chart"></canvas>'}</div><p class="chart-hint">Hover for details · Select a bar to view that day</p>`;
  if (!noHours) progressChart(panel, data);
  progressPanels.set(data.offset, { panel, data });
  return panel;
}
async function fetchProgress(offset) { return fetchJSON(`/api/progress?period=${analyticsPeriod}&offset=${offset}`); }
async function addOlderPanel() {
  if (analyticsLoading) return;
  const current = progressPanels.get(analyticsOldestOffset);
  if (current && !current.data.has_more) return;
  analyticsLoading = true;
  try {
    const nextOffset = analyticsOldestOffset + 1;
    const data = await fetchProgress(nextOffset);
    const strip = $('#analytics-strip');
    const before = strip.scrollWidth;
    strip.insertBefore(makePanel(data), strip.firstChild);
    analyticsOldestOffset = nextOffset;
    strip.scrollLeft += strip.scrollWidth - before;
  } catch (error) { toast(error.message); } finally { analyticsLoading = false; }
}
async function loadAnalytics(period = analyticsPeriod) {
  analyticsPeriod = period; analyticsOldestOffset = 0; analyticsLoading = true;
  progressCharts.forEach(chart => chart.destroy()); progressCharts.clear(); progressPanels.clear();
  const strip = $('#analytics-strip'); strip.innerHTML = '<div class="analytics-loading" aria-live="polite">Loading analytics…</div>';
  try {
    const current = await fetchProgress(0);
    updateAnalyticsSummary(current); strip.innerHTML = '';
    const preload = [];
    if (current.has_more) preload.push(fetchProgress(1));
    const older = await Promise.all(preload);
    older.reverse().forEach(data => strip.append(makePanel(data)));
    strip.append(makePanel(current));
    analyticsOldestOffset = older.length;
    requestAnimationFrame(() => { strip.scrollLeft = strip.scrollWidth; });
  } catch (error) { strip.innerHTML = `<p class="progress-empty">${escapeHtml(error.message)}</p>`; } finally { analyticsLoading = false; }
}
function refreshAnalytics() { loadAnalytics(analyticsPeriod); }
function mountAnalytics() {
  const anchor = $('#stats');
  anchor.insertAdjacentHTML('afterend', `<section class="card progress-card" aria-labelledby="progress-title"><div class="progress-header"><div><span class="eyebrow">ANALYTICS</span><h2 id="progress-title">Progress overview</h2><p>Real time spent, across every recorded period.</p></div><div class="analytics-actions"><label class="goal-control">Daily goal <input id="daily-goal" type="number" min=".25" max="24" step=".25" aria-label="Daily hours target"></label><button class="ghost export-period" id="export-period">Export CSV</button></div></div><div class="period-control" role="tablist" aria-label="Select analytics period"><button data-period="week" class="active" role="tab" aria-selected="true">Week</button><button data-period="month" role="tab" aria-selected="false">Month</button><button data-period="year" role="tab" aria-selected="false">Year</button></div><section id="analytics-summary" class="analytics-summary" aria-live="polite"></section><div id="analytics-insights" class="analytics-insights" aria-label="Productivity highlights"></div><div class="analytics-scroll-wrap"><div class="scroll-cue">Swipe or scroll left for older periods</div><div id="analytics-strip" class="analytics-strip" tabindex="0" aria-label="Analytics periods, newest on the right"></div></div></section>`);
  $('#daily-goal').value = goalHours();
  $('#analytics-summary').remove(); $('#analytics-insights').remove();
  $('#daily-goal').onchange = event => { const value = Math.min(24, Math.max(.25, Number(event.target.value) || 6)); localStorage.setItem('progress-daily-goal', value); event.target.value = value; heatmap(); refreshAnalytics(); };
  document.querySelectorAll('[data-period]').forEach(button => button.onclick = () => {
    document.querySelectorAll('[data-period]').forEach(item => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-selected', selected); });
    loadAnalytics(button.dataset.period);
  });
  const strip = $('#analytics-strip');
  strip.addEventListener('scroll', () => { if (strip.scrollLeft < 110) addOlderPanel(); }, { passive: true });
  strip.addEventListener('keydown', event => { if (event.key === 'ArrowLeft') strip.scrollBy({ left: -320, behavior: 'smooth' }); if (event.key === 'ArrowRight') strip.scrollBy({ left: 320, behavior: 'smooth' }); });
  $('#export-period').onclick = () => {
    const current = progressPanels.get(0)?.data;
    if (!current) return;
    const rows = [['Date', 'Hours', 'Sessions'], ...current.points.filter(point => !point.is_future).map(point => [point.date, point.hours, point.sessions])];
    const blob = new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv' });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `progress-${analyticsPeriod}-${current.start}.csv` });
    link.click(); URL.revokeObjectURL(link.href);
  };
  loadAnalytics();
}

$('#heatmap-year').onchange = event => heatmap(event.target.value);
$('#today-label').textContent = new Date(today + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
mountAnalytics();
Promise.all([loadToday(), heatmap(), stats()]).catch(error => toast(error.message));

async function stats() {
  const data = await fetchJSON('/api/stats');
  const items = [['Current streak', data.current_streak + ' days'], ['Longest streak', data.longest_streak + ' days'], ['Total hours', fmt(data.total_hours)], ['Average / active day', fmt(data.average_hours)], ['Total tasks', data.total_tasks], ['Most productive day', data.productive_day ? `${data.productive_day.date} · ${fmt(data.productive_day.hours)}` : '—'], ['Most productive month', data.productive_month ? `${data.productive_month.month} · ${fmt(data.productive_month.hours)}` : '—']];
  $('#stats').innerHTML = items.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('');
  await refreshTodayStat();
}

$('#report-button').onclick = async () => {
  const report = await fetchJSON('/api/report/' + $('#report-month').value);
  $('#report').innerHTML = [['Hours', fmt(report.hours)], ['Tasks', report.tasks], ['Average', fmt(report.average)], ['Best day', report.best_day || '—'], ['Longest streak', report.longest_streak + ' days']].map(([label, value]) => `<div><b>${value}</b><small>${label}</small></div>`).join('');
};

$('#daily-goal').min = '.25'; $('#daily-goal').max = '24'; $('#daily-goal').step = '.25'; $('#daily-goal').setAttribute('aria-label', 'Daily hours target');
$('#export-period').onclick = () => {
  const current = progressPanels.get(0)?.data;
  if (!current) return;
  const rows = [['Date', 'Hours', 'Sessions'], ...current.points.filter(point => !point.is_future).map(point => [point.date, point.hours, point.sessions])];
  const blob = new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `progress-${analyticsPeriod}-${current.start}.csv` });
  link.click(); URL.revokeObjectURL(link.href);
};

const $ = selector => document.querySelector(selector);
const today = window.TRACKER_TODAY;
let editing = null;
let timerStart = null;
let timerTick = null;
const progressCharts = new Map();
const progressPanels = new Map();
let analyticsPeriod = 'week';
let analyticsOldestOffset = 0;
let analyticsLoading = false;
document.head.insertAdjacentHTML('beforeend', '<style>.analytics-summary,.analytics-insights{display:none}</style>');

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
function updateTimer() {
  if (!timerStart) return;
  const seconds = Math.floor((Date.now() - timerStart) / 1000);
  $('#timer-display').textContent = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
$('#timer-open').onclick = () => $('#timer-dialog').showModal();
$('#timer-start').onclick = () => { if (!$('#timer-name').value.trim()) return toast('Name the task first.'); timerStart = Date.now(); clearInterval(timerTick); timerTick = setInterval(updateTimer, 1000); toast('Timer started.'); };
$('#timer-stop').onclick = () => {
  if (!timerStart) return;
  const minutes = Math.max(1, Math.round((Date.now() - timerStart) / 60000));
  $('#task-name').value = $('#timer-name').value; $('#task-minutes').value = minutes; $('#task-desc').value = `Timer: ${$('#timer-display').textContent}`;
  timerStart = null; clearInterval(timerTick); $('#timer-dialog').close(); toast('Timer duration added to the form. Save it when ready.');
};

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

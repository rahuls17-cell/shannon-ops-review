// Quarter throughput against targets. Pure: prepared finalisation rows and the
// targets file in, a model out - so the counts and the forecast can be checked
// without a browser. Rendering lives in app.js.
(function (root) {
  const DAY = 86400000;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

  // What each measurable target counts. Targets with no entry have no source yet.
  const MEASURES = {
    company: task => task.bench === 'company',
    'computer-nonconnector': task => task.bench === 'computer' && task.type === 'Non-connector',
    connector: task => task.type === 'Connector',
  };
  // The unattributed work a bench target could still turn out to own.
  const UNATTRIBUTED = {
    company: task => task.bench === 'unassigned',
    'computer-nonconnector': task => task.bench === 'unassigned' && task.type === 'Non-connector',
  };

  // One entry per distinct accepted task, dated by its first acceptance: a task
  // re-finalised into a later cohort was still delivered on the earlier day.
  function acceptedTasks(rows) {
    const tasks = new Map();
    for (const row of rows) {
      if (row.outcome !== 'accepted') continue;
      let task = tasks.get(row.name);
      if (!task) {
        task = {name: row.name, date: '', bench: row.bench, type: row.filterType};
        tasks.set(row.name, task);
      }
      if (ISO.test(row.date || '') && (!task.date || row.date < task.date)) task.date = row.date;
      if (!row.duplicate) { task.bench = row.bench; task.type = row.filterType; }
    }
    return [...tasks.values()];
  }

  // Pace is the mean over the last `windowDays` complete days before the scan;
  // the scan day itself is partial, so counting it would drag the pace down.
  function pace(tasks, scanDate, quarterEnd, windowDays) {
    const from = addDays(scanDate, -windowDays);
    const to = addDays(scanDate, -1);
    const recent = tasks.filter(task => task.date >= from && task.date <= to).length;
    const perDay = recent / windowDays;
    const daysLeft = Math.max(0, daysBetween(scanDate, quarterEnd));
    return {delivered: tasks.length, perDay, forecast: Math.round(tasks.length + perDay * daysLeft)};
  }

  function statusOf(target, measured, bestCase) {
    if (!measured) return {key: 'none', label: 'No source yet'};
    if (target.max === 0) {
      return measured.perDay > 0
        ? {key: 'warn', label: `Still arriving, ${measured.perDay.toFixed(1)} a day`}
        : {key: 'ok', label: 'No new volume'};
    }
    if (measured.forecast >= target.min) return {key: 'ok', label: 'On track'};
    if (bestCase && bestCase.forecast >= target.min) return {key: 'depends', label: 'Depends on attribution'};
    return {key: 'warn', label: 'Behind'};
  }

  function buildThroughput(rows, config, scanDate, overrides = {}) {
    const tasks = acceptedTasks(rows);
    const {quarterEnd} = config;
    const windowDays = config.forecastWindowDays || 7;
    const daysLeft = Math.max(0, daysBetween(scanDate, quarterEnd));

    const targets = config.targets.map(base => {
      const edit = overrides[base.id];
      const target = {...base, ...(edit || {}), edited: Boolean(edit)};
      const match = MEASURES[target.measure];
      const pool = UNATTRIBUTED[target.measure];
      const measured = match ? pace(tasks.filter(match), scanDate, quarterEnd, windowDays) : null;
      const bestCase = match && pool ? pace(tasks.filter(task => match(task) || pool(task)), scanDate, quarterEnd, windowDays) : null;
      return {...target, measured, bestCase, status: statusOf(target, measured, bestCase)};
    });

    // Two weeks of delivery behind the scan, projected to quarter end ahead of it.
    const days = Array.from({length: 14}, (_, index) => addDays(scanDate, index - 13));
    const lines = [
      {id: 'company', label: 'Company Bench', match: MEASURES.company, target: 'company'},
      {id: 'computer', label: 'Computer Bench, non-connector', match: MEASURES['computer-nonconnector'], target: 'computer'},
      {id: 'unattributed', label: 'No roster-linked owner', match: task => task.bench === 'unassigned'},
    ].map(line => {
      const own = tasks.filter(line.match);
      const points = days.map(day => ({
        day,
        total: own.filter(task => task.date && task.date <= day).length,
        delta: own.filter(task => task.date === day).length,
      }));
      const {perDay} = pace(own, scanDate, quarterEnd, windowDays);
      const last = points[points.length - 1].total;
      return {id: line.id, label: line.label, target: line.target, points, perDay,
        forecast: Math.round(last + perDay * daysLeft)};
    });

    return {scanDate, quarterEnd, daysLeft, windowDays, days, lines, targets,
      total: tasks.length, undated: tasks.filter(task => !task.date).length};
  }

  root.buildThroughput = buildThroughput;
  if (typeof module !== 'undefined') module.exports = {buildThroughput, acceptedTasks};
})(typeof window === 'undefined' ? globalThis : window);

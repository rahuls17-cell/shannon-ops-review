(function (root) {
  // PRD C6: the daily delta. How the pipeline's composition MOVED on each day -
  // how many tasks reached Accepted, Rejected or Failed - rather than what it
  // holds in total.
  //
  // Deliberately a different story from Throughput, which charts submissions
  // and acceptances split by BENCH. This splits by STATUS. Two dimensions, two
  // charts; charting the same split twice would break the PRD chart rule.
  //
  // Status is the console's, always. The GCS ledger supplies only the DATE a
  // task reached that status, because the console's submittedAt is the
  // submission and older pulls carry no time at all. Where the ledger has no
  // record of the task at that status, the submission date is used instead and
  // the count of those is reported - a date that is a fallback should not be
  // presented as though it were observed.
  const day = value => String(value || '').slice(0, 10);
  const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const nameKey = value => String(value || '').trim().toLowerCase().replace(/^(harbor|obi)\//, '');

  function prepareDelta(pipelineRows, gcs) {
    const rows = Array.isArray(pipelineRows) ? pipelineRows : [];
    if (!rows.length) throw new Error('No pipeline rows to build the daily delta from');

    // Earliest ledger date per (task, status): when it FIRST reached it.
    const reachedAt = new Map();
    for (const record of [...(gcs?.current || []), ...(gcs?.historical || [])]) {
      const key = `${nameKey(record.task || record.taskId)}|${record.status}`;
      const date = day(record.updatedAt);
      if (!record.status || !isDay(date)) continue;
      const seen = reachedAt.get(key);
      if (!seen || date < seen) reachedAt.set(key, date);
    }

    // One event per task, not per row: two names delivering the same content
    // are one piece of work and must not move the line twice.
    const byIdentity = new Map();
    for (const row of rows) {
      const identity = row.identity?.key || `name:${row.key}`;
      const ledgerDate = reachedAt.get(`${row.key}|${row.status}`);
      const date = ledgerDate || day(row.date);
      if (!isDay(date)) continue;
      const event = {date, status: row.status, identity,
                     basis: ledgerDate ? 'ledger' : 'submission'};
      const seen = byIdentity.get(identity);
      // Prefer a ledger-dated event, then the earlier date, so the fold is
      // deterministic rather than dependent on row order.
      if (!seen || (seen.basis !== 'ledger' && event.basis === 'ledger') ||
          (seen.basis === event.basis && event.date < seen.date)) {
        byIdentity.set(identity, event);
      }
    }

    const events = [...byIdentity.values()];
    return {events,
            statuses: [...new Set(events.map(event => event.status))].sort()};
  }

  function filterDelta(prepared, filters) {
    const options = filters || {};
    const invalidDates = Boolean(options.start && options.end && options.start > options.end);
    const events = invalidDates ? [] : prepared.events.filter(event =>
      (!options.start || event.date >= options.start) &&
      (!options.end || event.date <= options.end) &&
      (!options.status || event.status === options.status));

    const days = [...new Set(events.map(event => event.date))].sort();
    const statuses = options.status ? [options.status] : prepared.statuses;
    const series = {};
    for (const status of statuses) series[status] = Object.fromEntries(days.map(d => [d, 0]));
    for (const event of events) {
      if (series[event.status]) series[event.status][event.date] += 1;
    }

    // Busiest day per status, so the page can say what the peak was rather than
    // leaving the reader to eyeball it off the chart.
    const peak = {};
    for (const status of statuses) {
      const entries = Object.entries(series[status]);
      const best = entries.reduce((most, entry) => entry[1] > most[1] ? entry : most, ['', 0]);
      peak[status] = {date: best[0], count: best[1]};
    }

    return {days, statuses, series, invalidDates,
            totals: Object.fromEntries(statuses.map(status =>
              [status, events.filter(event => event.status === status).length])),
            peak,
            tasks: events.length,
            dated: {ledger: events.filter(event => event.basis === 'ledger').length,
                    submission: events.filter(event => event.basis === 'submission').length}};
  }

  root.prepareDelta = prepareDelta;
  root.filterDelta = filterDelta;
  if (typeof module !== 'undefined') module.exports = {prepareDelta, filterDelta};
})(typeof window === 'undefined' ? globalThis : window);

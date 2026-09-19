(function (root) {
  // Daily delta from the GCS-derived truth asset: how many tasks reached each
  // state on each day. Rows are already one per canonical task, so this module
  // only selects and tallies.
  const day = value => String(value || '').slice(0, 10);
  const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value);

  function prepareDelta(model) {
    const rows = model && Array.isArray(model.rows) ? model.rows : null;
    if (!rows) throw new Error('No pipeline truth to build the daily delta from');

    const events = [];
    for (const row of rows) {
      const date = day(row.decided);
      if (!isDay(date)) continue;
      events.push({date, state: row.state || 'unknown', id: row.id,
                   // The chain could not date these from a verdict and inferred
                   // the day. They are counted, and said to be inferred.
                   inferred: Boolean(row.decidedInferred)});
    }
    // Ordered by the published vocabulary so the legend does not reshuffle
    // between loads. It is emitted as {state: count}; an array is accepted too,
    // so a schema tweak degrades to alphabetical rather than throwing.
    const vocabulary = (model.vocabulary && model.vocabulary.finalState) || [];
    const known = Array.isArray(vocabulary) ? vocabulary : Object.keys(vocabulary);
    const present = [...new Set(events.map(event => event.state))];
    const states = [...known.filter(state => present.includes(state)),
                    ...present.filter(state => !known.includes(state)).sort()];
    return {events, states, undated: rows.length - events.length};
  }

  function filterDelta(prepared, filters) {
    const options = filters || {};
    const invalidDates = Boolean(options.start && options.end && options.start > options.end);
    const events = invalidDates ? [] : prepared.events.filter(event =>
      (!options.start || event.date >= options.start) &&
      (!options.end || event.date <= options.end) &&
      (!options.state || event.state === options.state));

    const days = [...new Set(events.map(event => event.date))].sort();
    const states = options.state ? [options.state] : prepared.states;
    const series = {};
    for (const state of states) series[state] = Object.fromEntries(days.map(d => [d, 0]));
    for (const event of events) {
      if (series[event.state]) series[event.state][event.date] += 1;
    }

    // The busiest day per state, so the page can name the peak rather than
    // leaving it to be eyeballed off the chart.
    const peak = {};
    for (const state of states) {
      const best = Object.entries(series[state])
        .reduce((most, entry) => entry[1] > most[1] ? entry : most, ['', 0]);
      peak[state] = {date: best[0], count: best[1]};
    }

    return {days, states, series, invalidDates,
            tasks: events.length,
            inferred: events.filter(event => event.inferred).length,
            totals: Object.fromEntries(states.map(state =>
              [state, events.filter(event => event.state === state).length])),
            peak};
  }

  root.prepareDelta = prepareDelta;
  root.filterDelta = filterDelta;
  if (typeof module !== 'undefined') module.exports = {prepareDelta, filterDelta};
})(typeof window === 'undefined' ? globalThis : window);

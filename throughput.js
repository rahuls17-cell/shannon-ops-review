(function (root) {
  // PRD T1/T2. Two stories, deliberately kept apart (PRD chart rule):
  //
  //   mining     -> tasks submitted per day, against the workbook's daily
  //                 commitment. The workbook tab is "New Task Mining Daily
  //                 Plan", so its plan counts SUBMISSIONS, not acceptances.
  //   acceptance -> tasks accepted per day. A different event entirely, and
  //                 charting it against the mining plan would compare two
  //                 things that were never meant to meet.
  //
  // Feeds follow the repo rule. The console is the spine for what was
  // submitted and for connector/non-connector, which it records cleanly. The
  // GCS ledger supplies acceptance TIMING only - its updatedAt carries a full
  // timestamp where the console's submittedAt is date-only - and never a
  // verdict the console did not already give.
  const BENCHES = ['Company', 'Computer', 'Unassigned'];
  const day = value => String(value || '').slice(0, 10);
  const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const nameKey = value => String(value || '').trim().toLowerCase().replace(/^(harbor|obi)\//, '');

  // Company | Computer | Unassigned, from the roster team of the task owner.
  // Unassigned is a real bucket, not a rounding error: 178 roster rows carry no
  // team and some owners are off-roster entirely (PRD C5). Dropping them would
  // stop these totals reconciling against the Pipeline tab.
  function benchOf(email, trainers) {
    const team = trainers.get(String(email || '').toLowerCase())?.team;
    return team === 'Company' ? 'Company'
      : ['Computer A', 'Computer B'].includes(team) ? 'Computer'
      : 'Unassigned';
  }

  const connectorOf = value => {
    const text = String(value || '').toLowerCase();
    if (text.startsWith('connector')) return 'Connector';
    if (text.startsWith('non-connector')) return 'Non-connector';
    return 'Not recorded';
  };

  function prepareThroughput(plan, gcs, consoleLive, roster) {
    if (!consoleLive || !Array.isArray(consoleLive.tasks)) throw new Error('No console pull to build throughput from');
    if (consoleLive.tasks.length !== consoleLive.coverage?.tasks) throw new Error('Console pull is truncated');
    const trainers = new Map((roster || []).map(row => [String(row.email || '').toLowerCase(), row]));

    // The console records connector/non-connector properly; the GCS taskType is
    // a domain (Code, Health, Law...), so acceptance borrows the console's label
    // by task name rather than guessing from the name a second time.
    const typeByTask = new Map();
    for (const task of consoleLive.tasks) {
      const key = nameKey(task.name);
      if (!key) continue;
      const label = connectorOf(task.taskType);
      const seen = typeByTask.get(key);
      // 97 names carry BOTH labels, because the normalised name is not a task
      // identity - it collides across families. Letting whichever row came
      // first decide silently mislabels them, so flag the clash instead. Of the
      // accepted tasks this affects 57: none are unambiguously Connector.
      typeByTask.set(key, seen === undefined || seen === label ? label : 'Contested');
    }

    // Mining: one console row per submission, which is what the plan commits to.
    const events = [];
    for (const task of consoleLive.tasks) {
      const date = day(task.submittedAt);
      if (!isDay(date)) continue;
      events.push({date, kind: 'mined', bench: benchOf(task.trainer, trainers),
                   type: connectorOf(task.taskType)});
    }

    // Acceptance: a task is accepted once, however many attempts it took, so
    // collapse to the task and keep the FIRST acceptance. Counting ledger rows
    // instead would double-count retries of the same accepted work.
    const acceptedAt = new Map();
    for (const row of [...(gcs?.current || []), ...(gcs?.historical || [])]) {
      if (row.status !== 'Accepted') continue;
      const key = nameKey(row.task || row.taskId);
      const date = day(row.updatedAt);
      if (!key || !isDay(date)) continue;
      const seen = acceptedAt.get(key);
      if (!seen || date < seen.date) acceptedAt.set(key, {date, trainer: row.trainer});
    }
    for (const [key, hit] of acceptedAt) {
      events.push({date: hit.date, kind: 'accepted', bench: benchOf(hit.trainer, trainers),
                   type: typeByTask.get(key) || 'Not recorded'});
    }

    // The workbook names them "Company Bench" / "Computer Bench".
    const targets = [];
    for (const bench of (plan || [])) {
      const label = String(bench.bench || '').replace(/\s*bench\s*$/i, '').trim();
      (bench.dates || []).forEach((date, index) => {
        const target = Number(bench.plan?.[index]) || 0;
        if (isDay(date) && target) targets.push({date, bench: label, target});
      });
    }

    return {events, plan: targets, benches: BENCHES,
            types: ['Connector', 'Non-connector', 'Contested', 'Not recorded']};
  }

  function filterThroughput(prepared, filters) {
    const options = filters || {};
    const invalidDates = Boolean(options.start && options.end && options.start > options.end);
    const within = date => (!options.start || date >= options.start) && (!options.end || date <= options.end);
    const keep = event => within(event.date) &&
      (!options.bench || event.bench === options.bench) &&
      (!options.type || event.type === options.type);

    const events = invalidDates ? [] : prepared.events.filter(keep);
    // The workbook commitment is per bench per day and is NOT split by
    // connector type, so a type filter has no plan to compare against. Say so
    // rather than drawing a plan line the filter does not actually apply to.
    const planApplies = !options.type;
    const plan = (invalidDates || !planApplies) ? [] : prepared.plan.filter(row =>
      within(row.date) && (!options.bench || row.bench === options.bench));

    const days = [...new Set([...events.map(e => e.date), ...plan.map(p => p.date)])].sort();
    const series = kind => {
      const out = {};
      for (const bench of prepared.benches) out[bench] = Object.fromEntries(days.map(d => [d, 0]));
      for (const event of events) {
        if (event.kind !== kind) continue;
        out[event.bench][event.date] += 1;
      }
      return out;
    };
    const planned = {};
    for (const bench of prepared.benches) planned[bench] = Object.fromEntries(days.map(d => [d, 0]));
    for (const row of plan) {
      if (planned[row.bench]) planned[row.bench][row.date] += row.target;
    }

    const mined = events.filter(e => e.kind === 'mined').length;
    const accepted = events.filter(e => e.kind === 'accepted').length;
    const target = plan.reduce((total, row) => total + row.target, 0);
    return {
      days, invalidDates, planApplies,
      mining: {plan: planned, actual: series('mined')},
      acceptance: {actual: series('accepted')},
      totals: {target, mined, accepted,
               attainment: target ? mined / target : null,
               acceptanceRate: mined ? accepted / mined : null},
      byBench: Object.fromEntries(prepared.benches.map(bench => [bench, {
        mined: events.filter(e => e.kind === 'mined' && e.bench === bench).length,
        accepted: events.filter(e => e.kind === 'accepted' && e.bench === bench).length,
      }])),
      byType: Object.fromEntries(prepared.types.map(type => [type, {
        mined: events.filter(e => e.kind === 'mined' && e.type === type).length,
        accepted: events.filter(e => e.kind === 'accepted' && e.type === type).length,
      }])),
    };
  }

  root.prepareThroughput = prepareThroughput;
  root.filterThroughput = filterThroughput;
  root.THROUGHPUT_BENCHES = BENCHES;
  if (typeof module !== 'undefined') module.exports = {prepareThroughput, filterThroughput, benchOf, connectorOf, BENCHES};
})(typeof window === 'undefined' ? globalThis : window);

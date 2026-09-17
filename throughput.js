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
  // This builds on the rows preparePipeline already produced rather than
  // regrouping the console a second time. That matters: those rows carry the
  // canonical `identity`, so acceptance counts distinct TASKS - including the
  // ones delivered under two different names, which no amount of name matching
  // can see. Nothing here is derived twice.
  const BENCHES = ['Company', 'Computer', 'Unassigned'];
  const BENCH_LABEL = {company: 'Company', computer: 'Computer', unassigned: 'Unassigned'};
  const day = value => String(value || '').slice(0, 10);
  const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const nameKey = value => String(value || '').trim().toLowerCase().replace(/^(harbor|obi)\//, '');

  // The console records connector/non-connector properly; the GCS taskType is a
  // domain (Code, Health, Law), so it is never used for this. 97 task names
  // carry BOTH labels in the console - a normalised name is not a task identity
  // and collides across families - and content fingerprinting does not fix that,
  // because it groups delivered packages rather than splitting a console row.
  // So the clash is reported, not resolved.
  const connectorOf = value => {
    const text = String(value || '').toLowerCase();
    if (text.startsWith('connector')) return 'Connector';
    if (text.startsWith('non-connector')) return 'Non-connector';
    return 'Not recorded';
  };

  // `consoleLive` is optional and is read for ONE thing: how many task names
  // carry conflicting connector labels across their submissions. The type shown
  // for a task is its representative submission's, decided by the same rule that
  // decides its status - but that rule quietly settles 97 disagreements, and a
  // settled disagreement that nobody can see is worse than a visible one.
  function prepareThroughput(plan, gcs, pipelineRows, consoleLive) {
    const rows = Array.isArray(pipelineRows) ? pipelineRows : [];
    if (!rows.length) throw new Error('No pipeline rows to build throughput from');

    const events = [];
    // Mining counts every submission, because that is what the plan commits to.
    // The type is the task's, taken from its representative submission, so a
    // task reads the same here as it does on the Pipeline tab.
    for (const row of rows) {
      const bench = BENCH_LABEL[row.bench] || 'Unassigned';
      const type = connectorOf(row.taskType);
      for (const submission of (row.submissionRows || [])) {
        const date = day(submission.date);
        if (isDay(date)) events.push({date, kind: 'mined', bench, type, identity: row.identity?.key});
      }
    }

    // Acceptance needs a date the console cannot give: its submittedAt is the
    // submission, and older pulls carry no time at all. The GCS ledger's
    // updatedAt is a full timestamp, so it supplies the WHEN - never the
    // whether, which stays the console's to decide.
    const identityOfName = new Map();
    for (const row of rows) {
      if (row.key) identityOfName.set(row.key, row);
    }
    const acceptedAt = new Map();
    for (const record of [...(gcs?.current || []), ...(gcs?.historical || [])]) {
      if (record.status !== 'Accepted') continue;
      const key = nameKey(record.task || record.taskId);
      const date = day(record.updatedAt);
      if (!key || !isDay(date)) continue;
      const row = identityOfName.get(key);
      // Two names delivering identical content collapse here, which is the whole
      // point of the fingerprint: the task was done once.
      const identity = row?.identity?.key || `name:${key}`;
      const seen = acceptedAt.get(identity);
      if (!seen || date < seen.date) {
        acceptedAt.set(identity, {date, bench: BENCH_LABEL[row?.bench] || 'Unassigned',
                                  type: row ? connectorOf(row.taskType) : 'Not recorded'});
      }
    }
    for (const [identity, hit] of acceptedAt) {
      events.push({date: hit.date, kind: 'accepted', bench: hit.bench, type: hit.type, identity});
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

    const labels = new Map();
    for (const task of (consoleLive?.tasks || [])) {
      const key = nameKey(task.name);
      if (!key) continue;
      if (!labels.has(key)) labels.set(key, new Set());
      labels.get(key).add(connectorOf(task.taskType));
    }

    return {events, plan: targets, benches: BENCHES,
            types: ['Connector', 'Non-connector', 'Not recorded'],
            identifiedByContent: rows.filter(row => row.identity?.basis === 'content').length,
            sharedIdentity: rows.filter(row => row.identity?.alsoKnownAs?.length).length,
            typeConflicts: [...labels.values()].filter(set => set.size > 1).length};
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
    const acceptedEvents = events.filter(e => e.kind === 'accepted');
    const target = plan.reduce((total, row) => total + row.target, 0);
    return {
      days, invalidDates, planApplies,
      mining: {plan: planned, actual: series('mined')},
      acceptance: {actual: series('accepted')},
      totals: {target, mined,
               accepted: acceptedEvents.length,
               // Distinct tasks, not events. Equal to `accepted` by construction
               // - acceptance is already one event per identity - and asserted
               // in the tests so a regrouping regression cannot pass silently.
               acceptedTasks: new Set(acceptedEvents.map(e => e.identity)).size,
               minedTasks: new Set(events.filter(e => e.kind === 'mined').map(e => e.identity)).size,
               attainment: target ? mined / target : null,
               acceptanceRate: mined ? acceptedEvents.length / mined : null},
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
  if (typeof module !== 'undefined') module.exports = {prepareThroughput, filterThroughput, connectorOf, BENCHES};
})(typeof window === 'undefined' ? globalThis : window);

(function (root) {
  // PRD F1: Pipeline and Finalisation are the same thing. One view, with the
  // Harbor Console as the spine - it is the source of truth for status - and
  // the GCS evidence hanging off each row as the drill-down:
  //
  //   console  ->  what the task's status IS
  //   ledger   ->  WHY it is that, and how many attempts it took
  //   bucket   ->  what was physically delivered for it
  //
  // Nothing is recomputed from the evidence; where the ledger disagrees with
  // the console the row says so rather than silently preferring one.
  const LEGACY_BEFORE = '2026-09-05';
  const STATUS = {
    accepted: 'Accepted',
    rejected: 'Rejected',
    error: 'Failed',
    running: 'Running',
    queued: 'Queued',
    legacy_accepted: 'Legacy accepted',
  };
  const nameKey = value => String(value || '').trim().toLowerCase().replace(/^(harbor|obi)\//, '');

  // How far a submission actually got. Used only to break ties between
  // submissions with the same timestamp - it never overrides a later one.
  const REACHED = {accepted: 6, legacy_accepted: 5, rejected: 4, error: 3, running: 2, queued: 1};
  const reached = task => REACHED[task.state] || 0;

  // The console sends a full timestamp; older pulls carry only the date because
  // it used to be sliced on the way in. Both are accepted, and `day` is what the
  // date filters compare against.
  const stamp = task => String(task.submittedAt || '');
  const day = task => String(task.date || task.submittedAt || '').slice(0, 10);

  // A task's representative submission is its most recent one. Where two share a
  // timestamp - which every same-day pair does once the time has been sliced off
  // - the one that got further wins. Without this the winner is whichever the
  // console happened to list first, which decided the displayed status of 99
  // tasks, some reading Accepted where the other submission was Rejected.
  function outranks(candidate, holder) {
    if (!holder) return true;
    const [a, b] = [stamp(candidate), stamp(holder)];
    if (a !== b) return a > b;
    return reached(candidate) > reached(holder);
  }

  function preparePipeline(consoleLive, gcs, finalisationRows, roster) {
    if (!consoleLive || !Array.isArray(consoleLive.tasks)) throw new Error('No console pull to build the pipeline from');
    if (consoleLive.tasks.length !== consoleLive.coverage?.tasks) throw new Error('Console pull is truncated');
    const trainers = new Map((roster || []).map(row => [String(row.email || '').toLowerCase(), row]));

    // Evidence indexes, both keyed on the declared task name.
    const cycles = new Map();
    for (const cycle of (gcs?.historical || [])) {
      const key = nameKey(cycle.task || cycle.taskId);
      if (!key) continue;
      if (!cycles.has(key)) cycles.set(key, []);
      cycles.get(key).push(cycle);
    }
    const folders = new Map();
    for (const folder of (finalisationRows || [])) {
      const key = nameKey(folder.name);
      if (!folders.has(key)) folders.set(key, []);
      folders.get(key).push(folder);
    }

    // One row per task; the console lists a row per submission.
    const latest = new Map();
    for (const task of consoleLive.tasks) {
      const key = nameKey(task.name);
      if (!key) continue;
      if (outranks(task, latest.get(key))) latest.set(key, task);
    }

    const submissionsByKey = new Map();
    for (const task of consoleLive.tasks) {
      const key = nameKey(task.name);
      if (!key) continue;
      if (!submissionsByKey.has(key)) submissionsByKey.set(key, []);
      submissionsByKey.get(key).push(task);
    }

    return [...latest.entries()].map(([key, task]) => {
      const submissionRows = submissionsByKey.get(key) || [];
      const attempts = submissionRows.length;
      const evidence = cycles.get(key) || [];
      const delivered = folders.get(key) || [];
      const email = String(task.trainer || '').toLowerCase();
      const trainer = trainers.get(email) || null;
      const team = trainer?.team;
      const status = STATUS[task.state] || (task.state ? task.state[0].toUpperCase() + task.state.slice(1) : 'Unknown');
      const ledgerStatuses = [...new Set(evidence.map(cycle => cycle.status).filter(Boolean))];
      return {
        key,
        name: task.name,
        status,
        state: task.state || '',
        date: day(task),
        legacy: !day(task) || day(task) < LEGACY_BEFORE,
        owner: email || null,
        trainer,
        onRoster: Boolean(trainer),
        bench: team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(team) ? 'computer' : 'unassigned',
        taskType: task.taskType || 'Not recorded',
        failedStage: task.failedStage || '',
        submissions: attempts,
        // Every submission of this task, so the page can reconcile against the
        // console's own counters, which count submissions rather than tasks.
        submissionRows: submissionRows.map(row => ({
          state: row.state || '',
          status: STATUS[row.state] || 'Unknown',
          date: day(row),
        })),
        acceptedFolders: task.acceptedFolders || 0,
        ledger: {
          cycles: evidence.length,
          attempts: evidence.reduce((most, cycle) => Math.max(most, Number(cycle.attempt) || 0), 0),
          statuses: ledgerStatuses,
          // The ledger is evidence, not a second verdict: flag the clash, do not resolve it.
          disagrees: Boolean(ledgerStatuses.length) && !ledgerStatuses.includes(status),
          latest: evidence.slice().sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0] || null,
        },
        bucket: {
          folders: delivered.length,
          cohorts: [...new Set(delivered.map(folder => folder.cohortLabel).filter(Boolean))],
          archives: delivered.reduce((total, folder) => total + (folder.archives || 0), 0),
          domain: delivered.find(folder => folder.filterDomain && folder.filterDomain !== 'Not recorded')?.filterDomain || 'Not recorded',
          connector: delivered.some(folder => folder.is_connector === true),
          sha: delivered[0]?.sha256 || null,
        },
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.name.localeCompare(b.name));
  }

  function filterPipeline(rows, filters) {
    const population = filters.legacy === 'only' ? rows.filter(row => row.legacy)
      : filters.legacy === 'all' ? rows
      : rows.filter(row => !row.legacy);
    const invalidDates = Boolean(filters.start && filters.end && filters.start > filters.end);
    const matched = invalidDates ? [] : population.filter(row => {
      const text = [row.name, row.owner, row.trainer?.name, row.failedStage].join(' ').toLowerCase();
      return (!filters.status || filters.status === row.status) &&
        (!filters.type || filters.type === row.taskType) &&
        (!filters.trainer || filters.trainer === row.owner) &&
        (!filters.bench || filters.bench === row.bench) &&
        (!filters.evidence || (filters.evidence === 'delivered' ? row.bucket.folders > 0
          : filters.evidence === 'undelivered' ? row.bucket.folders === 0
          : filters.evidence === 'disagree' ? row.ledger.disagrees
          : filters.evidence === 'offroster' ? Boolean(row.owner) && !row.onRoster
          : true)) &&
        (!filters.search || text.includes(filters.search.trim().toLowerCase())) &&
        (!(filters.start || filters.end) || (/^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
          (!filters.start || row.date >= filters.start) && (!filters.end || row.date <= filters.end)));
    });
    // The console's own counters count submissions, not tasks. Tally them on the
    // same scope the rows were selected on, so the two can be reconciled.
    const submissionsInScope = matched.flatMap(row => (row.submissionRows || []).map(sub => ({...sub, key: row.key})).filter(sub => {
      const date = String(sub.date || '');
      if (filters.legacy === 'only') return Boolean(date) && date < LEGACY_BEFORE;
      if (filters.legacy !== 'all' && (!date || date < LEGACY_BEFORE)) return false;
      if (filters.start && date < filters.start) return false;
      if (filters.end && date > filters.end) return false;
      return true;
    }));

    return {
      rows: matched,
      population,
      invalidDates,
      statuses: matched.reduce((counts, row) => {
        counts[row.status] = (counts[row.status] || 0) + 1;
        return counts;
      }, {}),
      submissions: submissionsInScope.length,
      // Tasks resubmitted within this scope - the whole of the gap between the
      // two counts. A task's pre-scope history does not make it a repeat here.
      repeatTasks: (() => {
        const perTask = new Map();
        for (const sub of submissionsInScope) perTask.set(sub.key, (perTask.get(sub.key) || 0) + 1);
        return [...perTask.values()].filter(count => count > 1).length;
      })(),
      submissionStatuses: submissionsInScope.reduce((counts, sub) => {
        counts[sub.status] = (counts[sub.status] || 0) + 1;
        return counts;
      }, {}),
      delivered: matched.filter(row => row.bucket.folders > 0).length,
      disagreements: matched.filter(row => row.ledger.disagrees).length,
      offRoster: matched.filter(row => row.owner && !row.onRoster).length,
      unowned: matched.filter(row => !row.owner).length,
    };
  }

  root.preparePipeline = preparePipeline;
  root.filterPipeline = filterPipeline;
  root.PIPELINE_LEGACY_BEFORE = LEGACY_BEFORE;
  if (typeof module !== 'undefined') module.exports = {preparePipeline, filterPipeline, LEGACY_BEFORE};
})(typeof window === 'undefined' ? globalThis : window);

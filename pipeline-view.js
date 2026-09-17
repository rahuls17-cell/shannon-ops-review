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

  // A task's representative submission is its most recent one, by time.
  //
  // Only where two submissions carry the SAME timestamp does anything else
  // decide, and then the one that got further wins. That fallback must never
  // stand in for a missing time: a date-only feed makes every same-day pair look
  // tied, and ranking those by outcome overrides real chronology - measured
  // against the full timestamps it picked the wrong submission every time,
  // promoting an earlier acceptance over the later rejection that followed it.
  // Hence the full timestamps are sourced before this is ever consulted.
  function outranks(candidate, holder) {
    if (!holder) return true;
    const [a, b] = [stamp(candidate), stamp(holder)];
    if (a !== b) return a > b;
    return reached(candidate) > reached(holder);
  }

  // The console pull carries dates only; the rich pull carries the full
  // timestamp for the same submissions. Prefer the rich rows when present, since
  // ordering submissions is the whole job here.
  function submissionSource(consoleLive, consoleRich) {
    const rich = consoleRich?.rows;
    if (Array.isArray(rich) && rich.length) {
      const dated = rich.filter(row => String(row.submittedAt || '').includes('T'));
      if (dated.length) return {rows: rich, timing: 'timestamp'};
    }
    return {rows: consoleLive.tasks, timing: 'date'};
  }

  // Delivered packages indexed by task name, newest first. A name can hold
  // several packages: repeat deliveries of the same task, and genuine later
  // versions of it. The fingerprint tells those two apart - identical content
  // hashes the same however often it is redelivered.
  function deliveredIdentities(fingerprints) {
    const byName = new Map();
    const byFingerprint = new Map();
    for (const row of (fingerprints?.tasks || [])) {
      const key = nameKey(row.folder);
      if (!key || !row.fingerprint) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(row);
      if (!byFingerprint.has(row.fingerprint)) byFingerprint.set(row.fingerprint, new Set());
      byFingerprint.get(row.fingerprint).add(key);
    }
    for (const packages of byName.values()) {
      packages.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    }
    return {byName, byFingerprint};
  }

  // What this task is, as distinct from what it is called. Falls back to the
  // name when nothing was delivered for it - most submitted work never reaches
  // delivery - and says which of the two it used, so no count is reported
  // without being able to state what produced it.
  function identityOf(key, delivered) {
    const packages = delivered.byName.get(key) || [];
    const newest = packages[0] || null;
    const shared = newest ? delivered.byFingerprint.get(newest.fingerprint) : null;
    return {
      key: newest ? newest.fingerprint : 'name:' + key,
      basis: newest ? 'content' : 'name',
      packages: packages.length,
      versions: new Set(packages.map(row => row.fingerprint)).size,
      // Other task names delivering this exact content. Non-empty means the same
      // task was delivered under more than one name, which grouping by name
      // cannot see.
      alsoKnownAs: shared ? [...shared].filter(name => name !== key).sort() : [],
    };
  }

  function preparePipeline(consoleLive, gcs, finalisationRows, roster, fingerprints, consoleRich) {
    if (!consoleLive || !Array.isArray(consoleLive.tasks)) throw new Error('No console pull to build the pipeline from');
    if (consoleLive.tasks.length !== consoleLive.coverage?.tasks) throw new Error('Console pull is truncated');
    const trainers = new Map((roster || []).map(row => [String(row.email || '').toLowerCase(), row]));
    const delivered = deliveredIdentities(fingerprints);
    const source = submissionSource(consoleLive, consoleRich);

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
    for (const task of source.rows) {
      const key = nameKey(task.name);
      if (!key) continue;
      if (outranks(task, latest.get(key))) latest.set(key, task);
    }

    const submissionsByKey = new Map();
    for (const task of source.rows) {
      const key = nameKey(task.name);
      if (!key) continue;
      if (!submissionsByKey.has(key)) submissionsByKey.set(key, []);
      submissionsByKey.get(key).push(task);
    }

    return [...latest.entries()].map(([key, task]) => {
      const submissionRows = submissionsByKey.get(key) || [];
      const attempts = submissionRows.length;
      const evidence = cycles.get(key) || [];
      const deliveredFolders = folders.get(key) || [];
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
        identity: identityOf(key, delivered),
        ledger: {
          cycles: evidence.length,
          attempts: evidence.reduce((most, cycle) => Math.max(most, Number(cycle.attempt) || 0), 0),
          statuses: ledgerStatuses,
          // The ledger is evidence, not a second verdict: flag the clash, do not resolve it.
          disagrees: Boolean(ledgerStatuses.length) && !ledgerStatuses.includes(status),
          latest: evidence.slice().sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0] || null,
        },
        bucket: {
          folders: deliveredFolders.length,
          cohorts: [...new Set(deliveredFolders.map(folder => folder.cohortLabel).filter(Boolean))],
          archives: deliveredFolders.reduce((total, folder) => total + (folder.archives || 0), 0),
          domain: deliveredFolders.find(folder => folder.filterDomain && folder.filterDomain !== 'Not recorded')?.filterDomain || 'Not recorded',
          connector: deliveredFolders.some(folder => folder.is_connector === true),
          sha: deliveredFolders[0]?.sha256 || null,
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
      // Three bases for the same population, reported together so the page can
      // show them side by side rather than picking one and hiding the rest:
      //   submissions - every attempt, which is what the console counts
      //   rows        - one per task name
      //   identities  - one per distinct task, names sharing content folded
      identities: new Set(matched.map(row => row.identity.key)).size,
      identifiedByContent: matched.filter(row => row.identity.basis === 'content').length,
      // Rows whose content is also delivered under another name. Invisible to
      // any amount of name matching.
      sharedIdentity: matched.filter(row => row.identity.alsoKnownAs.length > 0).length,
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

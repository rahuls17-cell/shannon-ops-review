(function (root) {
  // The read model for the GCS-derived pipeline (steps 1-7 on the VM).
  //
  // This module deliberately computes almost nothing. Every state, predicate
  // and tag was decided by the ingest chain and is carried on the row, so the
  // browser and the harness cannot disagree about what a number means. The
  // only work here is selection and tallying.
  //
  // A filter offered by the page must exist in `vocabulary`, which is emitted
  // from the data - so the UI can never offer a value that matches nothing.
  const UNDECIDED = new Set(['error', 'no QC decision', 'queued', 'not started']);

  function prepareTruth(payload, deliveredIndex, connectorIndex, glmIndex) {
    if (!payload || !Array.isArray(payload.tasks)) throw new Error('No pipeline truth asset loaded');
    if (!payload.reconciles) throw new Error('Pipeline truth failed its own reconciliation; refusing to display it');
    const figures = new Map((payload.figures || []).map(f => [f.label, f]));

    // Delivered is the one attribute not decided by the ingest chain, because
    // it depends on a second dataset the chain never sees. The join itself is
    // still done outside the browser - tools/build_delivered_index.py resolves
    // it to pipeline ids - so this is a lookup, not a second implementation.
    const delivered = (deliveredIndex && deliveredIndex.delivered) || null;
    // Ready rows whose identifier names an audited task. The join refuses to
    // call these delivered, because the same rule marks 8 rows wrongly, and a
    // task wrongly marked delivered is never delivered at all. They are carried
    // as a warning so a person decides rather than a heuristic.
    const suspect = (deliveredIndex && deliveredIndex.suspect) || {};
    // Connector status is structural - mcp_servers in task.toml - so it is only
    // known for a task whose package was scanned. The index widens what the
    // chain already set without contradicting it: same scanner, same rule, and
    // the two agree on every task they both cover. A task the index does not
    // reach keeps whatever the chain knew, which is usually nothing.
    const classified = (connectorIndex && connectorIndex.connector) || {};
    const connectorOf = id => {
      const hit = classified[id];
      if (!hit) return {};
      return {connector: hit.isConnector,
              connectorServices: hit.services || [],
              connectorVia: hit.via};
    };
    // The four-trial GLM band. Read from the trial files in the bucket, so a
    // task with no trials recorded has no band rather than a zero - 0/4 is a
    // real and bad result, and must not be what "we did not look" looks like.
    const trials = (glmIndex && glmIndex.glm) || {};
    const glmOf = id => {
      const hit = trials[id];
      if (!hit) return {};
      return {glmPasses: hit.passes, glmTrials: hit.trials, glmRewards: hit.rewards || []};
    };
    const rows = (delivered || connectorIndex || glmIndex)
      ? payload.tasks.map(row => ({
          ...row,
          delivered: Boolean(delivered) && Object.prototype.hasOwnProperty.call(delivered, row.id),
          deliveredVia: (delivered || {})[row.id] || null,
          maybeDelivered: suspect[row.id] || null,
          deliveredTask: ((deliveredIndex || {}).deliveredTask || {})[row.id] || null,
          ...connectorOf(row.id),
          ...glmOf(row.id),
        }))
      : payload.tasks;

    return {
      generatedAt: payload.generatedAt,
      cut: payload.cut,
      bucket: payload.bucket,
      sources: payload.sources || {},
      figures,
      vocabulary: payload.vocabulary || {},
      // The same vocabulary counted in TASKS. The published one counts
      // submissions, so the State dropdown offered "accepted (1,126)" and
      // then showed 998 rows once picked. A filter that disagrees with what
      // it selects is worse than no count at all.
      vocabularyTasks: taskVocabulary(rows),
      glmIndex: glmIndex || null,
      // Null when the index has not loaded, so the page can tell the difference
      // between "nothing is delivered" and "delivery is not known".
      deliveredIndex: deliveredIndex || null,
      connectorIndex: connectorIndex || null,
      // The index resolves to pipeline task ids, so it only describes the
      // pipeline it was built against. A refresh that rebuilt one and not the
      // other has to be visible rather than silently marking the wrong rows.
      deliveredStale: Boolean(deliveredIndex &&
        deliveredIndex.pipelineGeneratedAt !== payload.generatedAt),
      rows,
    };
  }

  // Suffixes the bucket appends that a task's canonical name does not carry.
  // Identical to manifest.js and tools/build_delivered_index.py on purpose.
  const SUFFIX = /(?:-(?:final|v\d+|\d{4,}|copy|new|fixed|updated))+$/;

  function taskKey(row) {
    // The audited task when the row has one: it is the only key that groups the
    // 30 rows recorded under an alias or a placeholder name with their siblings.
    if (row.deliveredTask) return `audit:${String(row.deliveredTask).trim().toLowerCase()}`;
    let name = String(row.name || '').trim().toLowerCase();
    let previous = null;
    while (name !== previous) { previous = name; name = name.replace(SUFFIX, ''); }
    return `name:${name}`;
  }

  // Which of a task's rows is shown. Most recently decided, then the run that
  // got furthest, then the id so the choice cannot depend on row order.
  function preferred(a, b) {
    return (b.decided || '').localeCompare(a.decided || '') ||
      (Number(b.runs) || 0) - (Number(a.runs) || 0) ||
      String(a.id).localeCompare(String(b.id));
  }

  // One row per task instead of one row per submission.
  //
  // The pipeline emits a row per identity, and for the delivered population
  // that over-counts badly: 534 rows stand for 367 tasks, because 152 arrived
  // without a family id and were never merged. Any figure taken off those rows
  // counts the same piece of work several times, so whenever the page is asked
  // a question about DELIVERY it is answered in tasks, not rows.
  //
  // Nothing is discarded: the surviving row carries the others, why it was
  // chosen, and how many there were.
  function collapseByTask(rows) {
    const groups = new Map();
    rows.forEach(row => {
      const key = taskKey(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    const collapsed = [];
    groups.forEach((members, key) => {
      const sorted = [...members].sort(preferred);
      const [shown, ...rest] = sorted;
      collapsed.push(rest.length ? {
        ...shown,
        versionKey: key,
        versions: sorted.length,
        chosenBecause: (rest[0].decided || '') !== (shown.decided || '')
          ? `decided ${shown.decided}, later than the other ${rest.length === 1 ? 'version' : `${rest.length} versions`}`
          : (Number(shown.runs) || 0) !== (Number(rest[0].runs) || 0)
            ? `got furthest at ${shown.runs} run${shown.runs === 1 ? '' : 's'}, tied on decision date`
            : 'tied on date and progress; chosen by identifier so the list cannot reorder itself',
        otherVersions: rest.map(r => ({
          id: r.id, name: r.name, state: r.state, decided: r.decided || null,
          runs: r.runs, unmerged: Boolean(r.unmerged),
        })),
      } : {...shown, versionKey: key, versions: 1, otherVersions: []});
    });
    // Keep the order the rows arrived in, by the position of the shown row.
    const at = new Map(rows.map((r, i) => [r.id, i]));
    return collapsed.sort((a, b) => at.get(a.id) - at.get(b.id));
  }

  // A task is accepted when it HAS an accepted verdict, not when the run that
  // happens to be shown is the accepted one.
  function tasksWhere(rows, predicate) {
    return new Set(rows.filter(predicate).map(taskKey)).size;
  }

  function distinctTasksInState(rows, state) {
    return new Set(rows.filter(row => row.state === state).map(taskKey)).size;
  }

  function countMultiVerdict(rows) {
    const seen = new Map();
    rows.forEach(row => {
      const key = taskKey(row);
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(row.state);
    });
    let many = 0;
    seen.forEach(states => { if (states.size > 1) many += 1; });
    return many;
  }

  // Distinct tasks per value, for every list the page offers as a filter. A
  // task with two verdicts counts once under each, which is why these do not
  // sum to the number of tasks - the same overlap the figures report.
  function taskVocabulary(rows) {
    const fields = {finalState: 'state', gateEra: 'gateEra', domain: 'domain', owner: 'owner'};
    const out = {};
    Object.entries(fields).forEach(([name, field]) => {
      const seen = new Map();
      rows.forEach(row => {
        const value = row[field];
        if (!value) return;
        if (!seen.has(value)) seen.set(value, new Set());
        seen.get(value).add(taskKey(row));
      });
      out[name] = {};
      [...seen.entries()].sort((a, b) => b[1].size - a[1].size)
        .forEach(([value, keys]) => { out[name][value] = keys.size; });
    });
    // Findings are a list per row, so they need their own pass.
    const findings = new Map();
    rows.forEach(row => (row.findings || []).forEach(one => {
      if (!findings.has(one)) findings.set(one, new Set());
      findings.get(one).add(taskKey(row));
    }));
    out.findingFamilies = {};
    [...findings.entries()].sort((a, b) => b[1].size - a[1].size)
      .forEach(([value, keys]) => { out.findingFamilies[value] = keys.size; });
    return out;
  }

  function filterTruth(rows, filters) {
    const f = filters || {};
    const has = (list, value) => !value || (list || []).includes(value);
    const selected = rows.filter(row => {
      const text = [row.name, row.owner, row.why, (row.findings || []).join(' ')]
        .join(' ').toLowerCase();
      return (!f.state || f.state === row.state) &&
        (!f.gateEra || f.gateEra === row.gateEra) &&
        (!f.domain || f.domain === row.domain) &&
        (!f.owner || f.owner === row.owner) &&
        (!f.confidence || f.confidence === row.confidence) &&
        (!f.duplicate || (f.duplicate === 'yes' ? row.possibleDuplicate
          : f.duplicate === 'likely' ? row.duplicateTier === 'likely'
          : f.duplicate === 'no' ? !row.possibleDuplicate
          : true)) &&
        has(row.findingsAllRuns || row.findings, f.finding) &&
        has(row.cohorts, f.cohort) &&
        (!f.delivery || (f.delivery === 'current' ? row.atCurrentBar
          : f.delivery === 'gateOnly' ? row.gateOnly
          : f.delivery === 'none' ? (!row.atCurrentBar && !(row.cohorts || []).length)
          : true)) &&
        (f.carriedOver === undefined || f.carriedOver === null || f.carriedOver === ''
          ? true : Boolean(row.carriedOver) === (f.carriedOver === 'yes')) &&
        (!f.delivered || (f.delivered === 'yes' ? row.delivered === true
          : f.delivered === 'ready' ? (row.delivered !== true && row.atCurrentBar &&
              (row.state === 'accepted' || row.state === 'legacy accepted'))
          : f.delivered === 'no' ? row.delivered !== true
          : true)) &&
        (!f.connector || (f.connector === 'yes' ? row.connector === true
          : f.connector === 'no' ? row.connector === false
          : row.connector === null || row.connector === undefined)) &&
        // The band is a property of the run, so a row with no trials is
        // excluded from every band filter rather than counted as 0.
        (!f.glm || (f.glm === 'none' ? (row.glmPasses === undefined || row.glmPasses === null)
          : row.glmPasses === undefined || row.glmPasses === null ? false
          : f.glm === 'band' ? (row.glmPasses > 0 && row.glmPasses < row.glmTrials)
          : String(row.glmPasses) === f.glm)) &&
        (!f.search || text.includes(f.search.trim().toLowerCase())) &&
        (!f.start || (row.decided || '') >= f.start) &&
        (!f.end || (row.decided || '') <= f.end);
    });

    // Everything below counts TASKS, not submissions.
    //
    // This used to fold only when the Delivered filter was set, which meant the
    // same question got two answers depending on a control that looked
    // unrelated to it: Accepted read 1,126 normally and 998 the moment that
    // filter moved. A person asking "how many accepted tasks are there" wants
    // the second number every time. One task submitted three times is one
    // task, whatever is filtered.
    //
    // The submission counts are kept alongside - `submissions`, `versionsFolded`
    // and the *Rows figures below - because the fold has to be visible and
    // checkable, not silent.
    const collapsed = true;
    const matched = collapseByTask(selected);

    // Accepted and actually collectable. Everything in here has either been
    // delivered or is waiting to be; there is no third thing it can be.
    // Counted twice on purpose: once as tasks, once as the submissions behind
    // them, so the page can say what it folded.
    const collectable = matched.filter(row => row.atCurrentBar &&
      (row.state === 'accepted' || row.state === 'legacy accepted'));
    const collectableRows = selected.filter(row => row.atCurrentBar &&
      (row.state === 'accepted' || row.state === 'legacy accepted'));

    // The three figures on the split strip, as sets of tasks rather than
    // counts of rows. Delivery belongs to the task: one submission of it going
    // out means the task has gone out, so a task with a delivered run and an
    // undelivered one is delivered and not also ready. That is what keeps
    // accepted = delivered + ready true under every filter.
    const atBarKeys = new Set(collectableRows.map(taskKey));
    const deliveredAtBarKeys = new Set(
      collectableRows.filter(row => row.delivered === true).map(taskKey));
    const ready = collectable.filter(row => row.delivered !== true);

    const tally = key => matched.reduce((counts, row) => {
      const value = row[key];
      (Array.isArray(value) ? (value.length ? value : ['(none)']) : [value || '(none)'])
        .forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      return counts;
    }, {});

    return {
      rows: matched,
      population: rows,
      // True when a row stands for a task rather than a submission, so the
      // page can label its own units instead of implying rows are tasks.
      collapsed,
      submissions: selected.length,
      versionsFolded: selected.length - matched.length,
      states: tally('state'),
      gateEras: tally('gateEra'),
      domains: tally('domain'),
      findings: tally('findings'),
      // Distinct TASKS carrying each verdict, counted over the submissions
      // rather than over the folded row. A task rejected on one run and
      // accepted on another really is both, and the fold has to pick one row
      // to show - so counting the folded row's state would make Accepted read
      // 840 unfiltered and 998 the moment you filtered to it. Counting the
      // task instead gives the same answer either way, which is the point.
      //
      // These therefore overlap: 605 tasks carry more than one verdict, so the
      // five figures sum to more than the tasks shown. The page says so.
      accepted: distinctTasksInState(selected, 'accepted'),
      legacyAccepted: distinctTasksInState(selected, 'legacy accepted'),
      rejected: distinctTasksInState(selected, 'rejected'),
      running: distinctTasksInState(selected, 'running'),
      undecided: new Set(selected.filter(row => UNDECIDED.has(row.state)).map(taskKey)).size,
      // How much of that overlap there is, so the page can state it rather
      // than leaving a reader to find the sums do not add up.
      multiVerdictTasks: countMultiVerdict(selected),
      stateRows: {
        accepted: selected.filter(row => row.state === 'accepted').length,
        'legacy accepted': selected.filter(row => row.state === 'legacy accepted').length,
        rejected: selected.filter(row => row.state === 'rejected').length,
        running: selected.filter(row => row.state === 'running').length,
        carriedOver: selected.filter(row => row.carriedOver).length,
      },
      carriedOver: tasksWhere(selected, row => row.carriedOver),
      gateOnly: tasksWhere(selected, row => row.gateOnly),
      atCurrentBar: tasksWhere(selected, row => row.atCurrentBar),
      delivered: tasksWhere(selected, row => row.delivered),
      connectorTasks: tasksWhere(selected, row => row.connector === true),
      nonConnectorTasks: tasksWhere(selected, row => row.connector === false),
      connectorUnknown: tasksWhere(selected,
        row => row.connector === null || row.connector === undefined),
      maybeDelivered: tasksWhere(selected, row => row.maybeDelivered),
      // The submissions behind those, kept so the page and the indexes - which
      // are built per row - can still be reconciled against each other.
      deliveredRows: selected.filter(row => row.delivered).length,
      connectorRows: selected.filter(row => row.connector === true).length,
      nonConnectorRows: selected.filter(row => row.connector === false).length,
      connectorUnknownRows: selected.filter(
        row => row.connector === null || row.connector === undefined).length,
      // "Ready" is deliberately narrow: accepted, its package actually
      // collectable at the current bar, and not already gone out. Counted by
      // distinct name as well as by row, because a task that was submitted
      // twice is still one thing to deliver.
      readyForDelivery: collectableRows.filter(row => row.delivered !== true).length,
      readyNames: new Set(collectableRows.filter(row => row.delivered !== true)
        .map(row => (row.name || '').trim().toLowerCase())).size,
      deliveredNames: new Set(selected.filter(row => row.delivered)
        .map(row => (row.name || '').trim().toLowerCase())).size,
      // Task counts that hold whether or not the Delivered filter folded the
      // rows. The strip above the table asks a question about delivery, and
      // that is answered in tasks however the table happens to be filtered -
      // otherwise the same population reads 574 or 371 depending on a filter
      // that looks unrelated to it.
      deliveredTasks: new Set(matched.filter(row => row.delivered).map(taskKey)).size,
      readyTasks: atBarKeys.size - deliveredAtBarKeys.size,
      // The one population that genuinely partitions: a task accepted with a
      // package collectable at the current bar has either gone out or is
      // waiting to. `ready` is defined as this set minus the delivered ones,
      // so acceptedAtBarTasks = deliveredAtBarTasks + readyTasks holds by
      // construction and cannot drift as either definition changes.
      acceptedAtBarTasks: atBarKeys.size,
      deliveredAtBarTasks: deliveredAtBarKeys.size,
      acceptedAtBarRows: collectableRows.length,
      deliveredAtBarRows: collectableRows.filter(row => row.delivered === true).length,
      unmerged: tasksWhere(selected, row => row.unmerged),
      possibleDuplicates: tasksWhere(selected, row => row.possibleDuplicate),
      likelyDuplicates: tasksWhere(selected, row => row.duplicateTier === 'likely'),
      inferredDates: tasksWhere(selected, row => row.decidedInferred),
      owners: new Set(matched.map(row => row.owner).filter(Boolean)).size,
    };
  }

  // A figure's chain is only honest for the unfiltered population. Once the
  // user narrows the table, the published chain no longer describes what they
  // are looking at, so the page says so rather than showing a stale chain.
  function chainFor(model, label, filtered) {
    const figure = model.figures.get(label);
    if (!figure) return null;
    return {
      label: figure.label,
      value: figure.value,
      note: figure.note || '',
      steps: figure.steps || [],
      stale: Boolean(filtered),
    };
  }

  root.collapseByTask = collapseByTask;
  root.prepareTruth = prepareTruth;
  root.filterTruth = filterTruth;
  root.chainFor = chainFor;
  if (typeof module !== 'undefined') module.exports = {prepareTruth, filterTruth, collapseByTask, chainFor, UNDECIDED};
})(typeof window === 'undefined' ? globalThis : window);

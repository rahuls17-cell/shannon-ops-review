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

  function prepareTruth(payload, deliveredIndex) {
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
    const rows = delivered
      ? payload.tasks.map(row => ({
          ...row,
          delivered: Object.prototype.hasOwnProperty.call(delivered, row.id),
          deliveredVia: delivered[row.id] || null,
          maybeDelivered: suspect[row.id] || null,
          deliveredTask: (deliveredIndex.deliveredTask || {})[row.id] || null,
        }))
      : payload.tasks;

    return {
      generatedAt: payload.generatedAt,
      cut: payload.cut,
      bucket: payload.bucket,
      sources: payload.sources || {},
      figures,
      vocabulary: payload.vocabulary || {},
      // Null when the index has not loaded, so the page can tell the difference
      // between "nothing is delivered" and "delivery is not known".
      deliveredIndex: deliveredIndex || null,
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
        (!f.search || text.includes(f.search.trim().toLowerCase())) &&
        (!f.start || (row.decided || '') >= f.start) &&
        (!f.end || (row.decided || '') <= f.end);
    });

    // Asking about delivery means asking about tasks. Collapse before anything
    // is counted, so every figure below is a task count rather than a row count.
    const collapsed = Boolean(f.delivered);
    const matched = collapsed ? collapseByTask(selected) : selected;

    const ready = matched.filter(row => row.delivered !== true && row.atCurrentBar &&
      (row.state === 'accepted' || row.state === 'legacy accepted'));

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
      findings: tally('findings'),
      accepted: matched.filter(row => row.state === 'accepted').length,
      legacyAccepted: matched.filter(row => row.state === 'legacy accepted').length,
      rejected: matched.filter(row => row.state === 'rejected').length,
      running: matched.filter(row => row.state === 'running').length,
      undecided: matched.filter(row => UNDECIDED.has(row.state)).length,
      carriedOver: matched.filter(row => row.carriedOver).length,
      gateOnly: matched.filter(row => row.gateOnly).length,
      atCurrentBar: matched.filter(row => row.atCurrentBar).length,
      delivered: matched.filter(row => row.delivered).length,
      maybeDelivered: matched.filter(row => row.maybeDelivered).length,
      // "Ready" is deliberately narrow: accepted, its package actually
      // collectable at the current bar, and not already gone out. Counted by
      // distinct name as well as by row, because a task that was submitted
      // twice is still one thing to deliver.
      readyForDelivery: ready.length,
      readyNames: new Set(ready.map(row => (row.name || '').trim().toLowerCase())).size,
      deliveredNames: new Set(matched.filter(row => row.delivered)
        .map(row => (row.name || '').trim().toLowerCase())).size,
      unmerged: matched.filter(row => row.unmerged).length,
      possibleDuplicates: matched.filter(row => row.possibleDuplicate).length,
      likelyDuplicates: matched.filter(row => row.duplicateTier === 'likely').length,
      inferredDates: matched.filter(row => row.decidedInferred).length,
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

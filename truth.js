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

  function prepareTruth(payload) {
    if (!payload || !Array.isArray(payload.tasks)) throw new Error('No pipeline truth asset loaded');
    if (!payload.reconciles) throw new Error('Pipeline truth failed its own reconciliation; refusing to display it');
    const figures = new Map((payload.figures || []).map(f => [f.label, f]));
    return {
      generatedAt: payload.generatedAt,
      cut: payload.cut,
      bucket: payload.bucket,
      sources: payload.sources || {},
      figures,
      vocabulary: payload.vocabulary || {},
      rows: payload.tasks,
    };
  }

  function filterTruth(rows, filters) {
    const f = filters || {};
    const has = (list, value) => !value || (list || []).includes(value);
    const matched = rows.filter(row => {
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
        (!f.connector || (f.connector === 'yes' ? row.connector === true
          : f.connector === 'no' ? row.connector === false
          : row.connector === null || row.connector === undefined)) &&
        (!f.search || text.includes(f.search.trim().toLowerCase())) &&
        (!f.start || (row.decided || '') >= f.start) &&
        (!f.end || (row.decided || '') <= f.end);
    });

    const tally = key => matched.reduce((counts, row) => {
      const value = row[key];
      (Array.isArray(value) ? (value.length ? value : ['(none)']) : [value || '(none)'])
        .forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      return counts;
    }, {});

    return {
      rows: matched,
      population: rows,
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

  root.prepareTruth = prepareTruth;
  root.filterTruth = filterTruth;
  root.chainFor = chainFor;
  if (typeof module !== 'undefined') module.exports = {prepareTruth, filterTruth, chainFor, UNDECIDED};
})(typeof window === 'undefined' ? globalThis : window);

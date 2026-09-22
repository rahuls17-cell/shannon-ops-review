(function (root) {
  // Turns whatever the Pipeline tab is showing into a CSV.
  //
  // The tab already answers most questions, but only one row at a time: the
  // evidence for a task lives behind a drill-down, and the table pages twenty
  // at a time. Anyone who wants to work through a selection - hand it to a
  // trainer, reconcile it against the bucket, sort it a way the page does not -
  // has been reading it off the screen. This writes the whole selection out,
  // every filtered row and not just the page on show, with the drill-down
  // evidence flattened into columns.
  //
  // It exports the rows the page decided on. When the Delivered filter folds
  // repeat versions into one task, the CSV is folded the same way and says so
  // in `versions` and `other_versions`, because a file that quietly disagreed
  // with the figure above it would be worse than no file.

  // Excel and Sheets treat a leading =, +, - or @ as the start of a formula,
  // and this data really does contain names like `-task-51e30c`. Quoting does
  // not help; only the value changes what the spreadsheet does with it. A
  // leading apostrophe is the usual escape and is visible in the cell, so the
  // reader can see the value was guarded rather than silently altered.
  const FORMULA = /^[=+\-@\t\r]/;

  function cell(value) {
    if (value === null || value === undefined) return '';
    let text = Array.isArray(value) ? value.join(' | ') : String(value);
    if (FORMULA.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function yesNo(value) {
    return value === true ? 'yes' : value === false ? 'no' : '';
  }

  // Column order follows the table left to right, then the drill-down top to
  // bottom, so a reader who knows the page knows the file.
  const COLUMNS = [
    ['task_name', row => row.name],
    ['state', row => row.state],
    ['trainer', row => row.owner],
    ['decided', row => row.decided],
    ['decided_is_approximate', row => yesNo(Boolean(row.decidedInferred))],
    ['gate_era', row => row.gateEra],
    ['runs', row => row.runs],
    ['glm_passes', row => (row.glmPasses === undefined || row.glmPasses === null
      ? '' : row.glmPasses)],
    ['glm_trials', row => (row.glmPasses === undefined || row.glmPasses === null
      ? '' : row.glmTrials)],
    ['glm_band', row => (row.glmPasses === undefined || row.glmPasses === null
      ? '' : `${row.glmPasses}/${row.glmTrials}`)],
    ['glm_rewards', row => (row.glmRewards || [])
      .map(v => (v === null ? 'not read' : v))],
    ['at_current_bar', row => yesNo(Boolean(row.atCurrentBar))],
    ['awaiting_regate', row => yesNo(Boolean(row.gateOnly))],
    ['carried_over', row => yesNo(Boolean(row.carriedOver))],
    ['delivered', row => yesNo(row.delivered === true)],
    ['delivered_matched_by', row => row.deliveredVia],
    ['cohorts', row => row.cohorts || []],
    // Blank, not "no": the marker lives inside a package, so a task with no
    // package scanned has no answer rather than a negative one.
    ['connector', row => yesNo(row.connector)],
    ['connector_services', row => row.connectorServices || []],
    ['domain', row => (row.domain && row.domain !== 'Not recorded' ? row.domain : '')],
    ['findings', row => row.findings || []],
    ['findings_on_earlier_run', row => row.findingsPrior || []],
    ['possible_duplicate', row => yesNo(Boolean(row.possibleDuplicate))],
    ['duplicate_siblings', row => (row.possibleDuplicate ? row.duplicateSiblings : '')],
    ['identity', row => (row.unmerged ? 'unmerged: keyed on the submission id'
      : 'keyed by the pipeline family id')],
    ['versions_counted_once', row => row.versions || ''],
    ['other_versions', row => (row.otherVersions || []).map(v => v.id)],
    ['chosen_because', row => row.chosenBecause],
    ['why_this_state', row => row.why],
    ['canonical_run', row => row.canonicalReason],
    ['task_id', row => row.id],
    ['read_from', row => row.source],
  ];

  function truthCsv(rows) {
    const lines = [COLUMNS.map(c => c[0]).join(',')];
    (rows || []).forEach(row => {
      lines.push(COLUMNS.map(([, read]) => cell(read(row))).join(','));
    });
    // CRLF, which is what RFC 4180 asks for and what stops Excel on Windows
    // running the rows together.
    return lines.join('\r\n') + '\r\n';
  }

  root.truthCsv = truthCsv;
  root.csvCell = cell;
  root.CSV_COLUMNS = COLUMNS.map(c => c[0]);
  if (typeof module !== 'undefined') {
    module.exports = {truthCsv, cell, COLUMNS: COLUMNS.map(c => c[0])};
  }
})(typeof window === 'undefined' ? globalThis : window);

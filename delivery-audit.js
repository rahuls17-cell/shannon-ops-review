(function (root) {
  // Read model for the delivery task audit (assets/delivery-audit.json), the
  // dataset the delivery dashboard publishes.
  //
  // This is a DIFFERENT population from the Pipeline tab and must not be read
  // as a second opinion on it:
  //   - 412 audited tasks from batches 1 to 4.1, not the whole bucket
  //   - its acceptance comes from the audit workbook, not from GCS verdicts
  //   - it is a snapshot; the source stamps when its data was built
  // Where the two disagree it is usually because this snapshot is older, so the
  // page shows its build date rather than implying it is current.
  //
  // Same shape as every other module here: prepare, then filter and tally.
  const UNSET = '(not recorded)';
  const value = v => (v === null || v === undefined || v === '' ? UNSET : String(v));

  function prepareDeliveryAudit(payload) {
    if (!payload || !Array.isArray(payload.rows)) throw new Error('No delivery audit asset loaded');
    const rows = payload.rows.map(row => ({
      ...row,
      task: row.task || '',
      // The source writes the literal string 'Unattributed' rather than
      // leaving the field empty, so a truthiness check counts 12 rows as
      // attributed and lists 'Unattributed' as if it were a person.
      trainer: (!row.trainer || String(row.trainer).toLowerCase() === 'unattributed')
        ? null : row.trainer,
      // The source writes the GLM score two ways - a 0-3 integer and an "n/4"
      // bucket. Keep one label so a filter cannot offer both for one thing.
      glmBucket: row.bucket || (row.glm === null || row.glm === undefined ? UNSET : `${row.glm}/4`),
      connectorList: Array.isArray(row.connectors) ? row.connectors : [],
      resolvedFromPipeline: Boolean(row.trainerResolvedFrom),
      pipelineOwners: Array.isArray(row.pipelineOwners) ? row.pipelineOwners : [],
      flags: [
        row.pipelineOwners && row.pipelineOwners.length > 1 ? 'owner still contested' : null,
        row.ambiguous ? 'contested owner' : null,
        row.unverified ? 'unverified' : null,
        row.version_dependent ? 'version dependent' : null,
      ].filter(Boolean),
    }));
    return {
      generatedAt: payload.generatedAt,
      dataGeneratedAt: payload.dataGeneratedAt,
      statusGeneratedAt: payload.statusGeneratedAt,
      statusSource: payload.statusSource,
      source: payload.source,
      summary: payload.summary || {},
      rows,
    };
  }

  function filterDeliveryAudit(rows, filters) {
    const f = filters || {};
    const matched = rows.filter(row => {
      const text = [row.task, row.sha, row.trainer, row.category, row.batch]
        .join(' ').toLowerCase();
      return (!f.batch || f.batch === value(row.batch)) &&
        (!f.category || f.category === value(row.category)) &&
        (!f.type || f.type === value(row.type)) &&
        (!f.difficulty || f.difficulty === value(row.difficulty)) &&
        (!f.glm || f.glm === row.glmBucket) &&
        (!f.acceptance || f.acceptance === value(row.acceptance)) &&
        (!f.priority || f.priority === value(row.priority)) &&
        (!f.trainer || f.trainer === (row.trainer || UNSET)) &&
        (!f.source || f.source === value(row.source)) &&
        (!f.flagged || (f.flagged === 'yes' ? row.flags.length > 0 : row.flags.length === 0)) &&
        (!f.search || text.includes(f.search.trim().toLowerCase()));
    });

    const tally = key => matched.reduce((counts, row) => {
      const v = typeof key === 'function' ? key(row) : value(row[key]);
      counts[v] = (counts[v] || 0) + 1;
      return counts;
    }, {});

    return {
      rows: matched,
      population: rows,
      accepted: matched.filter(r => r.acceptance === 'Accepted').length,
      rejected: matched.filter(r => r.acceptance === 'Rejected').length,
      pending: matched.filter(r => r.acceptance === 'Pending').length,
      connectors: matched.filter(r => r.type === 'Connector').length,
      harder: matched.filter(r => r.difficulty === 'Harder').length,
      attributed: matched.filter(r => r.trainer).length,
      flagged: matched.filter(r => r.flags.length).length,
      resolvedFromPipeline: matched.filter(r => r.resolvedFromPipeline).length,
      trainers: new Set(matched.map(r => r.trainer).filter(Boolean)).size,
      megabytes: matched.reduce((total, r) => total + (Number(r.size_mb) || 0), 0),
      byCategory: tally('category'),
      byGlm: tally(row => row.glmBucket),
      byBatch: tally('batch'),
      byAcceptance: tally('acceptance'),
      byTrainer: tally(row => row.trainer || UNSET),
      byDifficulty: tally('difficulty'),
      byType: tally('type'),
      byPriority: tally('priority'),
      bySource: tally('source'),
    };
  }

  root.prepareDeliveryAudit = prepareDeliveryAudit;
  root.filterDeliveryAudit = filterDeliveryAudit;
  root.DELIVERY_AUDIT_UNSET = UNSET;
  if (typeof module !== 'undefined') {
    module.exports = {prepareDeliveryAudit, filterDeliveryAudit, UNSET};
  }
})(typeof window === 'undefined' ? globalThis : window);

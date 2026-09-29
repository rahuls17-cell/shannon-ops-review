(function (root) {
  // Read model for the Delivery tab: every task handed to the client.
  //
  // Two sources, one row shape:
  //   - assets/delivery-audit.json, the audit of batches 1 to 4.1, which carries
  //     trainer attribution and the audit workbook's accept/reject decisions
  //   - assets/drive-deliveries.json, one row per package in each later batch's
  //     manifest.json on Drive. A manifest names no trainer and records no
  //     decision, so those rows are Unattributed and Pending by construction.
  // A batch the audit covers is never taken from Drive as well, so no task is
  // listed twice.
  //
  // This is a DIFFERENT population from the Pipeline tab and must not be read
  // as a second opinion on it: it is what was delivered, not the whole bucket,
  // and its acceptance comes from the audit workbook, not from GCS verdicts.
  //
  // Same shape as every other module here: prepare, then filter and tally.
  const UNSET = '(not recorded)';
  const value = v => (v === null || v === undefined || v === '' ? UNSET : String(v));

  function prepareDeliveryAudit(payload, drivePayload) {
    if (!payload || !Array.isArray(payload.rows)) throw new Error('No delivery audit asset loaded');
    const audited = new Set(payload.rows.map(row => row.batch));
    const driveRows = (drivePayload && Array.isArray(drivePayload.rows) ? drivePayload.rows : [])
      .filter(row => !audited.has(row.batch))
      .map(row => ({...row, fromManifest: true}));
    const rows = payload.rows.concat(driveRows).map(row => ({
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
      auditedCount: payload.rows.length,
      drive: drivePayload ? {
        generatedAt: drivePayload.generatedAt,
        folder: drivePayload.folder || null,
        batches: drivePayload.batches || [],
        skipped: drivePayload.skipped || [],
        rows: driveRows.length,
      } : null,
      rows,
    };
  }

  function filterDeliveryAudit(rows, filters) {
    const f = filters || {};
    const matched = rows.filter(row => {
      const text = [row.task, row.declaredName, row.sha, row.trainer, row.category, row.batch]
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

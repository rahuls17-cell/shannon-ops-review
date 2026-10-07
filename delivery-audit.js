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

  // The audit and the manifests name the same domains differently - Law and
  // "Non-Connector · Legal", Code and "Non-Connector · Engineering" - so one
  // domain would show as two bars. Both collapse onto the manifest's names here,
  // on this tab only; the row keeps what its source called it.
  const CATEGORY_MERGE = {
    Code: 'Engineering', Law: 'Legal', 'Other/unclassified': 'Other', General: 'Other',
    'Company Bench Zeta': 'CompanyBench',
  };
  function mergedCategory(category) {
    if (category === null || category === undefined || category === '') return category;
    const text = String(category).replace(/^Non-Connector\s*·\s*/i, '');
    return CATEGORY_MERGE[text] || text;
  }

  // A Drive row names no trainer; the owner index, built from the bucket, may.
  // Contested rows keep every candidate and name none of them.
  function withOwner(row, owners) {
    const owner = owners && owners[row.id];
    if (!owner) return row;
    const candidates = Array.isArray(owner.candidates) ? owner.candidates : [];
    return {
      ...row,
      trainer: owner.trainer || 'Unattributed',
      source: owner.source || row.source,
      trainerRoute: owner.route || null,
      ambiguous: candidates.length > 1,
      ownerCandidates: candidates,
    };
  }

  // The ops team's trainer credit sheet (assets/trainer-sheet.json, built by
  // tools/build_trainer_sheet.py) names the trainer of the tasks it covers. A row
  // with no owner, or a contested one, takes the sheet's trainer when the sheet
  // names exactly one person for it. For Company Bench the sheet is the record
  // of who the trainer is, so it also replaces a trainer the bucket names (a
  // re-run by a lead or service account, a second trainer's rework); a Computer
  // Bench trainer the bucket names is kept. The names are matched in the
  // spellings the manifests use - kept identical to build_trainer_sheet.py.
  function sheetVariants(value) {
    let v = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
    if (!v || v === 'none') return [];
    v = v.replace(/^(harbor|obi)\//, '').replace(/\.zip$/, '');
    const out = new Set([v, v.replace(/_/g, '-')]);
    [...out].forEach(x => {
      const y = x.replace(/^task-/, '');
      const z = y.replace(/-[0-9a-f]{6}-v\d+$/, '');
      [y, z, z.replace(/(-v\d+|-fixed|-final)+$/, '')].forEach(n => out.add(n));
      const tracked = z.match(/^\d{6}-(.+)$/);
      if (tracked) out.add(tracked[1]);
    });
    return [...out].filter(x => x.length > 6);
  }
  function trainerSheetKeys(row) {
    const keys = new Set();
    const parts = String(row.sourceUri || '').split('/').filter(Boolean);
    [row.task, row.packageName, row.sourceFolder, String(row.packagePath || '').split('/').pop(),
     parts[parts.length - 1], parts.length > 1 ? parts[parts.length - 2] : null]
      .forEach(value => sheetVariants(value).forEach(k => keys.add(k)));
    [row.packageName, row.sourceFolder].forEach(value => {
      const text = String(value || '').toLowerCase();
      const id = text.match(/^(\d{6})-/) || text.match(/^(astr_\d+|cb\d_\d+)/);
      if (id) keys.add(`tt:${id[1]}`);
    });
    return [...keys];
  }
  function trainerSheetIndex(sheetPayload) {
    if (!sheetPayload || !Array.isArray(sheetPayload.entries)) return null;
    const index = new Map();
    sheetPayload.entries.forEach(entry => (entry.keys || []).forEach(key => {
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(entry.trainer || null);
    }));
    return index;
  }
  function withSheetTrainer(row, index) {
    if (!index) return row;
    const named = Boolean(row.trainer) && String(row.trainer).toLowerCase() !== 'unattributed';
    if (named && row.bench !== 'company') return row;
    const sheetNames = new Set();
    trainerSheetKeys(row).forEach(key => (index.get(key) || []).forEach(person => sheetNames.add(person)));
    const people = [...sheetNames].filter(Boolean);
    if (people.length !== 1) return row;
    if (named && String(row.trainer).toLowerCase() === people[0]) return row;
    return {
      ...row,
      trainer: people[0],
      source: 'Trainer credit sheet',
      trainerRoute: 'sheet',
      ambiguous: false,
      // Who the bucket named before the sheet decided, kept for the drawer:
      // the contested candidates, or the trainer it replaced.
      contestedBefore: named ? [] : row.ownerCandidates || [],
      bucketTrainer: named ? row.trainer : null,
    };
  }

  function prepareDeliveryAudit(payload, drivePayload, ownersPayload, sheetPayload) {
    if (!payload || !Array.isArray(payload.rows)) throw new Error('No delivery audit asset loaded');
    const audited = new Set(payload.rows.map(row => row.batch));
    const owners = ownersPayload && ownersPayload.owners ? ownersPayload.owners : null;
    const sheet = trainerSheetIndex(sheetPayload);
    const driveRows = (drivePayload && Array.isArray(drivePayload.rows) ? drivePayload.rows : [])
      .filter(row => !audited.has(row.batch))
      .map(row => withSheetTrainer(withOwner({...row, fromManifest: true}, owners), sheet));
    // Drive files part of the audited Batches 1 to 4.1 as Company Bench (the
    // 3 Oct layout's "Batch N - CompanyBench" folders). Those audited rows take
    // that bench; every other audited row is the Computer Bench audit it was.
    const nameKey = value => String(value || '').trim().toLowerCase().replace(/^(harbor|obi)\//, '');
    const companyShare = new Map(((drivePayload && drivePayload.auditedCompany) || [])
      .flatMap(entry => [entry.task, entry.packageName].filter(Boolean)
        .map(name => [`${entry.batch}|${nameKey(name)}`, entry])));
    const audit = payload.rows.map(row => {
      const share = companyShare.get(`${row.batch}|${nameKey(row.task)}`);
      return share ? {...row, bench: 'company', driveFolder: share.driveFolder} : row;
    });
    const rows = audit.concat(driveRows).map(row => ({
      ...row,
      task: row.task || '',
      category: mergedCategory(row.category),
      categoryOriginal: row.category,
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
        owners: ownersPayload ? {
          generatedAt: ownersPayload.generatedAt,
          scanGeneratedAt: ownersPayload.scanGeneratedAt,
          attributed: driveRows.filter(r => r.trainer && r.trainer !== 'Unattributed').length,
          contested: driveRows.filter(r => (r.ownerCandidates || []).length > 1 && r.trainerRoute !== 'sheet').length,
        } : null,
        sheet: sheetPayload ? {
          generatedAt: sheetPayload.generatedAt,
          source: sheetPayload.source || null,
          filled: driveRows.filter(r => r.trainerRoute === 'sheet').length,
        } : null,
      } : null,
      rows,
    };
  }

  function filterDeliveryAudit(rows, filters) {
    const f = filters || {};
    const matched = rows.filter(row => {
      const text = [row.task, row.packageName, row.sha, row.trainer, row.category, row.batch]
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

  // A manifest.json for the packages the Delivery tab is showing, in the shape
  // of the batch manifests on Drive (harbor/delivery-manifest/v4): one entry per
  // package, each restated from the batch manifest that listed it, in batch
  // order and then manifest order. Nothing is deduplicated or dropped - a task
  // delivered in two batches was two deliveries, so it is two entries - and no
  // trainer is written, because a delivery manifest never names one.
  function deliveryManifest(rows, options) {
    const o = options || {};
    const order = o.batchOrder || ((a, b) => String(a).localeCompare(String(b)));
    const place = row => Number(String(row.id || '').replace(/^.*-/, '')) || 0;
    const sorted = [...rows].sort((a, b) =>
      order(a.batch || UNSET, b.batch || UNSET) || place(a) - place(b) || String(a.id).localeCompare(String(b.id)));
    const lower = value => (value ? String(value).toLowerCase() : null);
    const tasks = sorted.map((row, i) => {
      const path = row.packagePath || null;
      return {
        position: i + 1,
        task_id: row.packageName || row.task,
        task_name: row.taskName || row.task,
        original_filename: path ? path.split('/').pop() : null,
        package_path: path,
        batch: row.batch || null,
        drive_folder: row.driveFolder || null,
        difficulty: lower(row.difficulty),
        trial_evidence: {model: row.glmModel || null,
                         successes: Number.isInteger(row.glm) ? row.glm : null, runs: 4},
        category: row.category || null,
        connector: row.type === 'Connector',
        connector_services: (row.connectors || []).map(name => ({name})),
        bench_type: row.benchType || null,
        bench: row.bench === 'company' ? 'Company Bench' : 'Computer Bench',
        harness: (o.harnessOf ? o.harnessOf(row) : row.harness) || null,
        bench_class: row.class || null,
        source_uri: row.sourceUri || null,
        source_prefix: row.sourcePrefix || null,
        source_folder: row.sourceFolder || null,
        source_version: row.sourceObject || null,
        sha256: row.sha256 || null,
        size_bytes: Number.isInteger(row.sizeBytes) ? row.sizeBytes : null,
      };
    });
    const tally = read => tasks.reduce((counts, task) => {
      const key = read(task) || UNSET;
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    const batches = [...new Set(tasks.map(t => t.batch || UNSET))];
    const folders = Object.fromEntries((o.batches || []).map(b => [b.batch, String(b.folder || '').split('/').pop()]));
    const driveBatch = batches.map(b => folders[b]).filter(Boolean);
    const stamp = new Date(o.generatedAt || Date.now());
    // India Standard Time, written as the batch manifests write it: 20260930-140429.
    const ist = new Date(stamp.getTime() + 5.5 * 3600 * 1000).toISOString();
    return {
      schema: 'harbor/delivery-manifest/v4',
      generated_at_ist: `${ist.slice(0, 10).replace(/-/g, '')}-${ist.slice(11, 19).replace(/:/g, '')}`,
      source: 'Shannon ops dashboard, Delivery tab: the batch manifests in the Drive "Deliveries" folder' +
              (o.driveGeneratedAt ? `, read ${o.driveGeneratedAt}` : ''),
      batch: o.scope || (batches.length === 1 ? batches[0] : 'All batches'),
      drive_batch: driveBatch.length === 1 ? driveBatch[0] : driveBatch,
      selection: {
        rule: 'every package the Delivery tab shows, one entry per package a batch manifest lists, ' +
              'in batch order and then manifest order',
        segment: o.segment || 'All tasks',
        filters: o.filters || {},
        tasks: tasks.length,
      },
      summary: {
        tasks: tasks.length,
        batches: batches.length,
        by_batch: tally(t => t.batch),
        by_bench: tally(t => t.bench),
        by_class_and_band: tally(t => `${t.bench_class || UNSET} | ${t.difficulty || UNSET}`),
        by_successes: tally(t => (t.trial_evidence.successes === null ? null : String(t.trial_evidence.successes))),
        connector: tasks.filter(t => t.connector).length,
        total_bytes: tasks.reduce((n, t) => n + (t.size_bytes || 0), 0),
        without_checksum: tasks.filter(t => !t.sha256).length,
      },
      tasks,
    };
  }

  root.prepareDeliveryAudit = prepareDeliveryAudit;
  root.deliveryManifest = deliveryManifest;
  root.filterDeliveryAudit = filterDeliveryAudit;
  root.DELIVERY_AUDIT_UNSET = UNSET;
  root.mergedCategory = mergedCategory;
  if (typeof module !== 'undefined') {
    module.exports = {prepareDeliveryAudit, filterDeliveryAudit, mergedCategory, deliveryManifest, trainerSheetKeys, sheetVariants, UNSET};
  }
})(typeof window === 'undefined' ? globalThis : window);

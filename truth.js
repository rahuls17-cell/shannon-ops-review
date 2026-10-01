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

  function prepareTruth(payload, deliveredIndex, connectorIndex, glmIndex, cohortIndex, benchIndex, taskNameIndex) {
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
    // Which bench a task runs on, from the base image in its Dockerfile.
    // Non-connector tasks run on the Computer bench.
    // Which task a folder actually holds, read from the [task] name in its
    // package task.toml. The Accepted list counts folders, because one folder is
    // one delivered package - but the same task is re-cut under a new folder
    // name after a review, and shows up again under a console placeholder, so
    // folders and tasks are not the same number.
    //
    // Nothing else can tell you which. A name rule loose enough to join
    // `gen-g236-...` to `gen-g236-...-review-resolved-20260918-rerun` also joins
    // ASTR_101198 to ASTR_101214, six separate tasks; and no two packages in the
    // prefix are byte-identical, because a re-cut differs, so the object hash
    // finds nothing either. The declared name is read, not inferred.
    const packageTasks = (taskNameIndex && taskNameIndex.task) || {};
    const siblings = {};
    Object.keys(packageTasks).forEach(folder => {
      const task = packageTasks[folder];
      (siblings[task] = siblings[task] || []).push(folder);
    });
    Object.keys(siblings).forEach(task => siblings[task].sort());
    const dupOf = folder => {
      const task = packageTasks[folder];
      const group = task ? siblings[task] : null;
      // Cleared, not left alone: the row this folder matched may carry the
      // name-and-trainer heuristic, which is a claim about two submissions and
      // says nothing about two folders.
      if (!group || group.length < 2) {
        return {packageTask: task || null, possibleDuplicate: false,
                duplicateSiblings: 0, duplicateTier: ''};
      }
      return {packageTask: task, dupFolders: group, duplicateSiblings: group.length - 1,
              possibleDuplicate: true, duplicateTier: 'confirmed',
              duplicateVia: 'the task name declared inside the package'};
    };

    const benches = (benchIndex && benchIndex.bench) || {};
    // The cache has two kinds of key, because it has two sources: the task
    // source tree is keyed by pipeline row id, and a package opened directly is
    // keyed by the bucket folder it sits in. A lookup that tries only the row id
    // silently drops every bench that was read from a package - which is exactly
    // the tasks whose task tree was missing, so the ones that needed it most.
    // benchRead separates "read, and it is a plain image" from "never read".
    const benchAt = (...keys) => {
      let plain = null;
      for (let i = 0; i < keys.length; i += 1) {
        const hit = keys[i] && benches[keys[i]];
        // The cached reading is redone from the image with the current rule, so
        // an index built before a rule change still reads right.
        const bench = hit ? (hit.image ? benchOfImage(hit.image) : hit.bench) : null;
        if (bench) {
          return {bench, benchImage: hit.image, benchRead: true,
                  benchSide: bench.startsWith('company') ? 'company' : 'computer'};
        }
        // An image left as a build variable - ${BASE_IMAGE}:${BASE_TAG} - was
        // never resolved, so it says nothing about the harness either way.
        if (hit && hit.image && !plain && !/\$\{/.test(hit.image)) plain = hit;
      }
      return plain ? {benchImage: plain.image, benchRead: true} : {};
    };

    const trials = (glmIndex && glmIndex.glm) || {};
    const glmOf = id => {
      const hit = trials[id];
      if (!hit) return {};
      return {glmPasses: hit.passes, glmTrials: hit.trials, glmRewards: hit.rewards || []};
    };
    const rows = (delivered || connectorIndex || glmIndex || benchIndex)
      ? payload.tasks.map(row => ({
          ...row,
          delivered: Boolean(delivered) && Object.prototype.hasOwnProperty.call(delivered, row.id),
          deliveredVia: (delivered || {})[row.id] || null,
          maybeDelivered: suspect[row.id] || null,
          deliveredTask: ((deliveredIndex || {}).deliveredTask || {})[row.id] || null,
          ...connectorOf(row.id),
          ...glmOf(row.id),
          ...benchAt(row.id, row.name),
        }))
        .map(onComputerIfNotConnector)
        .map(oneDomain)
        .map(noDomainOnConnector)
      : payload.tasks;

    const cohort = cohortRows(rows, cohortIndex, benchAt, dupOf);
    if (cohort) cohort.forEach((row, index) => { cohort[index] = noDomainOnConnector(oneDomain(onComputerIfNotConnector(row))); });
    carryDuplicateFolders(rows, cohort);

    return {
      generatedAt: payload.generatedAt,
      cut: payload.cut,
      bucket: payload.bucket,
      sources: payload.sources || {},
      figures,
      vocabulary: payload.vocabulary || {},
      glmIndex: glmIndex || null,
      cohortIndex: cohortIndex || null,
      benchIndex: benchIndex || null,
      taskNameIndex: taskNameIndex || null,
      // One row per bucket folder, for the Accepted view.
      //
      // Accepted is decided by the bucket, so its list has to come from the
      // bucket too. Filtering the verdict rows instead gives 1,145 rows that
      // cover only 1,021 folders while missing 104 that hold an accepted
      // package and have no accepted verdict row - a list that is both too
      // long and incomplete at once.
      cohortRows: cohort,
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

  function keyOf(value) {
    let name = String(value || '').trim().toLowerCase();
    for (const prefix of ['harbor/', 'obi/']) {
      if (name.startsWith(prefix)) name = name.slice(prefix.length);
    }
    return name;
  }

  function stemOf(value) {
    let name = keyOf(value), previous = null;
    while (name !== previous) { previous = name; name = name.replace(SUFFIX, ''); }
    return name;
  }

  function taskKey(row) {
    // A bucket folder IS the identity - that is the whole reason the Accepted
    // list comes from the bucket. Two folders whose names normalise alike are
    // still two tasks, and folding them lost three packages from the delivered
    // split: 410 + 712 came to 1,122 rather than 1,125.
    if (row.cohortFolder) return `folder:${String(row.cohortFolder).trim().toLowerCase()}`;
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

  // A task held in several bucket folders is flagged on its verdict rows too,
  // so the DUP badge does not depend on the Accepted list being the one shown.
  function carryDuplicateFolders(rows, cohort) {
    if (!cohort) return;
    const bySpelling = new Map();
    const identity = row => String(row.id || '').replace(/^(task|family|folder):/, '');
    rows.forEach(row => {
      [keyOf(row.name), stemOf(row.name), keyOf(identity(row))].forEach(spelling => {
        if (!spelling) return;
        if (!bySpelling.has(spelling)) bySpelling.set(spelling, new Set());
        bySpelling.get(spelling).add(row);
      });
    });
    cohort.forEach(folderRow => {
      if (!folderRow.dupFolders) return;
      const hits = new Set([...(bySpelling.get(keyOf(folderRow.cohortFolder)) || []),
        ...(bySpelling.get(stemOf(folderRow.cohortFolder)) || []),
        ...(bySpelling.get(keyOf(folderRow.packageTask)) || [])]);
      hits.forEach(row => {
        if (row.dupFolders) return;
        if (!row.packageTask) row.packageTask = folderRow.packageTask;
        row.dupFolders = folderRow.dupFolders;
        row.duplicateSiblings = folderRow.dupFolders.length - 1;
        row.possibleDuplicate = true;
        row.duplicateTier = 'confirmed';
        row.duplicateVia = folderRow.duplicateVia;
      });
    });
  }

  // Each folder gets the verdict row that best describes it, so the table keeps
  // its trainer, dates, GLM band and drill-down. A folder with no verdict row
  // still appears, carrying what the bucket knows and nothing invented.
  // A non-connector task runs on the Computer bench, whatever image its
  // Dockerfile starts from: the image-to-bench rule (tools/read_task_toml.py
  // bench_type) is written for connector tasks, and applied to a non-connector
  // it names a bench the task does not run on - gen-g414 sits on a
  // benchmark-base image and read as Company Bench Zeta. A plain base image
  // (python, node and the like) is the same evidence: no harness, so no
  // connector. Only a task never read is left without a bench.
  // Which bench an image is - tools/read_task_toml.py bench_type, line for
  // line, and tools/test-task-toml.cjs holds the two to the same answers. An
  // Aster image says aster; a Zeta image says zeta, or is one of the image
  // register's Zeta images, which mostly do not: benchmark-base,
  // company-bench-private, and obi-benchmark at the V3 pinned-data digest
  // (obi-benchmark at any other digest is a Computer Bench synthetic image).
  const ZETA_DIGESTS = [
    'ccc08929160ba6a33ba86c070a240f0865c75f83a20b981e6e571998b8b41c83',
    '975f115a995790786a6dbf124204433ccf77460f0277227fbdd21745388e56ca',
    'cb2fee77bd5b1bbe02471664111fae13711c2a0851147f7da987105bf015f293',
    '1e2fbc7a1278c395f1d80d97fa468429854827776b70e84e056789b0f73112c8',
  ];
  function benchOfImage(image) {
    const im = String(image || '').toLowerCase();
    if (!im) return null;
    if (im.includes('aster')) return 'company bench aster';
    if (im.includes('zeta') || ZETA_DIGESTS.some(d => im.includes(d))) return 'company bench zeta';
    if (im.includes('real-data')) return 'computer bench real';
    if (im.includes('connectors-rl-gym')) return 'computer bench synth';
    if (['company-bench-private', 'benchmark-base', 'data-obi-rl-gym'].some(p => im.includes(p))) return 'company bench zeta';
    if (im.includes('connectors-harness')) return 'computer bench synth';
    return null;
  }

  // Connector or not, the one rule the segment switch, the Connector filter
  // and the makeup tiles all use: what the package's task.toml declares, then
  // the type of the Delivery row it went out as, and for a task whose package
  // was never scanned and never delivered, the base image in its
  // Dockerfile - the Company Bench images and the synthetic and real Computer
  // Bench ones are connector harnesses, a plain base image is not. `connector`
  // itself stays the task.toml reading alone.
  function connectorType(row) {
    if (row.connector === true || row.connector === false) return row.connector;
    // Where it was delivered: the Drive folder it sits in says which it is.
    if (row.deliveredType === true || row.deliveredType === false) return row.deliveredType;
    if (/non-connector/.test(row.bench || '')) return false;
    if (/company bench|computer bench (synth|real)/.test(row.bench || '')) return true;
    return null;
  }

  // A domain is the prefix on a non-connector task's name - gen-, law-,
  // code-, health- - and says nothing about a connector task, whose name is
  // free text: code-review-assistant-provenance-attestation is a GitHub
  // connector task, not Engineering. The name's reading is kept apart.
  // Five domains: Engineering, Finance, Health, Legal and Other. A pipeline
  // built before tools/build_tags.py folded them still says General or
  // Business for gen- and bus- tasks; both are Other.
  const DOMAIN_MERGE = {General: 'Other', Business: 'Other'};
  function oneDomain(row) {
    const merged = DOMAIN_MERGE[row.domain];
    return merged ? {...row, domain: merged} : row;
  }

  function noDomainOnConnector(row) {
    if (connectorType(row) !== true || !row.domain || row.domain === 'Not recorded') return row;
    return {...row, domain: 'Not recorded', domainFromName: row.domain};
  }

  function onComputerIfNotConnector(row) {
    if (row.connector === false || (!row.bench && row.benchRead)) {
      return {...row, bench: 'computer bench non-connector', benchSide: 'computer',
              benchFromImage: row.bench && row.bench !== 'computer bench non-connector' ? row.bench : null};
    }
    return row;
  }

  function cohortRows(rows, cohortIndex, benchAt, dupOf) {
    if (!cohortIndex || !cohortIndex.folders) return null;
    const byName = new Map();
    rows.forEach(row => {
      [keyOf(row.name), stemOf(row.name)].forEach(spelling => {
        if (!spelling) return;
        const held = byName.get(spelling);
        if (!held || preferred(row, held) < 0) byName.set(spelling, row);
      });
    });
    const built = Object.values(cohortIndex.folders).map(entry => {
      const match = byName.get(keyOf(entry.folder)) || byName.get(stemOf(entry.folder));
      if (match) {
        return {...match, ...benchAt(entry.folder, match.id, match.name),
                ...dupOf(entry.folder),
                state: 'accepted', atCurrentBar: true,
                connector: entry.connector === undefined ? match.connector : entry.connector,
                connectorServices: entry.connectorServices && entry.connectorServices.length
                  ? entry.connectorServices : (match.connectorServices || []),
                connectorVia: entry.connector === null || entry.connector === undefined
                  ? match.connectorVia : 'the folder’s own package',
                latestVerdict: entry.state || null,
                latestDecided: entry.decided || match.decided,
                delivered: Boolean(entry.delivered), deliveredVia: entry.delivered ? 'delivery manifest' : null,
                cohortFolder: entry.folder, cohortDelivered: entry.delivered,
                cohortState: entry.state || null, cohortStates: entry.states || [],
                cohortPlaceholder: Boolean(entry.placeholderName), fromBucket: true};
      }
      // Nothing in the window describes this folder. Say that rather than
      // borrowing another task's row to fill the columns.
      return {
        id: `folder:${entry.folder}`, name: entry.folder, state: 'accepted',
        latestVerdict: entry.state || null, latestDecided: entry.decided || '',
        why: 'An accepted package in the bucket. No verdict inside the pipeline window describes it.',
        owner: entry.owner || '', decided: entry.decided || '', decidedInferred: false, runs: 0,
        carriedOver: false, atCurrentBar: true, gateOnly: false, gateEra: 'Not recorded',
        domain: 'Not recorded', connector: entry.connector === undefined ? null : entry.connector,
        findings: [], findingsPrior: [],
        cohorts: [cohortIndex.cohort], confidence: 'high', unmerged: false,
        connectorServices: entry.connectorServices || [],
        canonicalReason: 'the bucket folder itself', possibleDuplicate: false,
        duplicateSiblings: 0, duplicateTier: '', source: `${cohortIndex.cohort}/${entry.folder}`,
        delivered: Boolean(entry.delivered), cohortFolder: entry.folder,
        cohortDelivered: entry.delivered, cohortState: entry.state || null,
        cohortStates: entry.states || [], cohortPlaceholder: Boolean(entry.placeholderName),
        fromBucket: true, noVerdict: true, ...benchAt(entry.folder),
        ...dupOf(entry.folder),
      };
    });
    return built.sort((a, b) => {
      const left = a.decided || '', right = b.decided || '';
      if (left && right && left !== right) return left < right ? 1 : -1;
      if (left !== right) return left ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  // Which accepted folders have gone out, over every batch on the Delivery tab.
  //
  // The delivered index answers this for the four manifests it was built from
  // (Batches 1 to 4.1), so without this the split stopped the day Batch 5.1
  // went out. A delivery reaches a folder two ways, both read rather than
  // guessed: the folder its manifest names as the source (7.1, 9.1 and 10.1
  // record one), or a folder whose package declares the same [task] name as the
  // delivered one (every other batch records no folder). The name is compared
  // exactly - never stripped of suffixes - because a loose rule joins separate
  // tasks. A folder the declared name reaches that no manifest names is another
  // copy of a delivered task, a re-cut under a new folder name; it has gone out
  // as a task, so it is not left to deliver, and it is counted apart.
  //
  // Recomputed from what prepareTruth set, so running it again after the
  // Delivery rows change gives the same answer rather than accumulating.
  const typeFlag = type => (type === 'Connector' ? true : type === 'Non-connector' ? false : null);

  function joinDeliveries(prepared, deliveries, missing) {
    if (!prepared) return null;
    const cohort = prepared.cohortRows || [];
    const prefix = prepared.cohortIndex ? prepared.cohortIndex.cohort : null;
    const add = (map, k, v) => { if (k) (map.get(k) || map.set(k, []).get(k)).push(v); };
    const byFolder = new Map(), byName = new Map(), driveByName = new Map();
    (deliveries || []).forEach(d => {
      if (d.sourcePrefix === prefix && d.sourceFolder) add(byFolder, keyOf(d.sourceFolder), d);
      [d.task, d.packageName].forEach(n => {
        add(byName, keyOf(n), d);
        if (!d.audited) add(driveByName, keyOf(n), d);
      });
    });
    const folders = new Map(cohort.map(row => [keyOf(row.cohortFolder), row]));
    const reached = new Map();
    const reach = (d, row) => { if (!reached.has(d)) reached.set(d, row); };
    cohort.forEach(row => {
      if (row.indexDelivered === undefined) row.indexDelivered = Boolean(row.delivered);
      const exact = byFolder.get(keyOf(row.cohortFolder)) || [];
      const named = [...new Set([...(byName.get(keyOf(row.cohortFolder)) || []),
        ...(byName.get(keyOf(row.packageTask)) || [])])];
      exact.concat(named).forEach(d => reach(d, row));
      const by = row.indexDelivered ? 'manifest' : exact.length ? 'folder' : named.length ? 'name' : null;
      const first = exact[0] || named[0] || null;
      row.delivered = Boolean(by);
      row.cohortDelivered = row.delivered;
      row.deliveredBy = by;
      row.deliveredBatch = first ? first.batch : row.deliveredBatch || null;
      row.deliveredVia = by === 'manifest' ? 'delivery manifest'
        : by === 'folder' ? `${first.batch}: the folder its manifest names`
        : by === 'name' ? `${first.batch}: the task its package declares` : null;
      if (by && by !== 'manifest' && !row.deliveredTask) row.deliveredTask = first.task;
      row.deliveredType = first ? typeFlag(first.type) : null;
      Object.assign(row, noDomainOnConnector(row));
    });
    // A pipeline row is a submission, not a folder. It is marked by the Drive
    // batches' declared names only; Batches 1 to 4.1 were joined to these rows
    // by the delivered index, which refused 8 look-alikes that a name would take.
    (prepared.rows || []).forEach(row => {
      if (row.indexDelivered === undefined) {
        row.indexDelivered = Boolean(row.delivered);
        row.indexDeliveredTask = row.deliveredTask || null;
      }
      const hit = row.indexDelivered || row.maybeDelivered ? null
        : (driveByName.get(keyOf(row.name)) || driveByName.get(keyOf(row.packageTask)) || [])[0];
      row.delivered = row.indexDelivered || Boolean(hit);
      row.deliveredTask = hit ? hit.task : row.indexDeliveredTask;
      const sent = hit || (row.indexDeliveredTask ? (byName.get(keyOf(row.indexDeliveredTask)) || [])[0] : null);
      row.deliveredType = sent ? typeFlag(sent.type) : null;
      Object.assign(row, noDomainOnConnector(row));
      if (hit) row.deliveredVia = `${hit.batch}: the task name it carries`;
    });
    const gone = new Set((missing || []).map(m => `${m.batch}|${keyOf(m.task)}`));
    const traced = (deliveries || []).map(d => {
      const folder = reached.get(d) || null;
      let found = Boolean(folder), reason = null;
      if (d.audited) {
        found = !gone.has(`${d.batch}|${keyOf(d.task)}`);
        if (!found) reason = 'gone';
      } else if (!found) {
        reason = d.sourcePrefix === prefix && d.sourceFolder && !folders.has(keyOf(d.sourceFolder)) ? 'gone'
          : d.sourceKind === 'elsewhere' ? 'elsewhere' : 'unnamed';
      }
      return {delivery: d, found, folder: folder ? folder.cohortFolder : null, reason};
    });
    prepared.deliveryJoin = {prefix, traced, deliveries: (deliveries || []).length};
    return prepared.deliveryJoin;
  }

  // The accepted folders folded by the [task] name declared in each package's
  // task.toml. A re-cut after review lands under a new folder name, so several
  // folders can hold one task. A folder whose package could not be read is its
  // own task, because nothing says otherwise. Shown beside the folder count; the
  // Accepted figures themselves stay in folders.
  function acceptedTaskNames(folderRows) {
    const names = new Set();
    (folderRows || []).forEach(row => names.add(row.packageTask
      ? `task:${keyOf(row.packageTask)}` : `folder:${String(row.cohortFolder || row.id).toLowerCase()}`));
    const folders = (folderRows || []).length;
    return {folders, tasks: names.size, extraFolders: folders - names.size};
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
        // The Pipeline's Domain dropdown: the name-prefix domain, or a
        // connector task's kind (app.js domainKindOf).
        (!f.domainKind || f.domainKind === (row.domainKind || row.domain)) &&
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
        (!f.connector || (f.connector === 'yes' ? connectorType(row) === true
          : f.connector === 'no' ? connectorType(row) === false
          : connectorType(row) === null)) &&
        // The bench side is stamped on the row by the page.
        (!f.side || row.side === f.side) &&
        // The band is a property of the run, so a row with no trials is
        // excluded from every band filter rather than counted as 0.
        // A row never read for a bench is excluded from every bench filter
        // rather than counted as one side.
        (!f.bench || (f.bench === 'none' ? !row.bench
          : f.bench === 'company' || f.bench === 'computer' ? row.benchSide === f.bench
          : row.bench === f.bench)) &&
        (!f.glm || (f.glm === 'none' ? (row.glmPasses === undefined || row.glmPasses === null)
          : row.glmPasses === undefined || row.glmPasses === null ? false
          : f.glm === 'band' ? (row.glmPasses > 0 && row.glmPasses < row.glmTrials)
          : String(row.glmPasses) === f.glm)) &&
        (!f.search || text.includes(f.search.trim().toLowerCase())) &&
        (!f.start || (row.decided || '') >= f.start) &&
        (!f.end || (row.decided || '') <= f.end);
    });

    // Asking about delivery means asking about tasks. Collapse before anything
    // is counted, so every figure below is a task count rather than a row count.
    const collapsed = Boolean(f.delivered);
    const matched = collapsed ? collapseByTask(selected) : selected;

    // Accepted and actually collectable. Everything in here has either been
    // delivered or is waiting to be; there is no third thing it can be.
    const collectable = matched.filter(row => row.atCurrentBar &&
      (row.state === 'accepted' || row.state === 'legacy accepted'));
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
      accepted: matched.filter(row => row.state === 'accepted').length,
      legacyAccepted: matched.filter(row => row.state === 'legacy accepted').length,
      rejected: matched.filter(row => row.state === 'rejected').length,
      running: matched.filter(row => row.state === 'running').length,
      undecided: matched.filter(row => UNDECIDED.has(row.state)).length,
      carriedOver: matched.filter(row => row.carriedOver).length,
      gateOnly: matched.filter(row => row.gateOnly).length,
      atCurrentBar: matched.filter(row => row.atCurrentBar).length,
      delivered: matched.filter(row => row.delivered).length,
      connectorTasks: matched.filter(row => row.connector === true).length,
      nonConnectorTasks: matched.filter(row => row.connector === false).length,
      connectorUnknown: matched.filter(row => row.connector === null || row.connector === undefined).length,
      maybeDelivered: matched.filter(row => row.maybeDelivered).length,
      // "Ready" is deliberately narrow: accepted, its package actually
      // collectable at the current bar, and not already gone out. Counted by
      // distinct name as well as by row, because a task that was submitted
      // twice is still one thing to deliver.
      readyForDelivery: ready.length,
      readyNames: new Set(ready.map(row => (row.name || '').trim().toLowerCase())).size,
      deliveredNames: new Set(matched.filter(row => row.delivered)
        .map(row => (row.name || '').trim().toLowerCase())).size,
      // Task counts that hold whether or not the Delivered filter folded the
      // rows. The strip above the table asks a question about delivery, and
      // that is answered in tasks however the table happens to be filtered -
      // otherwise the same population reads 574 or 371 depending on a filter
      // that looks unrelated to it.
      deliveredTasks: new Set(matched.filter(row => row.delivered).map(taskKey)).size,
      readyTasks: new Set(ready.map(taskKey)).size,
      // The one population that genuinely partitions: a task accepted with a
      // package collectable at the current bar has either gone out or is
      // waiting to. `ready` is defined as this set minus the delivered ones,
      // so acceptedAtBarTasks = deliveredAtBarTasks + readyTasks holds by
      // construction and cannot drift as either definition changes.
      acceptedAtBarTasks: new Set(collectable.map(taskKey)).size,
      deliveredAtBarTasks: new Set(collectable.filter(row => row.delivered === true)
        .map(taskKey)).size,
      acceptedAtBarRows: collectable.length,
      deliveredAtBarRows: collectable.filter(row => row.delivered === true).length,
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
  root.acceptedTaskNames = acceptedTaskNames;
  root.joinDeliveries = joinDeliveries;
  root.connectorType = connectorType;
  root.benchOfImage = benchOfImage;
  if (typeof module !== 'undefined') module.exports = {prepareTruth, filterTruth, collapseByTask, chainFor, acceptedTaskNames, joinDeliveries, connectorType, benchOfImage, UNDECIDED};
})(typeof window === 'undefined' ? globalThis : window);

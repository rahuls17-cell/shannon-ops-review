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
    // Which bench a task runs on, from the base image in its Dockerfile. Only
    // connector tasks have one: a plain base image is not a bench.
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

    // Delivery is a property of the TASK, not of the folder it was cut from.
    // When a task sits under several folders and a manifest delivered one of
    // them, the others are the same work: listing them as "still to deliver"
    // invites sending it twice. 34 folders were in that state when this was
    // written, and the Ready filter offered 3 of them with no warning at all.
    //
    // Two outcomes, never a silent merge across people:
    //   delivered  the delivered folder has the same trainer, or either side is
    //              not a person (a service account re-cutting someone's task)
    //   check      a DIFFERENT trainer delivered a task with this declared name.
    //              Names are not unique per person, so this is a warning (CK)
    //              for someone to look at, and the folder stays in the pool.
    const folderEntries = (cohortIndex && cohortIndex.folders) || {};
    const isPerson = owner => /@turing\.com$/i.test(owner || '') && !/^companybench@/i.test(owner || '');
    const siblingDelivery = (folder, owner) => {
      const entry = folderEntries[folder];
      const task = packageTasks[folder];
      if (!task || (entry && entry.delivered)) return null;
      const gone = (siblings[task] || [])
        .filter(other => other !== folder && folderEntries[other] && folderEntries[other].delivered)
        .map(other => ({folder: other, batch: folderEntries[other].batch || null,
                        owner: folderEntries[other].owner || null}));
      if (!gone.length) return null;
      const mine = owner || (entry && entry.owner) || null;
      const same = gone.find(g => !isPerson(mine) || !isPerson(g.owner) || g.owner === mine);
      return same ? {kind: 'delivered', via: same} : {kind: 'check', via: gone[0]};
    };

    const benches = (benchIndex && benchIndex.bench) || {};
    // The cache has two kinds of key, because it has two sources: the task
    // source tree is keyed by pipeline row id, and a package opened directly is
    // keyed by the bucket folder it sits in. A lookup that tries only the row id
    // silently drops every bench that was read from a package - which is exactly
    // the tasks whose task tree was missing, so the ones that needed it most.
    const benchAt = (...keys) => {
      for (let i = 0; i < keys.length; i += 1) {
        const hit = keys[i] && benches[keys[i]];
        if (hit && hit.bench) {
          return {bench: hit.bench, benchImage: hit.image,
                  benchSide: hit.bench.startsWith('company') ? 'company' : 'computer'};
        }
      }
      return {};
    };

    const trials = (glmIndex && glmIndex.glm) || {};
    const glmOf = id => {
      const hit = trials[id];
      if (!hit) return {};
      return {glmPasses: hit.passes, glmTrials: hit.trials, glmRewards: hit.rewards || []};
    };
    const rows = (delivered || connectorIndex || glmIndex || benchIndex || cohortIndex)
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
      : payload.tasks;

    const cohort = cohortRows(rows, cohortIndex, benchAt, dupOf, siblingDelivery);
    carrySiblingDelivery(rows, cohort);

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

  // Each folder gets the verdict row that best describes it, so the table keeps
  // its trainer, dates, GLM band and drill-down. A folder with no verdict row
  // still appears, carrying what the bucket knows and nothing invented.
  // The fields a folder row carries when its task already went out under a
  // different folder. Kept apart from `delivered` from the manifest so the page
  // can always say which of the two it is.
  function siblingFields(sib, ownDelivered) {
    if (!sib) return {};
    const where = `${sib.via.folder}${sib.via.batch ? ` (${sib.via.batch})` : ''}`;
    return sib.kind === 'delivered'
      ? {delivered: true, deliveredVia: `same task delivered as ${where}`,
         deliveredSibling: sib.via, cohortDelivered: ownDelivered}
      : {sameNameDelivered: sib.via};
  }

  // The Ready filter reads the verdict rows, not the folder rows, so the same
  // answer has to reach them. A folder row borrowed its verdict row by name;
  // every verdict row with that spelling describes the same folder.
  function carrySiblingDelivery(rows, cohort) {
    if (!cohort) return;
    const bySpelling = new Map();
    rows.forEach(row => {
      [keyOf(row.name), stemOf(row.name)].forEach(spelling => {
        if (!spelling) return;
        if (!bySpelling.has(spelling)) bySpelling.set(spelling, new Set());
        bySpelling.get(spelling).add(row);
      });
    });
    cohort.forEach(folderRow => {
      if (folderRow.noVerdict || !(folderRow.deliveredSibling || folderRow.sameNameDelivered)) return;
      const hits = new Set([...(bySpelling.get(keyOf(folderRow.cohortFolder)) || []),
        ...(bySpelling.get(stemOf(folderRow.cohortFolder)) || [])]);
      hits.forEach(row => {
        if (row.delivered) return;
        if (folderRow.deliveredSibling) {
          row.delivered = true;
          row.deliveredVia = folderRow.deliveredVia;
          row.deliveredSibling = folderRow.deliveredSibling;
        } else if (!row.sameNameDelivered) {
          row.sameNameDelivered = folderRow.sameNameDelivered;
        }
      });
    });
  }

  function cohortRows(rows, cohortIndex, benchAt, dupOf, siblingDelivery) {
    if (!cohortIndex || !cohortIndex.folders) return null;
    const sibOf = siblingDelivery || (() => null);
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
                cohortState: entry.state || null, fromBucket: true,
                ...siblingFields(sibOf(entry.folder, match.owner), entry.delivered)};
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
        fromBucket: true, noVerdict: true, ...benchAt(entry.folder),
        ...dupOf(entry.folder),
        ...siblingFields(sibOf(entry.folder, entry.owner), entry.delivered),
      };
    });
    return built.sort((a, b) => {
      const left = a.decided || '', right = b.decided || '';
      if (left && right && left !== right) return left < right ? 1 : -1;
      if (left !== right) return left ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  // The accepted folders, counted as TASKS.
  //
  // A folder is one package; a task can sit under several folders after a
  // re-cut or under a console placeholder. The declared [task] name decides
  // which folders are one task; a folder whose package could not be read is its
  // own task, because nothing says otherwise. Delivery is decided per task: it
  // has gone out if any of its folders went out.
  function acceptedTaskKey(row) {
    // A folder whose declared name was delivered by a DIFFERENT trainer is not
    // folded into that task: names are not unique per person, so it stays its
    // own item in the pool, carrying CK, until someone decides.
    if (row.sameNameDelivered || !row.packageTask) {
      return `folder:${String(row.cohortFolder || row.id).toLowerCase()}`;
    }
    return `task:${keyOf(row.packageTask)}`;
  }

  function acceptedTaskCounts(folderRows) {
    const tasks = new Map();
    (folderRows || []).forEach(row => {
      const key = acceptedTaskKey(row);
      const held = tasks.get(key) || {delivered: false, check: false};
      held.delivered = held.delivered || Boolean(row.delivered);
      held.check = held.check || Boolean(row.sameNameDelivered || row.maybeDelivered);
      tasks.set(key, held);
    });
    const all = [...tasks.values()];
    const delivered = all.filter(t => t.delivered).length;
    return {
      folders: (folderRows || []).length,
      tasks: tasks.size,
      extraFolders: (folderRows || []).length - tasks.size,
      delivered,
      toDeliver: tasks.size - delivered,
      toDeliverNeedsCheck: all.filter(t => !t.delivered && t.check).length,
      deliveredViaSibling: (folderRows || []).filter(r => r.deliveredSibling).length,
    };
  }

  function filterTruth(rows, filters) {
    const f = filters || {};
    const has = (list, value) => !value || (list || []).includes(value);
    const selected = rows.filter(row => {
      // The declared name too, so a row shown under a placeholder such as
      // harbor-single-task-2sy38tlg is still found by searching for its task.
      const text = [row.name, row.packageTask, row.declaredName, row.owner, row.why,
        (row.findings || []).join(' ')].join(' ').toLowerCase();
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
        // Bench is a property of connector tasks only, so a row without one is
        // excluded from every bench filter rather than counted as neither.
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
  root.acceptedTaskCounts = acceptedTaskCounts;
  if (typeof module !== 'undefined') {
    module.exports = {prepareTruth, filterTruth, collapseByTask, chainFor, acceptedTaskCounts, UNDECIDED};
  }
})(typeof window === 'undefined' ? globalThis : window);

(function (root) {
  // Builds a delivery manifest from whatever the Pipeline tab is showing.
  //
  // The problem this exists to solve is duplicate delivery: the pipeline holds
  // 410 ready rows but only 369 distinct tasks, because a task submitted more
  // than once appears more than once, and because the bucket appends version
  // suffixes to names the audit records plainly. Shipping the rows as they
  // stand would send the same piece of work twice.
  //
  // So a manifest is built from NAMES, not rows: one entry per distinct task,
  // with the representative row chosen by a stated rule, and the identifiers of
  // every row it stands for carried alongside so nothing is silently discarded.
  //
  // Everything here is deterministic. The same population, size and exclusions
  // produce byte-identical output, which is what makes a manifest checkable
  // after the fact.

  // Suffixes the bucket appends that the delivery audit does not carry. Kept
  // identical to tools/build_delivered_index.py: if the two ever disagree, a
  // task could be marked delivered under one spelling and shipped again under
  // another.
  const SUFFIX = /(?:-(?:final|v\d+|\d{4,}|copy|new|fixed|updated))+$/;

  function normaliseName(value) {
    let name = String(value || '').trim().toLowerCase();
    let previous = null;
    while (name !== previous) { previous = name; name = name.replace(SUFFIX, ''); }
    return name;
  }

  // 25 of the ready rows carry a placeholder name - `autorun-<hash>`,
  // `harbor-single-task-<junk>` - which is useless on a handover sheet. The
  // family id and the verdict path still spell the task out, so a readable name
  // is recovered from there and reported as derived. The recorded name is never
  // overwritten, and this is not used as the grouping key: it recovers no extra
  // duplicates, and a derived name is not something to dedupe on.
  const PLACEHOLDER = /^(?:autorun-|harbor-single-task-|content-[0-9a-f]{12,})/;
  const FROM_ID = [
    /^task:(?:harbor\/)?(.+)$/,
    /^family:(.+?)-\d{8}t[\dz]*-?[0-9a-f]{4,}$/,
    /^family:(.+?)-[0-9a-f]{6,}$/,
  ];

  function readableName(row) {
    const name = String(row.name || '');
    if (!PLACEHOLDER.test(name.toLowerCase())) return {name, source: 'pipeline'};
    const id = String(row.id || '').toLowerCase();
    for (const pattern of FROM_ID) {
      const found = id.match(pattern);
      const candidate = found && found[1];
      if (candidate && !PLACEHOLDER.test(candidate) && !/^[0-9a-f]{16,}$/.test(candidate)) {
        return {name: candidate, source: 'derived from the verdict identifier'};
      }
    }
    return {name, source: 'placeholder; no readable name recorded'};
  }

  // Which row speaks for a name. Most decided first because that is the run the
  // pipeline settled on; then the one that got furthest; then the id, purely so
  // the result cannot depend on input order.
  function preferred(a, b) {
    return (b.decided || '').localeCompare(a.decided || '') ||
      (Number(b.runs) || 0) - (Number(a.runs) || 0) ||
      String(a.id).localeCompare(String(b.id));
  }

  // A folder key names one bucket folder exactly, so it is only lower-cased: a
  // folder called ...-v5 or ...-20260918 is a different folder from the one
  // without the suffix, and stripping it here meant it was never excluded.
  const withoutNamespace = value => String(value || '').trim().replace(/^(?:harbor|obi)\//i, '');
  function exclusionKey(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text.startsWith('folder:')) return text;
    if (text.startsWith('task:')) return `task:${normaliseName(withoutNamespace(text.slice(5)))}`;
    return normaliseName(withoutNamespace(text));
  }

  // Which task a row is. The [task] name its package declares comes first: a
  // task re-cut under a new name or folder after review is still one task, and
  // shipping both copies is the duplicate this file exists to prevent. Then the
  // bucket folder, then the row's own name.
  function taskKey(row) {
    if (row.packageTask) return `task:${normaliseName(withoutNamespace(row.packageTask))}`;
    if (row.cohortFolder) return `folder:${String(row.cohortFolder).trim().toLowerCase()}`;
    return normaliseName(row.name);
  }

  // Whether an earlier manifest already names this row's task, however it
  // names it: the task key, the bucket folder, or the row's or package's name.
  function exclusionMatcher(list) {
    const exclude = new Set([...(list || [])].map(exclusionKey));
    if (!exclude.size) return () => false;
    return row => [
      taskKey(row),
      row.cohortFolder ? `folder:${String(row.cohortFolder).trim().toLowerCase()}` : null,
      ...[row.name, row.packageTask].filter(Boolean).map(n => normaliseName(withoutNamespace(n))),
    ].some(k => k && exclude.has(k));
  }

  function buildManifest(rows, options) {
    const o = options || {};
    const excludes = exclusionMatcher(o.exclude);

    const groups = new Map();
    rows.forEach(row => {
      const k = taskKey(row);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    });

    const excluded = [];
    const candidates = [];
    groups.forEach((members, k) => {
      if (members.some(excludes)) { excluded.push(k); return; }
      const sorted = [...members].sort(preferred);
      candidates.push({key: k, row: sorted[0], members: sorted});
    });

    // Oldest decision first: the work that has been sitting accepted the
    // longest ships first, and the order does not shuffle between builds.
    candidates.sort((a, b) =>
      (a.row.decided || '').localeCompare(b.row.decided || '') ||
      a.key.localeCompare(b.key));

    const size = Number(o.size) > 0 ? Math.floor(Number(o.size)) : candidates.length;
    const taken = candidates.slice(0, size);

    const tasks = taken.map((c, i) => {
      const readable = readableName(c.row);
      return {
      position: i + 1,
      name: c.row.name,
      readableName: readable.name,
      nameSource: readable.source,
      key: c.key,
      id: c.row.id,
      owner: c.row.owner || null,
      state: c.row.state,
      decided: c.row.decided || null,
      decidedInferred: Boolean(c.row.decidedInferred),
      gateEra: c.row.gateEra || null,
      domain: c.row.domain || null,
      connector: c.row.connector === undefined ? null : c.row.connector,
      carriedOver: Boolean(c.row.carriedOver),
      // Set when this task's identifier names a task the delivery audit
      // already covers. Not excluded - checked by a person before it ships.
      possiblyAlreadyDelivered: c.row.maybeDelivered || null,
      source: c.row.source || null,
      // The rows this entry stands for. One entry, several submissions - the
      // point of the manifest is that only one of them ships.
      standsFor: c.members.map(m => m.id),
      supersededRows: c.members.length - 1,
    };
    });

    const owners = new Set(tasks.map(t => t.owner).filter(Boolean));
    return {
      schema: 'shannon/delivery-manifest/v1',
      generatedAt: o.generatedAt || new Date().toISOString(),
      pipelineGeneratedAt: o.pipelineGeneratedAt || null,
      deliveredIndexGeneratedAt: o.deliveredIndexGeneratedAt || null,
      selection: {
        rule: 'one entry per distinct task - the [task] name its package declares, ' +
              'else its own name - version and status suffixes stripped; the most ' +
              'recent decided run represents it; oldest decision first',
        requested: Number(o.size) > 0 ? Math.floor(Number(o.size)) : null,
        filters: o.filters || {},
        excludedFrom: o.excludedFrom || null,
        rowsConsidered: rows.length,
        distinctTasks: groups.size,
        excludedByPreviousManifest: excluded.length + (Number(o.excludedBefore) || 0),
        availableAfterExclusions: candidates.length,
        shortBy: Math.max(0, (Number(o.size) > 0 ? Math.floor(Number(o.size)) : candidates.length) - taken.length),
      },
      counts: {
        tasks: tasks.length,
        distinctNames: new Set(tasks.map(t => t.key)).size,
        owners: owners.size,
        rowsRepresented: tasks.reduce((n, t) => n + t.standsFor.length, 0),
        supersededRows: tasks.reduce((n, t) => n + t.supersededRows, 0),
        possiblyAlreadyDelivered: tasks.filter(t => t.possiblyAlreadyDelivered).length,
        namesDerived: tasks.filter(t => t.nameSource !== 'pipeline').length,
        namesUnrecoverable: tasks.filter(t => t.nameSource.startsWith('placeholder')).length,
      },
      tasks,
    };
  }

  // Names already claimed by an earlier manifest, so a second round does not
  // reissue the first one's work. Accepts a manifest of this schema; a delivery
  // manifest in the Drive batches' shape (harbor/delivery-manifest, which the
  // Delivery tab's Export manifest.json writes too); or a bare list of names,
  // because someone will paste one.
  const FOLDER_OF_URI = /\/tasks\/[^/]+\/([^/]+)\/[^/]+$/;
  const stemOf = path => String(path || '').split('/').pop().replace(/\.zip$/i, '');
  function namesFromDelivery(task) {
    const folders = [task.source_folder, (String(task.source_uri || '').match(FOLDER_OF_URI) || [])[1],
      withoutNamespace(task.task_id), stemOf(task.original_filename || task.package_path)];
    const names = [task.task_name, task.task_id].map(withoutNamespace);
    return [...folders.filter(Boolean).map(f => `folder:${String(f).trim().toLowerCase()}`),
            ...names.filter(Boolean)];
  }
  function namesFromManifest(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload.map(v => (typeof v === 'string' ? v : v && v.name)).filter(Boolean);
    if (Array.isArray(payload.tasks)) {
      return [...new Set(payload.tasks.flatMap(t => {
        if (!t) return [];
        if (t.key || t.name) return [t.key || t.name];
        return t.task_id || t.task_name ? namesFromDelivery(t) : [];
      }))];
    }
    return [];
  }

  root.buildManifest = buildManifest;
  root.namesFromManifest = namesFromManifest;
  root.manifestExclusionMatcher = exclusionMatcher;
  root.normaliseManifestName = normaliseName;
  if (typeof module !== 'undefined') {
    module.exports = {buildManifest, namesFromManifest, normaliseName, exclusionMatcher, taskKey};
  }
})(typeof window === 'undefined' ? globalThis : window);

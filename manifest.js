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

  function buildManifest(rows, options) {
    const o = options || {};
    const exclude = new Set([...(o.exclude || [])].map(normaliseName));

    const groups = new Map();
    rows.forEach(row => {
      const k = normaliseName(row.name);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    });

    const excluded = [];
    const candidates = [];
    groups.forEach((members, k) => {
      if (exclude.has(k)) { excluded.push(k); return; }
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
        rule: 'one entry per distinct task name, version and status suffixes ' +
              'stripped; the most recent decided run represents it; oldest ' +
              'decision first',
        requested: Number(o.size) > 0 ? Math.floor(Number(o.size)) : null,
        filters: o.filters || {},
        rowsConsidered: rows.length,
        distinctTasks: groups.size,
        excludedByPreviousManifest: excluded.length,
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
  // reissue the first one's work. Accepts a manifest of this schema, or a bare
  // list of names, because someone will paste one.
  function namesFromManifest(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload.map(v => (typeof v === 'string' ? v : v && v.name)).filter(Boolean);
    if (Array.isArray(payload.tasks)) return payload.tasks.map(t => t.key || t.name).filter(Boolean);
    return [];
  }

  root.buildManifest = buildManifest;
  root.namesFromManifest = namesFromManifest;
  root.normaliseManifestName = normaliseName;
  if (typeof module !== 'undefined') {
    module.exports = {buildManifest, namesFromManifest, normaliseName};
  }
})(typeof window === 'undefined' ? globalThis : window);

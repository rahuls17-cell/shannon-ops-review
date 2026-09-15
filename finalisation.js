(function (root) {
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function reconcile(source, trainers) {
    if (!Array.isArray(source.tasks) || !source.bucket?.endsWith('/finalisation_client_qc_accepted_iteration_2/')) throw new Error('Unexpected finalisation feed');
    if (source.tasks.length !== source.totals?.task_folders) throw new Error('Incomplete finalisation feed');
    const aliases = new Map();
    for (const trainer of trainers) {
      for (const key of new Set([normalize(trainer.name), normalize(trainer.email.split('@')[0])])) {
        if (!key) continue;
        if (!aliases.has(key)) aliases.set(key, []);
        aliases.get(key).push(trainer);
      }
    }
    const seen = new Set();
    return source.tasks.map(task => {
      if (!task.folder || seen.has(task.folder)) throw new Error('Missing or duplicate finalisation folder');
      seen.add(task.folder);
      const candidates = aliases.get(normalize(task.owner)) || [];
      const match = candidates.length === 1 ? candidates[0] : null;
      const attribution = task.owner_contested ? 'Contested owner' : !task.owner ? 'Owner missing' : !match ? 'Roster match unresolved' : task.owner_basis === 'name match' ? 'Name match only' : 'Matched owner';
      return {...task, attribution, trainer: task.owner_contested ? null : match};
    });
  }
  root.reconcileFinalisation = reconcile;
  root.filterFinalisationRecords = function (records, filters, roster) {
    const trainers = new Map(roster.map(row => [row.email.toLowerCase(), row]));
    const prepared = records.map(row => {
      const trainer = row.conflict ? null : trainers.get(row.groupEmail || row.email);
      const ownership = row.conflict ? 'conflict' : trainer ? 'linked' : (row.email || row.owner) ? 'unlinked' : 'missing';
      const team = trainer?.team;
      const bench = team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(team) ? 'computer' : 'unassigned';
      const type = row.source === 'Finalisation'
        ? row.is_connector === true ? 'Connector' : row.is_connector === false ? 'Non-connector' : 'Not recorded'
        : ['Connector', 'Non-connector'].includes(row.taskType) ? row.taskType : 'Not recorded';
      const domain = String(row.domain || '').trim() || 'Not recorded';
      return {...row, resolvedTrainer: trainer, ownership, bench, filterType: type, filterDomain: domain};
    });
    const population = prepared.filter(row => !filters.source || row.source === filters.source);
    const invalidDates = Boolean(filters.start && filters.end && filters.start > filters.end);
    const rows = invalidDates ? [] : population.filter(row => {
      const text = [row.displayName, row.name, row.folder, row.owner, row.email, row.resolvedTrainer?.name, row.resolvedTrainer?.email].join(' ').toLowerCase();
      const date = row.date || '';
      return (!filters.emails || filters.emails.includes(row.resolvedTrainer?.email.toLowerCase())) &&
        (!filters.bench || filters.bench === row.bench) &&
        (!filters.ownership || filters.ownership === row.ownership) &&
        (!filters.type || filters.type === row.filterType) &&
        (!filters.domain || filters.domain === row.filterDomain) &&
        (!filters.search || text.includes(filters.search.trim().toLowerCase())) &&
        (!(filters.start || filters.end) || (/^\d{4}-\d{2}-\d{2}$/.test(date) && (!filters.start || date >= filters.start) && (!filters.end || date <= filters.end))) &&
        (!filters.duplicates || (filters.duplicates === 'unique' ? !row.duplicate : filters.duplicates === 'duplicates' ? row.duplicate : row.groupSize > 1));
    });
    return {rows, population, invalidDates,
      linked: rows.filter(row => row.resolvedTrainer).length,
      groups: new Set(rows.map(row => row.countedId)).size,
      duplicates: rows.filter(row => row.duplicate).length,
      conflicts: new Set(rows.filter(row => row.conflict).map(row => row.countedId)).size};
  };
  if (typeof module !== 'undefined') module.exports = reconcile;
})(typeof window === 'undefined' ? globalThis : window);

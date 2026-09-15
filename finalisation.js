(function (root) {
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameKey = value => String(value || '').trim().toLowerCase().replace(/^harbor\//, '');

  function prepareFinalisation(source, roster) {
    if (!source || !Array.isArray(source.tasks) || !Array.isArray(source.cohorts)) throw new Error('Unexpected finalisation export');
    const scanned = source.cohorts.reduce((total, cohort) => total + (cohort.scanned || 0), 0);
    if (scanned !== source.tasks.length) throw new Error('Finalisation cohort counts do not match the scanned tasks');
    const trainers = new Map(roster.map(row => [String(row.email || '').toLowerCase(), row]));
    const aliases = new Map();
    for (const trainer of roster) {
      for (const key of new Set([normalize(trainer.name), normalize(trainer.email.split('@')[0])])) {
        if (!key) continue;
        if (!aliases.has(key)) aliases.set(key, []);
        aliases.get(key).push(trainer);
      }
    }
    const seen = new Set();
    const rows = source.tasks.map(task => {
      const id = `${task.cohort}/${task.folder}`;
      if (seen.has(id)) throw new Error('Duplicate finalisation folder in one cohort');
      seen.add(id);
      const email = String(task.owner || '').toLowerCase();
      const byAlias = aliases.get(normalize(task.owner)) || [];
      const trainer = task.ownerContested ? null : trainers.get(email) || (byAlias.length === 1 ? byAlias[0] : null);
      const team = trainer?.team;
      return {...task, id,
        name: nameKey(task.declared_short || task.folder),
        displayName: task.declared_short || task.folder,
        trainer,
        ownership: task.ownerContested ? 'conflict' : trainer ? 'linked' : task.owner ? 'unlinked' : 'missing',
        attribution: task.ownerContested ? 'Contested owner' : task.owner ? 'Name match only' : 'No trainer record',
        bench: team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(team) ? 'computer' : 'unassigned',
        filterType: task.is_connector === true ? 'Connector' : task.is_connector === false ? 'Non-connector' : 'Not recorded',
        filterDomain: task.domain ? task.domain[0].toUpperCase() + task.domain.slice(1) : 'Not recorded',
        date: String(task.updated || '').slice(0, 10)};
    });
    // The same task is finalised into more than one cohort. Each folder is real,
    // but the task was done once, so the newest archive represents the task.
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.name)) groups.set(row.name, []);
      groups.get(row.name).push(row);
    }
    for (const members of groups.values()) {
      members.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.id.localeCompare(b.id));
      members.forEach((row, index) => {
        row.duplicate = index > 0;
        row.groupSize = members.length;
        row.countedId = members[0].id;
        row.cohortsForTask = [...new Set(members.map(member => member.cohortLabel))];
      });
    }
    return rows;
  }

  function filterFinalisation(rows, filters) {
    const population = rows.filter(row => (!filters.outcome || row.outcome === filters.outcome) &&
      (!filters.cohort || row.cohort === filters.cohort));
    const invalidDates = Boolean(filters.start && filters.end && filters.start > filters.end);
    const matched = invalidDates ? [] : population.filter(row => {
      const text = [row.displayName, row.declared_name, row.folder, row.owner, row.trainer?.name, row.trainer?.email, row.sha256].join(' ').toLowerCase();
      return (!filters.emails || filters.emails.includes(String(row.trainer?.email || '').toLowerCase())) &&
        (!filters.bench || filters.bench === row.bench) &&
        (!filters.ownership || filters.ownership === row.ownership) &&
        (!filters.type || filters.type === row.filterType) &&
        (!filters.domain || filters.domain === row.filterDomain) &&
        (!filters.search || text.includes(filters.search.trim().toLowerCase())) &&
        (!(filters.start || filters.end) || (/^\d{4}-\d{2}-\d{2}$/.test(row.date) && (!filters.start || row.date >= filters.start) && (!filters.end || row.date <= filters.end))) &&
        (!filters.duplicates || (filters.duplicates === 'unique' ? !row.duplicate : filters.duplicates === 'duplicates' ? row.duplicate : row.groupSize > 1));
    });
    return {rows: matched, population, invalidDates,
      tasks: new Set(matched.map(row => row.name)).size,
      linked: matched.filter(row => row.trainer).length,
      duplicates: matched.filter(row => row.duplicate).length,
      conflicts: matched.filter(row => row.ownership === 'conflict').length,
      archives: matched.reduce((total, row) => total + (row.archives || 0), 0)};
  }

  root.prepareFinalisation = prepareFinalisation;
  root.filterFinalisation = filterFinalisation;
  if (typeof module !== 'undefined') module.exports = {prepareFinalisation, filterFinalisation};
})(typeof window === 'undefined' ? globalThis : window);

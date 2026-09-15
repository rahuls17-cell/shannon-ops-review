(function (root) {
  const nameKey = value => String(value || '').trim().toLowerCase().replace(/^harbor\//, '');
  function reconcile(records) {
    const parents = records.map((_, i) => i);
    const find = i => parents[i] === i ? i : (parents[i] = find(parents[i]));
    const keys = new Map();
    records.forEach((row, i) => {
      // Exact declared names are a task-level policy; hashes identify identical archives.
      const identities = [row.name && `name:${nameKey(row.name)}`,
        row.sha256 && `sha:${row.sha256}`,
        row.familyId && row.ownerKey && `family:${row.ownerKey}:${row.familyId}`].filter(Boolean);
      identities.forEach(key => {
        if (keys.has(key)) parents[find(i)] = find(keys.get(key));
        else keys.set(key, i);
      });
    });
    const grouped = new Map();
    records.forEach((row, i) => {
      const key = find(i);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    const groups = [...grouped.values()].map(members => {
      members.sort((a, b) => (a.source === 'Finalisation' ? 0 : 1) - (b.source === 'Finalisation' ? 0 : 1) || a.id.localeCompare(b.id));
      const emails = new Set(members.map(r => r.email).filter(Boolean));
      const conflict = emails.size > 1 || members.some(r => r.contested);
      const email = !conflict && emails.size === 1 ? [...emails][0] : null;
      const representative = members[0];
      return {id: representative.id, members, email, conflict};
    });
    const rows = groups.flatMap(group => group.members.map((row, i) => ({...row,
      duplicate: i > 0, groupSize: group.members.length, countedId: group.id,
      groupEmail: group.email, conflict: group.conflict})));
    return {groups, rows, duplicateCount: records.length - groups.length};
  }
  root.reconcileAcceptedTasks = reconcile;
  if (typeof module !== 'undefined') module.exports = reconcile;
})(typeof window === 'undefined' ? globalThis : window);

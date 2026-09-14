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
  if (typeof module !== 'undefined') module.exports = reconcile;
})(typeof window === 'undefined' ? globalThis : window);

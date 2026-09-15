(function (root) {
  const normalize = value => String(value || '').trim().toLowerCase();
  function preparePayoutLedger(ledger, roster) {
    if (!ledger || !Array.isArray(ledger.tasks) || !Array.isArray(ledger.people)) throw new Error('Unexpected payout ledger');
    // The tab lists a task once per submission row; the ledger must collapse to one payable task.
    if (ledger.totals.sourceRows - ledger.totals.duplicateRows !== ledger.tasks.length) throw new Error('Payout ledger duplicate audit does not reconcile');
    const trainers = new Map(roster.map(row => [normalize(row.email), row]));
    const seen = new Set();
    return ledger.tasks.map(task => {
      const key = `${normalize(task.task)}::${task.email}`;
      if (seen.has(key)) throw new Error('Duplicate payout ledger entry');
      seen.add(key);
      const trainer = trainers.get(task.email) || null;
      const team = trainer?.team;
      return {...task, trainer,
        bench: team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(team) ? 'computer' : 'unassigned',
        filterType: task.type || 'Not recorded',
        payable: Boolean(task.accepted)};
    });
  }
  function filterPayoutLedger(tasks, filters) {
    const rows = tasks.filter(task => {
      const text = [task.task, task.email, task.trainer?.name, task.trainer?.team, task.cj, task.secondaryOwner, task.dashboardId].join(' ').toLowerCase();
      return (!filters.emails || filters.emails.includes(task.email)) &&
        (!filters.bench || filters.bench === task.bench) &&
        (!filters.payment || filters.payment === task.paymentState) &&
        (!filters.type || filters.type === task.filterType) &&
        (!filters.validity || (filters.validity === 'valid') === task.valid) &&
        (!filters.duplicates || (filters.duplicates === 'duplicates' ? task.duplicateRows > 0 : task.duplicateRows === 0)) &&
        (!filters.search || text.includes(normalize(filters.search)));
    });
    return {rows,
      accepted: rows.filter(row => row.payable).length,
      paid: rows.filter(row => row.paymentState === 'Paid').length,
      unitemised: rows.filter(row => row.paymentState === 'Not itemised').length,
      duplicateRows: rows.reduce((total, row) => total + row.duplicateRows, 0),
      conflicts: rows.filter(row => row.ownerConflict).length,
      people: new Set(rows.map(row => row.email)).size};
  }
  root.preparePayoutLedger = preparePayoutLedger;
  root.filterPayoutLedger = filterPayoutLedger;
  if (typeof module !== 'undefined') module.exports = {preparePayoutLedger, filterPayoutLedger};
})(typeof window === 'undefined' ? globalThis : window);

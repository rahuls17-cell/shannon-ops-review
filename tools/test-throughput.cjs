const assert = require('node:assert/strict');
const {prepareThroughput, filterThroughput, connectorOf} = require('../throughput.js');
const {preparePipeline} = require('../pipeline-view.js');

// Throughput consumes preparePipeline's output, so build the rows the same way
// the page does rather than hand-rolling a row shape that could drift from it.
const roster = [
  {email: 'a@example.com', name: 'A', team: 'Company'},
  {email: 'b@example.com', name: 'B', team: 'Computer A'},
  {email: 'c@example.com', name: 'C', team: ''},            // on roster, no team
];
const consoleLive = {
  coverage: {tasks: 6},
  tasks: [
    {name: 'alpha', state: 'rejected', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'a@example.com', taskType: 'Connector tasks'},
    {name: 'alpha', state: 'accepted', submittedAt: '2026-09-11', date: '2026-09-11', trainer: 'a@example.com', taskType: 'Connector tasks'},
    {name: 'beta',  state: 'rejected', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'b@example.com', taskType: 'Non-connector tasks'},
    {name: 'gamma', state: 'accepted', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'c@example.com', taskType: 'Non-connector tasks'},
    {name: 'delta', state: 'accepted', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'ghost@example.com', taskType: 'Non-connector tasks'},
    {name: 'alias', state: 'accepted', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'b@example.com', taskType: 'Non-connector tasks'},
  ],
};
// `delta` and `alias` deliver identical content under two different names, so
// they are one task. Name matching cannot see that; the fingerprint can.
const fingerprints = {tasks: [
  {folder: 'delta', fingerprint: 'fp-shared', updated: '2026-09-10T10:00:00Z'},
  {folder: 'alias', fingerprint: 'fp-shared', updated: '2026-09-10T11:00:00Z'},
  {folder: 'alpha', fingerprint: 'fp-alpha',  updated: '2026-09-11T10:00:00Z'},
]};
const gcs = {
  current: [
    {task: 'alpha', status: 'Accepted', updatedAt: '2026-09-12T09:00:00+00:00'},
    {task: 'beta',  status: 'Rejected', updatedAt: '2026-09-12T09:00:00+00:00'},
    {task: 'delta', status: 'Accepted', updatedAt: '2026-09-13T09:00:00+00:00'},
    {task: 'alias', status: 'Accepted', updatedAt: '2026-09-14T09:00:00+00:00'},
  ],
  historical: [
    // Same task accepted twice; the FIRST acceptance is the throughput event.
    {task: 'alpha', status: 'Accepted', updatedAt: '2026-09-11T08:00:00+00:00'},
    {task: 'gamma', status: 'Accepted', updatedAt: '2026-09-13T10:00:00+00:00'},
  ],
};
const plan = [
  {bench: 'Company Bench',  dates: ['2026-09-10', '2026-09-11'], plan: [10, 10], actual: [0, 0]},
  {bench: 'Computer Bench', dates: ['2026-09-10', '2026-09-11'], plan: [20, 0],  actual: [0, 0]},
];

const rows = preparePipeline(consoleLive, gcs, [], roster, fingerprints);
const prepared = prepareThroughput(plan, gcs, rows);

// --- connector labelling -----------------------------------------------
assert.equal(connectorOf('Connector tasks'), 'Connector');
assert.equal(connectorOf('Non-connector tasks'), 'Non-connector');
assert.equal(connectorOf(''), 'Not recorded');
assert.notEqual(connectorOf('Non-connector tasks'), 'Connector');

assert.throws(() => prepareThroughput(plan, gcs, []), /No pipeline rows/);
assert.throws(() => prepareThroughput(plan, gcs, null), /No pipeline rows/);

// --- mining counts SUBMISSIONS, because the plan commits to submissions --
assert.equal(prepared.events.filter(e => e.kind === 'mined').length, 6);

// --- acceptance counts TASKS on the canonical identity ------------------
const accepted = prepared.events.filter(e => e.kind === 'accepted');
// alpha, gamma, and delta+alias folded into ONE task by shared content.
assert.equal(accepted.length, 3);
// The fold is the point: counting by name would have given 4.
assert.equal(new Set(accepted.map(e => e.identity)).size, 3);
assert.equal(accepted.filter(e => e.identity === 'fp-shared').length, 1);
// ...and it takes the EARLIER of the two acceptance dates.
assert.equal(accepted.find(e => e.identity === 'fp-shared').date, '2026-09-13');
// alpha accepted twice is one event, at its first acceptance.
assert.equal(accepted.find(e => e.identity === 'fp-alpha').date, '2026-09-11');
// beta was never accepted.
assert.equal(accepted.some(e => e.identity.includes('beta')), false);

// identity basis is reported so no count is shown without saying what made it
assert.equal(prepared.identifiedByContent, 3);   // alpha, delta, alias
assert.equal(prepared.sharedIdentity, 2);        // delta and alias name each other

// --- bench attribution --------------------------------------------------
const all = filterThroughput(prepared, {});
assert.equal(all.byBench.Company.mined, 2);      // a@ submitted twice
assert.equal(all.byBench.Computer.mined, 2);     // b@ on beta and alias
assert.equal(all.byBench.Unassigned.mined, 2);   // c@ has no team, ghost@ is off-roster
assert.equal(all.totals.mined, 6);
// Unassigned is carried, not dropped: benches must account for every event.
assert.equal(Object.values(all.byBench).reduce((t, b) => t + b.mined, 0), all.totals.mined);
assert.equal(Object.values(all.byBench).reduce((t, b) => t + b.accepted, 0), all.totals.accepted);

// acceptance is one event per identity by construction - guard the regrouping
assert.equal(all.totals.acceptedTasks, all.totals.accepted);

// --- plan series --------------------------------------------------------
assert.equal(all.totals.target, 40);                       // 10 + 10 + 20; the 0 is not a commitment
assert.equal(all.mining.plan.Company['2026-09-10'], 10);
assert.equal(all.mining.plan.Computer['2026-09-11'], 0);
assert.equal(all.planApplies, true);

// A connector filter has no plan to compare against - the workbook commitment
// is not split by type - so the plan is withheld and flagged, not invented.
const connectorOnly = filterThroughput(prepared, {type: 'Connector'});
assert.equal(connectorOnly.planApplies, false);
assert.equal(connectorOnly.totals.target, 0);
assert.equal(connectorOnly.totals.mined, 2);               // both alpha submissions

// --- filters ------------------------------------------------------------
const company = filterThroughput(prepared, {bench: 'Company'});
assert.equal(company.totals.mined, 2);
assert.equal(company.totals.target, 20);
assert.equal(company.byBench.Computer.mined, 0);

const oneDay = filterThroughput(prepared, {start: '2026-09-10', end: '2026-09-10'});
assert.equal(oneDay.totals.mined, 5);              // alpha, beta, gamma, delta, alias
assert.equal(oneDay.totals.accepted, 0);                   // nothing accepted that day
assert.deepEqual(oneDay.days, ['2026-09-10']);

const backwards = filterThroughput(prepared, {start: '2026-09-12', end: '2026-09-10'});
assert.equal(backwards.invalidDates, true);
assert.equal(backwards.totals.mined, 0);
assert.deepEqual(backwards.days, []);

// --- derived rates ------------------------------------------------------
assert.equal(all.totals.attainment, 6 / 40);
assert.equal(all.totals.acceptanceRate, 3 / 6);
assert.equal(filterThroughput(prepared, {start: '2030-01-01'}).totals.attainment, null);

// --- dense series, so charts need no gap handling ------------------------
for (const bench of prepared.benches) {
  for (const date of all.days) {
    assert.equal(typeof all.mining.actual[bench][date], 'number');
    assert.equal(typeof all.acceptance.actual[bench][date], 'number');
  }
}

console.log('test-throughput: all assertions passed');

const assert = require('node:assert/strict');
const {prepareThroughput, filterThroughput, connectorOf} = require('../throughput.js');

const roster = [
  {email: 'a@example.com', name: 'A', team: 'Company'},
  {email: 'b@example.com', name: 'B', team: 'Computer A'},
  {email: 'c@example.com', name: 'C', team: ''},          // on roster, no team
];
const consoleLive = {
  coverage: {tasks: 5},
  tasks: [
    {name: 'alpha', submittedAt: '2026-09-10', trainer: 'a@example.com', taskType: 'Connector tasks'},
    {name: 'alpha', submittedAt: '2026-09-11', trainer: 'a@example.com', taskType: 'Connector tasks'},
    {name: 'beta',  submittedAt: '2026-09-10', trainer: 'b@example.com', taskType: 'Non-connector tasks'},
    {name: 'gamma', submittedAt: '2026-09-10', trainer: 'c@example.com', taskType: 'Non-connector tasks'},
    {name: 'delta', submittedAt: '2026-09-10', trainer: 'ghost@example.com', taskType: 'Non-connector tasks'},
  ],
};
const gcs = {
  current: [
    {task: 'alpha', status: 'Accepted', trainer: 'a@example.com', updatedAt: '2026-09-12T09:00:00+00:00', taskType: 'Code'},
    {task: 'beta',  status: 'Rejected', trainer: 'b@example.com', updatedAt: '2026-09-12T09:00:00+00:00', taskType: 'Law'},
  ],
  historical: [
    // Same task accepted twice; the FIRST acceptance is the throughput event.
    {task: 'alpha', status: 'Accepted', trainer: 'a@example.com', updatedAt: '2026-09-11T08:00:00+00:00', taskType: 'Code'},
    {task: 'gamma', status: 'Accepted', trainer: 'c@example.com', updatedAt: '2026-09-13T10:00:00+00:00', taskType: 'General'},
  ],
};
const plan = [
  {bench: 'Company Bench',  dates: ['2026-09-10', '2026-09-11'], plan: [10, 10], actual: [0, 0]},
  {bench: 'Computer Bench', dates: ['2026-09-10', '2026-09-11'], plan: [20, 0],  actual: [0, 0]},
];

// --- connector labelling -----------------------------------------------
assert.equal(connectorOf('Connector tasks'), 'Connector');
assert.equal(connectorOf('Non-connector tasks'), 'Non-connector');
assert.equal(connectorOf(''), 'Not recorded');
// "Non-connector" must not be read as "Connector" by a loose prefix match.
assert.notEqual(connectorOf('Non-connector tasks'), 'Connector');

// --- a truncated pull is refused, never silently under-reported ---------
assert.throws(() => prepareThroughput(plan, gcs, {coverage: {tasks: 9}, tasks: consoleLive.tasks}, roster),
  /truncated/);
assert.throws(() => prepareThroughput(plan, gcs, null, roster), /No console pull/);

const prepared = prepareThroughput(plan, gcs, consoleLive, roster);

// Mining counts SUBMISSIONS: alpha submitted twice is two mining events.
assert.equal(prepared.events.filter(e => e.kind === 'mined').length, 5);
// Acceptance counts TASKS: alpha accepted twice is one event, at the earlier date.
const accepted = prepared.events.filter(e => e.kind === 'accepted');
assert.equal(accepted.length, 2);                              // alpha, gamma - not beta
assert.equal(accepted.find(e => e.bench === 'Company').date, '2026-09-11');
// Acceptance borrows the console's connector label; the GCS taskType is a domain.
assert.equal(accepted.find(e => e.bench === 'Company').type, 'Connector');

// A name carrying BOTH labels in the console is Contested, never silently
// resolved to whichever row was seen first.
const collided = prepareThroughput(plan, gcs, {
  coverage: {tasks: 3},
  tasks: [
    {name: 'alpha', submittedAt: '2026-09-10', trainer: 'a@example.com', taskType: 'Non-connector tasks'},
    {name: 'alpha', submittedAt: '2026-09-10', trainer: 'a@example.com', taskType: 'Connector tasks'},
    {name: 'beta',  submittedAt: '2026-09-10', trainer: 'b@example.com', taskType: 'Connector tasks'},
  ],
}, roster);
const collidedAccepted = collided.events.filter(e => e.kind === 'accepted');
assert.equal(collidedAccepted.find(e => e.bench === 'Company').type, 'Contested');
// Mining reads each row's own taskType, so it is unaffected by the collision.
assert.equal(collided.events.filter(e => e.kind === 'mined' && e.type === 'Connector').length, 2);
assert.equal(collided.events.filter(e => e.kind === 'mined' && e.type === 'Non-connector').length, 1);

// --- bench attribution -------------------------------------------------
const all = filterThroughput(prepared, {});
assert.equal(all.byBench.Company.mined, 2);       // a@ submitted twice
assert.equal(all.byBench.Computer.mined, 1);      // b@
assert.equal(all.byBench.Unassigned.mined, 2);    // c@ has no team, ghost@ is off-roster
assert.equal(all.totals.mined, 5);
// Unassigned is carried, not dropped: the benches must account for every event.
assert.equal(Object.values(all.byBench).reduce((t, b) => t + b.mined, 0), all.totals.mined);

// --- plan series -------------------------------------------------------
assert.equal(all.totals.target, 40);                       // 10 + 10 + 20; the 0 is not a commitment
assert.equal(all.mining.plan.Company['2026-09-10'], 10);
assert.equal(all.mining.plan.Computer['2026-09-11'], 0);   // no commitment recorded that day
assert.equal(all.planApplies, true);

// A connector filter has no plan to compare against - the workbook commitment
// is not split by type - so the plan is withheld and flagged, not invented.
const connectorOnly = filterThroughput(prepared, {type: 'Connector'});
assert.equal(connectorOnly.planApplies, false);
assert.equal(connectorOnly.totals.target, 0);
assert.equal(connectorOnly.totals.mined, 2);

// --- filters -----------------------------------------------------------
const company = filterThroughput(prepared, {bench: 'Company'});
assert.equal(company.totals.mined, 2);
assert.equal(company.totals.target, 20);                   // Company's two days only
assert.equal(company.byBench.Computer.mined, 0);

const oneDay = filterThroughput(prepared, {start: '2026-09-10', end: '2026-09-10'});
assert.equal(oneDay.totals.mined, 4);
assert.equal(oneDay.totals.accepted, 0);                   // nothing accepted that day
assert.deepEqual(oneDay.days, ['2026-09-10']);

const backwards = filterThroughput(prepared, {start: '2026-09-12', end: '2026-09-10'});
assert.equal(backwards.invalidDates, true);
assert.equal(backwards.totals.mined, 0);
assert.deepEqual(backwards.days, []);

// --- derived rates -----------------------------------------------------
assert.equal(all.totals.attainment, 5 / 40);
assert.equal(all.totals.acceptanceRate, 2 / 5);
assert.equal(filterThroughput(prepared, {start: '2030-01-01'}).totals.attainment, null);

// --- every day is dense across every bench, so charts need no gap logic --
for (const bench of prepared.benches) {
  for (const date of all.days) {
    assert.equal(typeof all.mining.actual[bench][date], 'number');
    assert.equal(typeof all.acceptance.actual[bench][date], 'number');
  }
}

console.log('test-throughput: all assertions passed');

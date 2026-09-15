const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {preparePayoutLedger, filterPayoutLedger} = require('../payout-ledger.js');

const trainers = [
  {email: 'a@example.com', name: 'A', team: 'Company'},
  {email: 'b@example.com', name: 'B', team: 'Computer A'},
];
const ledger = {
  totals: {sourceRows: 4, duplicateRows: 1},
  people: [],
  tasks: [
    {task: 'one', email: 'a@example.com', type: 'Connector', valid: true, duplicateRows: 1, accepted: true, cj: '1', paymentState: 'Not itemised'},
    {task: 'two', email: 'a@example.com', type: 'Non-connector', valid: false, duplicateRows: 0, accepted: false, cj: null, paymentState: 'Not itemised'},
    {task: 'three', email: 'b@example.com', type: null, valid: true, duplicateRows: 0, accepted: true, cj: null, paymentState: 'Paid'},
  ],
};
const tasks = preparePayoutLedger(ledger, trainers);
const select = filters => filterPayoutLedger(tasks, filters);

assert.equal(select({}).rows.length, 3);
assert.equal(select({}).accepted, 2);
assert.equal(select({}).duplicateRows, 1); // Extra workbook rows never become extra payable tasks.
assert.equal(select({validity: 'invalid'}).rows.length, 1);
assert.equal(select({validity: 'valid'}).accepted, 2);
assert.equal(select({}).accepted, 2); // A Valid = 0 row is listed but never counted.
assert.equal(select({duplicates: 'duplicates'}).rows.length, 1);
assert.equal(select({duplicates: 'unique'}).rows.length, 2);
assert.equal(select({type: 'Not recorded'}).rows.length, 1);
assert.equal(select({bench: 'company'}).rows.length, 2);
assert.equal(select({emails: ['b@example.com']}).rows.length, 1);
assert.equal(select({payment: 'Paid'}).rows.length, 1);
assert.equal(select({payment: 'Not itemised'}).rows.length, 2);
assert.equal(select({}).paid, 1);
assert.equal(select({}).unitemised, 2); // A partly paid person never marks a specific task paid.
assert.equal(select({search: 'no such task'}).rows.length, 0);

assert.throws(() => preparePayoutLedger({...ledger, totals: {sourceRows: 9, duplicateRows: 0}}, trainers), /reconcile/);
assert.throws(() => preparePayoutLedger({
  totals: {sourceRows: 2, duplicateRows: 0}, people: [],
  tasks: [ledger.tasks[0], {...ledger.tasks[0], duplicateRows: 0}],
}, trainers), /Duplicate/);

const published = path.join(__dirname, '..', 'assets', 'payout-ledger.json');
if (fs.existsSync(published)) {
  const live = JSON.parse(fs.readFileSync(published, 'utf8'));
  const rows = preparePayoutLedger(live, trainers);
  const totals = live.totals;
  assert.equal(rows.length, totals.ledgerTasks);
  assert.equal(rows.filter(row => row.payable).length, totals.acceptedTasks);
  assert.equal(totals.paidAmount, totals.paidTasks * live.payPerTask);
  assert.equal(totals.pendingAmount, totals.pendingTasks * live.payPerTask);
  // Pending is only ever the shortfall between a person's accepted and paid tasks.
  const pending = live.people.reduce((total, person) => total + Math.max(person.acceptedTasks - person.paidTasks, 0), 0);
  assert.equal(pending, totals.pendingTasks);
  // Every paid task is either matched to a listed task or reported as unitemised; none is lost.
  assert.equal(totals.itemisedPaidTasks + totals.unitemisedPaidTasks, totals.paidTasks);
  assert.equal(live.requests.reduce((total, request) => total + request.paidTasks, 0), totals.paidTasks);
  for (const person of live.people) {
    assert.equal(person.itemisedPaidTasks + person.unitemisedPaidTasks, person.paidTasks);
    assert.ok(person.paidTasks === 0 || person.paymentRequests > 0, `${person.email} paid with no payment request`);
  }
  console.log(`payments: ${totals.paidTasks} tasks over ${totals.paymentRequests} requests / ${totals.itemisedPaidTasks} itemised / ${totals.unitemisedPaidTasks} not itemised`);
  console.log(`published ledger: ${totals.ledgerTasks} tasks / ${totals.acceptedTasks} accepted / ${totals.paidTasks} paid / ${totals.pendingTasks} pending`);
}
console.log('payout ledger checks passed');

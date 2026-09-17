const assert = require('node:assert/strict');
const {prepareDelta, filterDelta} = require('../daily-delta.js');
const {preparePipeline} = require('../pipeline-view.js');

const roster = [{email: 'a@example.com', name: 'A', team: 'Company'}];
const consoleLive = {
  coverage: {tasks: 4},
  tasks: [
    {name: 'alpha', state: 'accepted', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'a@example.com', taskType: 'Connector tasks'},
    {name: 'beta',  state: 'rejected', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'a@example.com', taskType: 'Connector tasks'},
    // no ledger record for this one, so its date falls back to the submission
    {name: 'orphan', state: 'error',   submittedAt: '2026-09-12', date: '2026-09-12', trainer: 'a@example.com', taskType: 'Connector tasks'},
    // same content as alpha under another name: one task, one event
    {name: 'twin',  state: 'accepted', submittedAt: '2026-09-10', date: '2026-09-10', trainer: 'a@example.com', taskType: 'Connector tasks'},
  ],
};
const fingerprints = {tasks: [
  {folder: 'alpha', fingerprint: 'fp-a', updated: '2026-09-10T10:00:00Z'},
  {folder: 'twin',  fingerprint: 'fp-a', updated: '2026-09-10T11:00:00Z'},
]};
const gcs = {
  current: [
    {task: 'alpha', status: 'Accepted', updatedAt: '2026-09-11T09:00:00+00:00'},
    {task: 'beta',  status: 'Rejected', updatedAt: '2026-09-13T09:00:00+00:00'},
  ],
  historical: [
    // earliest wins: alpha first reached Accepted on the 11th, not the 14th
    {task: 'alpha', status: 'Accepted', updatedAt: '2026-09-14T09:00:00+00:00'},
    // a status the task no longer holds must NOT date it
    {task: 'beta',  status: 'Accepted', updatedAt: '2026-09-09T09:00:00+00:00'},
  ],
};

const rows = preparePipeline(consoleLive, gcs, [], roster, fingerprints);
const prepared = prepareDelta(rows, gcs);

assert.throws(() => prepareDelta([], gcs), /No pipeline rows/);
assert.throws(() => prepareDelta(null, gcs), /No pipeline rows/);

// alpha and twin are one task by content, so three events, not four.
assert.equal(prepared.events.length, 3);
assert.equal(new Set(prepared.events.map(e => e.identity)).size, 3);

const byStatus = Object.fromEntries(prepared.events.map(e => [e.status, e]));

// The ledger dates the status change, not the submission.
assert.equal(byStatus.Accepted.date, '2026-09-11');   // ledger, earliest Accepted
assert.equal(byStatus.Accepted.basis, 'ledger');
assert.equal(byStatus.Rejected.date, '2026-09-13');
// beta holds Rejected, so its stale Accepted ledger row must not date it.
assert.notEqual(byStatus.Rejected.date, '2026-09-09');
// No ledger record at that status: fall back, and say that is what happened.
assert.equal(byStatus.Failed.date, '2026-09-12');
assert.equal(byStatus.Failed.basis, 'submission');

const all = filterDelta(prepared, {});
assert.deepEqual(all.days, ['2026-09-11', '2026-09-12', '2026-09-13']);
assert.deepEqual(all.statuses, ['Accepted', 'Failed', 'Rejected']);
assert.equal(all.series.Accepted['2026-09-11'], 1);
assert.equal(all.series.Accepted['2026-09-13'], 0);   // dense, so charts need no gap logic
assert.equal(all.tasks, 3);
assert.deepEqual(all.dated, {ledger: 2, submission: 1});
assert.equal(all.totals.Accepted, 1);

// every day is present for every status
for (const status of all.statuses) {
  for (const date of all.days) assert.equal(typeof all.series[status][date], 'number');
}

assert.equal(all.peak.Accepted.date, '2026-09-11');
assert.equal(all.peak.Accepted.count, 1);

const windowed = filterDelta(prepared, {start: '2026-09-12', end: '2026-09-12'});
assert.deepEqual(windowed.days, ['2026-09-12']);
assert.equal(windowed.tasks, 1);

const oneStatus = filterDelta(prepared, {status: 'Accepted'});
assert.deepEqual(oneStatus.statuses, ['Accepted']);
assert.equal(oneStatus.tasks, 1);

const backwards = filterDelta(prepared, {start: '2026-09-13', end: '2026-09-11'});
assert.equal(backwards.invalidDates, true);
assert.equal(backwards.tasks, 0);
assert.deepEqual(backwards.days, []);

console.log('test-daily-delta: all assertions passed');

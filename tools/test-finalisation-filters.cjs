const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {prepareFinalisation, filterFinalisation} = require('../finalisation.js');

const trainers = [
  {email: 'a@example.com', name: 'A', team: 'Company'},
  {email: 'b@example.com', name: 'B', team: 'Computer A'},
];
const source = {
  bucket: 'gs://obi-harbor-pipeline/tasks/',
  totals: {accepted: 3, rejected: 9, unsubmitted: 0},
  cohorts: [
    {prefix: 'iter1', label: 'Iteration 1', outcome: 'accepted', layout: 'task_zip', tasks: 2, scanned: 2},
    {prefix: 'qc_accepted', label: 'QC accepted', outcome: 'accepted', layout: 'task_zip', tasks: 1, scanned: 1},
    {prefix: 'qc_rejected', label: 'QC rejected', outcome: 'rejected', layout: 'run_task', tasks: 9, scanned: 0},
  ],
  tasks: [
    {cohort: 'iter1', cohortLabel: 'Iteration 1', outcome: 'accepted', folder: 'shared', declared_short: 'shared',
     is_connector: true, domain: null, owner: 'a@example.com', ownerContested: false, sha256: 'aa',
     updated: '2026-09-01T00:00:00Z', archives: 1},
    {cohort: 'qc_accepted', cohortLabel: 'QC accepted', outcome: 'accepted', folder: '9xk2', declared_short: 'shared',
     is_connector: true, domain: null, owner: 'a@example.com', ownerContested: false, sha256: 'bb',
     updated: '2026-09-09T00:00:00Z', archives: 2},
    {cohort: 'iter1', cohortLabel: 'Iteration 1', outcome: 'accepted', folder: 'law-l19', declared_short: 'law-l19',
     is_connector: false, domain: 'law', owner: null, ownerContested: true, sha256: 'cc',
     updated: '2026-09-05T00:00:00Z', archives: 1},
  ],
};

const rows = prepareFinalisation(source, trainers);
const select = filters => filterFinalisation(rows, filters);

assert.equal(rows.length, 3);
assert.equal(select({}).tasks, 2); // Three folders, two real tasks.
assert.equal(select({}).duplicates, 1);
// The newest archive represents the task, whichever cohort it landed in.
const kept = rows.find(row => !row.duplicate && row.name === 'shared');
assert.equal(kept.cohort, 'qc_accepted');
assert.deepEqual(kept.cohortsForTask.sort(), ['Iteration 1', 'QC accepted']);
assert.equal(select({duplicates: 'unique'}).rows.length, 2);
assert.equal(select({duplicates: 'duplicates'}).rows.length, 1);
assert.equal(select({cohort: 'iter1'}).rows.length, 2);
assert.equal(select({outcome: 'rejected'}).rows.length, 0); // Rejected cohorts are counted, not itemised.
assert.equal(select({ownership: 'conflict'}).rows.length, 1);
assert.equal(select({ownership: 'linked'}).linked, 2);
assert.equal(select({type: 'Connector'}).rows.length, 2);
assert.equal(select({domain: 'Law'}).rows.length, 1);
assert.equal(select({domain: 'Not recorded'}).rows.length, 2);
assert.equal(select({bench: 'company'}).rows.length, 2);
assert.equal(select({emails: ['a@example.com']}).rows.length, 2); // A contested owner never lands on a trainer.
assert.equal(select({start: '2026-09-05', end: '2026-09-09'}).rows.length, 2);
assert.equal(select({start: '2026-09-09', end: '2026-09-05'}).invalidDates, true);
assert.equal(select({search: 'law'}).rows.length, 1);
assert.equal(select({search: 'bb'}).rows.length, 1); // Archive digests are searchable.

assert.throws(() => prepareFinalisation({...source, cohorts: [{...source.cohorts[0], scanned: 99}]}, trainers), /do not match/);
assert.throws(() => prepareFinalisation({
  ...source,
  cohorts: [{prefix: 'iter1', label: 'Iteration 1', outcome: 'accepted', layout: 'task_zip', tasks: 2, scanned: 2}],
  tasks: [source.tasks[0], source.tasks[0]],
}, trainers), /Duplicate finalisation folder/);

const published = path.join(__dirname, '..', 'assets', 'gcs-pipeline.json');
if (fs.existsSync(published)) {
  const payload = JSON.parse(fs.readFileSync(published, 'utf8'));
  assert.equal(payload.schemaVersion, 3);
  const live = prepareFinalisation(payload.finalisation, trainers);
  const result = filterFinalisation(live, {});
  const accepted = payload.finalisation.cohorts.filter(c => c.outcome === 'accepted')
    .reduce((total, c) => total + c.tasks, 0);
  assert.equal(accepted, payload.finalisation.totals.accepted);
  assert.equal(result.rows.length - result.duplicates, result.tasks);
  console.log(`published scan: ${live.length} accepted folders / ${result.tasks} distinct tasks / ` +
    `${result.duplicates} cross-cohort repeats / ${payload.finalisation.cohorts.length} cohorts / ` +
    `accepted ${payload.finalisation.totals.accepted}, rejected ${payload.finalisation.totals.rejected}, ` +
    `unsubmitted ${payload.finalisation.totals.unsubmitted}`);
}
console.log('finalisation checks passed: cohorts, cross-cohort dedupe, ownership, type, domain, dates, search');

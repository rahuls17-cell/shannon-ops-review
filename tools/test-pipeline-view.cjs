const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {preparePipeline, filterPipeline} = require('../pipeline-view.js');

const roster = [
  {email: 'a@example.com', name: 'A', team: 'Company'},
  {email: 'b@example.com', name: 'B', team: 'Computer A'},
];
const consoleLive = {
  coverage: {tasks: 5, since: '2026-09-05'},
  tasks: [
    // Two submissions of one task: the later one is the row.
    {name: 'alpha', state: 'rejected', submittedAt: '2026-09-06', trainer: 'a@example.com', acceptedFolders: 0, taskType: 'Non-connector tasks', failedStage: ''},
    {name: 'alpha', state: 'accepted', submittedAt: '2026-09-09', trainer: 'a@example.com', acceptedFolders: 2, taskType: 'Non-connector tasks', failedStage: ''},
    {name: 'beta', state: 'error', submittedAt: '2026-09-07', trainer: 'b@example.com', acceptedFolders: 0, taskType: 'Connector tasks', failedStage: 'agent+e2b'},
    {name: 'gamma', state: 'accepted', submittedAt: '2026-08-30', trainer: 'ghost@example.com', acceptedFolders: 1, taskType: 'Non-connector tasks', failedStage: ''},
    {name: 'delta', state: 'running', submittedAt: '2026-09-12', trainer: '', acceptedFolders: 0, taskType: 'Non-connector tasks', failedStage: ''},
  ],
};
const gcs = {historical: [
  {task: 'alpha', status: 'Rejected', attempt: 1, submittedAt: '2026-09-06'},
  {task: 'alpha', status: 'Rejected', attempt: 2, submittedAt: '2026-09-08'},
  {task: 'beta', status: 'Failed', attempt: 1, submittedAt: '2026-09-07'},
]};
const finalisation = [
  {name: 'alpha', cohortLabel: 'QC accepted', archives: 3, filterDomain: 'Law', is_connector: false, sha256: 'aa'},
  {name: 'gamma', cohortLabel: 'Iteration 1', archives: 1, filterDomain: 'Not recorded', is_connector: true, sha256: 'cc'},
];

const rows = preparePipeline(consoleLive, gcs, finalisation, roster);
const byName = Object.fromEntries(rows.map(row => [row.name, row]));

assert.equal(rows.length, 4); // five submissions, four tasks
assert.equal(byName.alpha.status, 'Accepted'); // the later submission wins
assert.equal(byName.alpha.submissions, 2);
assert.equal(byName.beta.status, 'Failed'); // console `error` is the PRD's Failed
assert.equal(byName.gamma.status, 'Accepted');
assert.equal(byName.gamma.legacy, true); // before 5 Sept
assert.equal(byName.delta.legacy, false);

// The ledger explains, it never overrides.
assert.equal(byName.alpha.ledger.cycles, 2);
assert.equal(byName.alpha.ledger.attempts, 2);
assert.equal(byName.alpha.ledger.disagrees, true); // ledger says Rejected, console says Accepted
assert.equal(byName.beta.ledger.disagrees, false);
assert.equal(byName.delta.ledger.cycles, 0);
assert.equal(byName.delta.ledger.disagrees, false); // no evidence is not a disagreement

// Bucket evidence.
assert.equal(byName.alpha.bucket.folders, 1);
assert.deepEqual(byName.alpha.bucket.cohorts, ['QC accepted']);
assert.equal(byName.alpha.bucket.domain, 'Law');
assert.equal(byName.gamma.bucket.connector, true);
assert.equal(byName.beta.bucket.folders, 0);

// Roster linkage is separate from having an owner at all.
assert.equal(byName.gamma.onRoster, false);
assert.equal(byName.gamma.owner, 'ghost@example.com');
assert.equal(byName.delta.owner, null);

const select = filters => filterPipeline(rows, filters);
assert.equal(select({}).rows.length, 3); // legacy excluded by default (F4)
assert.equal(select({legacy: 'all'}).rows.length, 4);
assert.equal(select({legacy: 'only'}).rows.length, 1);
assert.equal(select({status: 'Accepted'}).rows.length, 1); // gamma is legacy, so excluded
assert.equal(select({legacy: 'all', status: 'Accepted'}).rows.length, 2);
assert.equal(select({type: 'Connector tasks'}).rows.length, 1);
assert.equal(select({trainer: 'a@example.com'}).rows.length, 1);
assert.equal(select({bench: 'computer'}).rows.length, 1);
assert.equal(select({evidence: 'delivered'}).rows.length, 1);
assert.equal(select({evidence: 'undelivered'}).rows.length, 2);
assert.equal(select({evidence: 'disagree'}).disagreements, 1);
assert.equal(select({legacy: 'all', evidence: 'offroster'}).offRoster, 1);
assert.equal(select({}).unowned, 1);
assert.equal(select({search: 'AGENT'}).rows.length, 1); // failed stage is searchable
assert.equal(select({start: '2026-09-10', end: '2026-09-12'}).rows.length, 1);
assert.equal(select({start: '2026-09-12', end: '2026-09-10'}).invalidDates, true);
assert.deepEqual(select({}).statuses, {Running: 1, Accepted: 1, Failed: 1});

assert.throws(() => preparePipeline({coverage: {tasks: 9}, tasks: consoleLive.tasks}, gcs, finalisation, roster), /truncated/);
assert.throws(() => preparePipeline(null, gcs, finalisation, roster), /No console pull/);

const live = path.join(__dirname, '..', 'assets', 'harbor-console-live.json');
const snapshot = path.join(__dirname, '..', 'assets', 'gcs-pipeline.json');
if (fs.existsSync(live) && fs.existsSync(snapshot)) {
  const pull = JSON.parse(fs.readFileSync(live, 'utf8'));
  const gcsLive = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const built = preparePipeline(pull, gcsLive, [], []);
  const shown = filterPipeline(built, {});
  assert.equal(built.length, new Set(pull.tasks.map(t => t.name.toLowerCase())).size);
  assert.ok(built.every(row => row.status !== 'Done')); // PRD F3: Done is gone
  console.log(`published: ${pull.tasks.length} submissions -> ${built.length} tasks / ` +
    `${shown.rows.length} live after excluding legacy / ${JSON.stringify(shown.statuses)}`);
  console.log(`  ledger disagreements: ${shown.disagreements} / off-roster owners: ${shown.offRoster} / unowned: ${shown.unowned}`);
}
console.log('pipeline view checks passed: console spine, ledger drill-down, bucket evidence, legacy split');

// The console counts submissions; this page counts tasks. Both must be reportable.
{
  const base = filterPipeline(rows, {});
  assert.equal(base.rows.length, 3);
  // alpha has 2 submissions, beta 1, delta 1; gamma is legacy so excluded.
  assert.equal(base.submissions, 4);
  assert.deepEqual(base.submissionStatuses, {Rejected: 1, Accepted: 1, Failed: 1, Running: 1});
  // Legacy-only sees only gamma's single pre-5-Sept submission.
  const legacyOnly = filterPipeline(rows, {legacy: 'only'});
  assert.equal(legacyOnly.submissions, 1);
  // A date window selects rows on their LATEST submission, so a task whose latest
  // submission falls outside drops out entirely and its in-window submissions go
  // with it. alpha was rejected on 09-06 but last submitted 09-09, so only beta
  // survives. The reconciliation panel says so rather than implying exactness.
  const window = filterPipeline(rows, {legacy: 'all', start: '2026-09-06', end: '2026-09-07'});
  assert.equal(window.rows.length, 1);
  assert.equal(window.submissions, 1);
  assert.ok(base.submissions >= base.rows.length);
}
console.log('basis checks passed: submissions and tasks reconcile on the same scope');

// Ordering is by time. Where two submissions carry genuinely identical
// timestamps - one task in the corpus does, with matching family_id and run_id
// but conflicting states - the one that got further wins.
//
// This fallback must never substitute for a missing time. A date-only feed makes
// every same-day pair look tied, and 99 pairs in the corpus do; ranking those by
// outcome was measured against the full timestamps and picked the earlier
// submission every time it changed one. Hence preparePipeline sources the full
// timestamps first, and these cases only arise when the times are truly equal.
{
  const consoleAt = order => ({
    coverage: {tasks: 2},
    tasks: order.map(state => ({
      name: 'tied', state, submittedAt: '2026-09-10', trainer: 'a@example.com',
      acceptedFolders: 0, taskType: 'Non-connector tasks', failedStage: '',
    })),
  });
  const statusOf = order => preparePipeline(consoleAt(order), {historical: []}, [], [])[0].status;

  assert.equal(statusOf(['rejected', 'accepted']), 'Accepted');
  // The same pair listed the other way round must not change the answer.
  assert.equal(statusOf(['accepted', 'rejected']), 'Accepted');
  assert.equal(statusOf(['error', 'rejected']), 'Rejected');
  assert.equal(statusOf(['running', 'error']), 'Failed');

  // A genuinely later submission still wins, whatever it reached.
  const later = preparePipeline({
    coverage: {tasks: 2},
    tasks: [
      {name: 'seq', state: 'accepted', submittedAt: '2026-09-10', trainer: 'a@example.com', acceptedFolders: 0, taskType: 'x', failedStage: ''},
      {name: 'seq', state: 'rejected', submittedAt: '2026-09-11', trainer: 'a@example.com', acceptedFolders: 0, taskType: 'x', failedStage: ''},
    ],
  }, {historical: []}, [], [])[0];
  assert.equal(later.status, 'Rejected');

  // A full timestamp separates same-day submissions properly, and the row's own
  // date stays a plain day so the date filters keep working.
  const stamped = preparePipeline({
    coverage: {tasks: 2},
    tasks: [
      {name: 'ts', state: 'accepted', submittedAt: '2026-09-10T09:00:00+00:00', trainer: 'a@example.com', acceptedFolders: 0, taskType: 'x', failedStage: ''},
      {name: 'ts', state: 'rejected', submittedAt: '2026-09-10T17:30:00+00:00', trainer: 'a@example.com', acceptedFolders: 0, taskType: 'x', failedStage: ''},
    ],
  }, {historical: []}, [], [])[0];
  assert.equal(stamped.status, 'Rejected');
  assert.equal(stamped.date, '2026-09-10');
}
console.log('tie-break checks passed: same-timestamp submissions resolve by how far they got');

// Task identity. A name is what a task is called; the fingerprint is what it is.
// 150 names are shared by more than one trainer and one is literally `task`, so
// the name alone both merges unrelated work and splits the same task delivered
// under two names.
{
  const consoleOf = names => ({
    coverage: {tasks: names.length},
    tasks: names.map(name => ({
      name, state: 'accepted', submittedAt: '2026-09-10', trainer: 'a@example.com',
      acceptedFolders: 1, taskType: 'Non-connector tasks', failedStage: '',
    })),
  });
  const build = (names, tasks) =>
    preparePipeline(consoleOf(names), {historical: []}, [], [], tasks ? {tasks} : null);

  // No fingerprint data at all: behave exactly as before, grouping by name.
  const plain = build(['solo']);
  assert.equal(plain[0].identity.basis, 'name');
  assert.equal(plain[0].identity.key, 'name:solo');
  assert.equal(plain[0].identity.packages, 0);

  // A delivered package identifies the task by its content.
  const [one] = build(['solo'], [{folder: 'solo', fingerprint: 'abc123', updated: '2026-09-09T00:00:00Z'}]);
  assert.equal(one.identity.basis, 'content');
  assert.equal(one.identity.key, 'abc123');
  assert.deepEqual(one.identity.alsoKnownAs, []);

  // The same content delivered under two names is one task, and each row says so.
  const shared = build(['alpha-name', 'beta-name'], [
    {folder: 'alpha-name', fingerprint: 'same', updated: '2026-09-09T00:00:00Z'},
    {folder: 'beta-name', fingerprint: 'same', updated: '2026-09-09T00:00:00Z'},
  ]);
  const byKey = Object.fromEntries(shared.map(row => [row.key, row]));
  assert.deepEqual(byKey['alpha-name'].identity.alsoKnownAs, ['beta-name']);
  assert.deepEqual(byKey['beta-name'].identity.alsoKnownAs, ['alpha-name']);

  const counts = filterPipeline(shared, {legacy: 'all'});
  assert.equal(counts.rows.length, 2);      // two names
  assert.equal(counts.identities, 1);       // one task
  assert.equal(counts.sharedIdentity, 2);
  assert.equal(counts.identifiedByContent, 2);

  // Repeat deliveries of one task are one version; the newest represents it.
  const versions = build(['edited'], [
    {folder: 'edited', fingerprint: 'v1', updated: '2026-09-01T00:00:00Z'},
    {folder: 'edited', fingerprint: 'v1', updated: '2026-09-04T00:00:00Z'},
    {folder: 'edited', fingerprint: 'v2', updated: '2026-09-08T00:00:00Z'},
  ]);
  assert.equal(versions[0].identity.packages, 3);
  assert.equal(versions[0].identity.versions, 2);
  assert.equal(versions[0].identity.key, 'v2'); // newest delivery represents it

  // Unreadable packages carry no fingerprint and must never fold together.
  const broken = build(['x-one', 'x-two'], [
    {folder: 'x-one', fingerprint: null, updated: '2026-09-09T00:00:00Z'},
    {folder: 'x-two', fingerprint: null, updated: '2026-09-09T00:00:00Z'},
  ]);
  assert.equal(filterPipeline(broken, {legacy: 'all'}).identities, 2);
}
console.log('identity checks passed: content groups tasks, name is only the label');

// Delivery is a property of the task, not of the folder it was cut from.
//
// The same task can sit under several folders in the accepted prefix - re-cut
// after a review, or filed under a console placeholder such as
// harbor-single-task-2sy38tlg. When a manifest delivered one of those folders,
// the others are the same work. Counting folders listed them as "still to
// deliver", and the Ready filter offered some of them with no warning at all:
// an invitation to send a task twice.
//
// What this pins down:
//   - a task counts as delivered if ANY of its folders went out (same trainer,
//     or a service account re-cutting someone's task)
//   - a DIFFERENT trainer delivering the same declared name is a warning (CK),
//     never a silent merge: task names are not unique per person
//   - the accepted figures are counted in tasks, and still add up
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const {prepareTruth, filterTruth, acceptedTaskCounts} = require(path.join(root, 'truth.js'));
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// --- the rule, on a hand-built bucket ---------------------------------------
{
  const row = (id, name, owner) => ({
    id, name, owner, state: 'accepted', atCurrentBar: true, decided: '2026-09-20', runs: 1,
    findings: [], cohorts: [],
  });
  const payload = {
    reconciles: true, generatedAt: 'x', cut: '2026-09-05', bucket: 'b', figures: [], vocabulary: {},
    tasks: [
      row('r-a1', 'alpha', 'ann@turing.com'), row('r-a2', 'alpha-v2', 'ann@turing.com'),
      row('r-b1', 'beta', 'ann@turing.com'), row('r-b2', 'beta-other', 'bob@turing.com'),
      row('r-c1', 'gamma', 'ann@turing.com'),
      row('r-c2', 'harbor-single-task-xyz', 'harbor-autostart@delivery-g-obi.iam.gserviceaccount.com'),
      row('r-d1', 'delta', 'dee@turing.com'),
    ],
  };
  const folder = (name, owner, delivered, batch) => ({folder: name, owner, delivered, batch});
  const cohortIndex = {
    cohort: 'finalisation_client_qc_accepted_iteration_2', cut: '2026-09-05', counts: {},
    folders: {
      'alpha': folder('alpha', 'ann@turing.com', true, 'Batch 1'),
      'alpha-v2': folder('alpha-v2', 'ann@turing.com', false),
      'beta': folder('beta', 'ann@turing.com', true, 'Batch 2'),
      'beta-other': folder('beta-other', 'bob@turing.com', false),
      'gamma': folder('gamma', 'ann@turing.com', true, 'Batch 3'),
      'harbor-single-task-xyz': folder('harbor-single-task-xyz', null, false),
      'delta': folder('delta', 'dee@turing.com', false),
    },
  };
  const names = {task: {
    'alpha': 'obi/alpha', 'alpha-v2': 'obi/alpha',
    'beta': 'obi/beta', 'beta-other': 'obi/beta',
    'gamma': 'harbor/gamma', 'harbor-single-task-xyz': 'harbor/gamma',
    'delta': 'obi/delta',
  }};
  // A delivered index is needed for the verdict rows to carry `delivered` at all.
  const deliveredIndex = {delivered: {'r-a1': 'name', 'r-b1': 'name', 'r-c1': 'name'},
    suspect: {}, deliveredTask: {}, counts: {}, pipelineGeneratedAt: 'x'};
  const model = prepareTruth(payload, deliveredIndex, null, null, cohortIndex, null, names);
  const at = name => model.cohortRows.find(r => r.cohortFolder === name);

  assert.ok(at('alpha-v2').delivered && at('alpha-v2').deliveredSibling.folder === 'alpha',
    'same trainer, same declared task: the second folder is already delivered');
  assert.ok(!at('alpha-v2').cohortDelivered, 'but it still says the folder itself was not in a manifest');
  assert.ok(!at('beta-other').delivered && at('beta-other').sameNameDelivered.folder === 'beta',
    'a different trainer with the same declared name is a warning, not a delivery');
  assert.ok(at('harbor-single-task-xyz').delivered,
    'a service-account re-cut of a delivered task is the same task');
  assert.ok(!at('delta').delivered && !at('delta').sameNameDelivered, 'an ordinary task is untouched');

  const counts = acceptedTaskCounts(model.cohortRows);
  assert.deepStrictEqual(
    {folders: counts.folders, tasks: counts.tasks, delivered: counts.delivered,
     toDeliver: counts.toDeliver, check: counts.toDeliverNeedsCheck},
    {folders: 7, tasks: 5, delivered: 3, toDeliver: 2, check: 1},
    'alpha, beta, gamma delivered; beta-other (CK) and delta still to deliver');

  // The Ready filter reads the verdict rows, so the answer has to reach them.
  const ready = filterTruth(model.rows, {delivered: 'ready'}).rows.map(r => r.name).sort();
  assert.ok(!ready.includes('alpha-v2'), 'an already-delivered task is not offered as ready');
  assert.ok(!ready.includes('harbor-single-task-xyz'), 'nor is its service-account re-cut');
  assert.ok(ready.includes('beta-other'), 'the other trainer’s task stays in the pool...');
  assert.ok(model.rows.find(r => r.name === 'beta-other').sameNameDelivered, '...carrying CK');
  assert.ok(ready.includes('delta'));

  // Searching for the task finds the placeholder that holds it.
  const found = filterTruth(model.cohortRows, {search: 'gamma'}).rows.map(r => r.cohortFolder);
  assert.ok(found.includes('harbor-single-task-xyz'), 'search reaches the declared name');
  console.log('delivery rule: same trainer -> delivered, other trainer -> CK, service re-cut -> delivered');
}

// --- the page shows it -------------------------------------------------------
{
  assert.ok(/when: row => row\.maybeDelivered \|\| row\.sameNameDelivered/.test(app),
    'CK must fire for a same-name delivery by another trainer');
  assert.ok(/row\.deliveredSibling/.test(app), 'DL must explain a delivery through another folder');
  assert.ok(/declaredLine\(row\)/.test(app), 'the Name column shows the declared name when it differs');
}

// --- the published data ------------------------------------------------------
{
  const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
  const names = read('task-names.json');
  const cohort = read('cohort-index.json');
  const model = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'),
    read('connector-index.json'), read('glm-index.json'), cohort, read('bench-index.json'), names);
  const rows = model.cohortRows;
  const c = acceptedTaskCounts(rows);

  assert.strictEqual(c.folders, rows.length);
  assert.strictEqual(c.delivered + c.toDeliver, c.tasks, 'delivered + still to deliver = every task');
  assert.ok(c.tasks < c.folders, 'tasks are fewer than folders while any task has two folders');
  assert.ok(c.tasks >= names.counts.distinctTasks,
    'never fewer tasks than distinct declared names: a CK folder is kept apart, never merged');

  const isPerson = o => /@turing\.com$/i.test(o || '') && !/^companybench@/i.test(o || '');
  rows.filter(r => r.deliveredSibling).forEach(r => {
    const mine = r.owner || (cohort.folders[r.cohortFolder] || {}).owner;
    const theirs = r.deliveredSibling.owner;
    assert.ok(!isPerson(mine) || !isPerson(theirs) || mine === theirs,
      `${r.cohortFolder}: delivered through another folder must never join two different people`);
  });

  // No folder whose task already went out may sit in Ready without a warning.
  const gone = new Set(rows.filter(r => r.deliveredSibling).map(r => r.cohortFolder));
  const ready = filterTruth(model.rows, {delivered: 'ready'}).rows;
  const silent = ready.filter(r => (gone.has(r.name) || (r.otherVersions || []).some(o => gone.has(o.name))) &&
    !(r.maybeDelivered || r.sameNameDelivered));
  assert.deepStrictEqual(silent.map(r => r.name), [],
    'an already-delivered task must not be offered as ready without a warning');

  console.log(`accepted: ${c.folders} folders -> ${c.tasks} tasks; ${c.delivered} delivered ` +
    `(${c.deliveredViaSibling} folders through another folder), ${c.toDeliver} to deliver, ` +
    `${c.toDeliverNeedsCheck} carrying CK`);
}

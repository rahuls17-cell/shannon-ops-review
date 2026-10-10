const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {prepareDeliveryAudit, filterDeliveryAudit, deliveryManifest, UNSET} = require('../delivery-audit.js');

const base = {
  generatedAt: '2026-09-19T00:00:00+00:00',
  dataGeneratedAt: '2026-09-09T19:02:33',
  statusGeneratedAt: '2026-09-11T08:52:02.217Z',
  summary: {total: 4},
  rows: [
    {id: 'T1', task: 'alpha', batch: 'Batch 1', category: 'Code', type: 'Connector',
     difficulty: 'Harder', glm: 3, bucket: '3/4', trainer: 'a@t.com', source: 'Accepted portal',
     sha: 'aa', size_mb: 10, connectors: ['notion-gym'], priority: 'High',
     acceptance: 'Accepted', ambiguous: false, unverified: false, version_dependent: false},
    {id: 'T2', task: 'beta', batch: 'Batch 1', category: 'Code', type: 'Non-connector',
     difficulty: 'Easier', glm: 0, bucket: '0/4', trainer: 'Unattributed', source: 'Unattributed',
     sha: 'bb', size_mb: 5, connectors: [], priority: null,
     acceptance: 'Pending', ambiguous: false, unverified: false, version_dependent: false},
    {id: 'T3', task: 'gamma', batch: 'Batch 2', category: 'Health', type: 'Non-connector',
     difficulty: 'Harder', glm: 2, bucket: '2/4', trainer: 'b@t.com', source: 'Contested',
     sha: 'cc', size_mb: 2, connectors: [], priority: 'Low',
     acceptance: 'Rejected', ambiguous: true, unverified: true, version_dependent: false},
    {id: 'T4', task: 'delta', batch: 'Batch 2', category: 'Health', type: 'Non-connector',
     difficulty: 'Harder', glm: null, bucket: null, trainer: 'a@t.com', source: 'Trainer records',
     sha: 'dd', size_mb: null, connectors: [], priority: 'High',
     acceptance: 'Accepted', ambiguous: false, unverified: false, version_dependent: true},
  ],
};

const model = prepareDeliveryAudit(base);
assert.equal(model.rows.length, 4);
assert.throws(() => prepareDeliveryAudit(null), /No delivery audit/);

// The literal string "Unattributed" must not read as a trainer. Counting it as
// one made the page report 0 unattributed against a source that said 12.
assert.equal(model.rows[1].trainer, null);
assert.equal(model.rows[0].trainer, 'a@t.com');

const all = filterDeliveryAudit(model.rows, {});
assert.equal(all.attributed, 3);
assert.equal(all.rows.length - all.attributed, 1);
assert.equal(all.trainers, 2);
assert.ok(!Object.keys(all.byTrainer).includes('Unattributed'));
assert.equal(all.byTrainer[UNSET], 1);

assert.equal(all.accepted, 2);
assert.equal(all.rejected, 1);
assert.equal(all.pending, 1);
assert.equal(all.accepted + all.rejected + all.pending, model.rows.length);
assert.equal(all.connectors, 1);
assert.equal(all.harder, 3);
assert.equal(all.flagged, 2);
assert.equal(all.megabytes, 17);

// A missing GLM score becomes a labelled bucket, never a blank or a zero.
assert.equal(model.rows[3].glmBucket, UNSET);
assert.equal(all.byGlm[UNSET], 1);
assert.equal(all.byGlm['3/4'], 1);

// Filters
assert.equal(filterDeliveryAudit(model.rows, {batch: 'Batch 1'}).rows.length, 2);
assert.equal(filterDeliveryAudit(model.rows, {type: 'Connector'}).rows.length, 1);
assert.equal(filterDeliveryAudit(model.rows, {difficulty: 'Harder'}).rows.length, 3);
assert.equal(filterDeliveryAudit(model.rows, {glm: '2/4'}).rows.length, 1);
assert.equal(filterDeliveryAudit(model.rows, {acceptance: 'Accepted'}).rows.length, 2);
assert.equal(filterDeliveryAudit(model.rows, {priority: UNSET}).rows.length, 1);
assert.equal(filterDeliveryAudit(model.rows, {trainer: 'a@t.com'}).rows.length, 2);
assert.equal(filterDeliveryAudit(model.rows, {trainer: UNSET}).rows.length, 1);
assert.equal(filterDeliveryAudit(model.rows, {flagged: 'yes'}).rows.length, 2);
assert.equal(filterDeliveryAudit(model.rows, {flagged: 'no'}).rows.length, 2);
assert.equal(filterDeliveryAudit(model.rows, {search: 'GAMMA'}).rows.length, 1);
assert.equal(filterDeliveryAudit(model.rows, {search: 'dd'}).rows.length, 1);  // sha is searchable

// --- against the published asset ----------------------------------------
const asset = path.join(__dirname, '..', 'assets', 'delivery-audit.json');
if (fs.existsSync(asset)) {
  const live = prepareDeliveryAudit(JSON.parse(fs.readFileSync(asset, 'utf8')));
  const shown = filterDeliveryAudit(live.rows, {});
  const s = live.summary;
  assert.equal(live.rows.length, s.total, 'row count must match the source summary');
  // The workbook's unattributed rows are either still unattributed, or were
  // filled from the GCS verdicts. The two together must still equal what the
  // workbook reported, or attribution has been invented or lost.
  const stillMissing = live.rows.filter(r => !r.trainer).length;
  const filledFromVerdicts = live.rows.filter(
    r => r.resolvedFromPipeline &&
      String(r.trainerFromWorkbook || '').toLowerCase() === 'unattributed').length;
  assert.equal(stillMissing + filledFromVerdicts, s.unattributed,
    'unattributed, plus those filled from verdicts, must match the source summary');
  // Nothing may be resolved where the pipeline names more than one owner.
  for (const r of live.rows) {
    if (r.resolvedFromPipeline) {
      assert.ok(r.trainer, 'a resolved row must carry an owner');
      assert.equal((r.pipelineOwners || []).length, 0,
        'a row with several pipeline owners must not be resolved');
    }
  }
  assert.equal(shown.accepted + shown.rejected + shown.pending, live.rows.length,
    'acceptance must partition the population');
  for (const [state, n] of Object.entries(s.acceptance || {})) {
    assert.equal(shown.byAcceptance[state], n, `acceptance ${state} disagrees with the summary`);
  }
  console.log(`published: ${live.rows.length} tasks / ${shown.accepted} accepted, ` +
    `${shown.rejected} rejected, ${shown.pending} pending / ${shown.trainers} trainers, ` +
    `${shown.rows.length - shown.attributed} unattributed / ${shown.connectors} connector`);
  console.log(`  attribution: ${shown.resolvedFromPipeline} filled from GCS verdicts, ` +
    `${live.rows.filter(r => (r.pipelineOwners || []).length > 1).length} left contested`);
  console.log(`  data built ${live.dataGeneratedAt}, status ${live.statusGeneratedAt.slice(0, 10)}`);
}
// Drive batches join the audit without replacing any of it.
{
  const drive = {
    generatedAt: '2026-09-29T00:00:00+00:00', batches: [{batch: 'Batch 5.1', tasks: 2}],
    skipped: [{name: '10-01 Batch 10.1', reason: 'no manifest.json at the top of the folder'}],
    rows: [
      {id: 'B51-001', task: 'epsilon', packageName: 'harbor-name', batch: 'Batch 5.1',
       category: 'Connector', type: 'Connector', difficulty: 'Easier', glm: 3, bucket: '3/4',
       trainer: 'Unattributed', source: 'Delivery manifest', acceptance: 'Pending', connectors: []},
      {id: 'B51-002', task: 'zeta', batch: 'Batch 5.1', category: 'Company Bench Zeta',
       type: 'Connector', difficulty: null, glm: null, bucket: null,
       trainer: 'Unattributed', source: 'Delivery manifest', acceptance: 'Pending', connectors: []},
      // A batch the audit already covers must never be taken from Drive too.
      {id: 'B1-001', task: 'alpha-again', batch: 'Batch 1', trainer: 'Unattributed', acceptance: 'Pending'},
    ],
  };
  const merged = prepareDeliveryAudit(base, drive);
  assert.equal(merged.rows.length, base.rows.length + 2, 'Drive rows are added, audited batches are not');
  assert.equal(merged.auditedCount, base.rows.length);
  assert.equal(merged.drive.rows, 2);
  assert.equal(merged.drive.skipped.length, 1, 'skipped folders reach the page');
  const r = filterDeliveryAudit(merged.rows, {batch: 'Batch 5.1'});
  assert.equal(r.rows.length, 2);
  assert.equal(r.pending, 2, 'a manifest records no decision');
  assert.equal(r.attributed, 0, 'a manifest names no trainer');
  assert.equal(r.byGlm[UNSET], 1, 'no trials recorded reads as not recorded, not 0/4');
  assert.equal(filterDeliveryAudit(merged.rows, {search: 'harbor-name'}).rows.length, 1,
    'search reaches the package name');
  assert.equal(prepareDeliveryAudit(base, null).rows.length, base.rows.length,
    'without the Drive asset the audit still loads');
}

// One domain, one bar: the audit's names and the manifests' collapse together.
{
  const {mergedCategory} = require('../delivery-audit.js');
  const pairs = [['Code', 'Engineering'], ['Non-Connector · Engineering', 'Engineering'],
    ['Law', 'Legal'], ['Non-Connector · Legal', 'Legal'], ['Other/unclassified', 'Other'],
    ['General', 'Other'], ['Non-Connector · Other', 'Other'], ['Health', 'Health'],
    ['Non-Connector · Health', 'Health'], ['Company Bench Zeta', 'CompanyBench'],
    ['Real Connector', 'Real Connector'], ['Synthetic', 'Synthetic'], ['Connector', 'Connector']];
  for (const [from, to] of pairs) assert.equal(mergedCategory(from), to, `${from} should read as ${to}`);
  const merged = prepareDeliveryAudit(base);
  assert.deepEqual(filterDeliveryAudit(merged.rows, {}).byCategory, {Engineering: 2, Health: 2});
  assert.equal(merged.rows[0].categoryOriginal, 'Code', 'the row keeps what its source called it');
  assert.equal(filterDeliveryAudit(merged.rows, {category: 'Engineering'}).rows.length, 2,
    'the filter uses the merged name');
}

// Trainers for Drive rows come from the owner index, never from the manifest.
{
  const drive = {rows: [
    {id: 'B51-001', task: 'a', batch: 'Batch 5.1', trainer: 'Unattributed', source: 'Delivery manifest', acceptance: 'Pending'},
    {id: 'B51-002', task: 'b', batch: 'Batch 5.1', trainer: 'Unattributed', source: 'Delivery manifest', acceptance: 'Pending'},
    {id: 'B51-003', task: 'c', batch: 'Batch 5.1', trainer: 'Unattributed', source: 'Delivery manifest', acceptance: 'Pending'},
  ], batches: [], skipped: []};
  const owners = {generatedAt: 't', owners: {
    'B51-001': {trainer: 'one@turing.com', source: 'GCS trainer records', route: 'records'},
    'B51-002': {trainer: null, source: 'Contested', route: 'records', candidates: ['x@turing.com', 'y@turing.com']},
  }};
  const live = prepareDeliveryAudit(base, drive, owners);
  const byId = Object.fromEntries(live.rows.map(r => [r.id, r]));
  assert.equal(byId['B51-001'].trainer, 'one@turing.com');
  assert.equal(byId['B51-001'].source, 'GCS trainer records', 'the row says where its trainer came from');
  assert.equal(byId['B51-002'].trainer, null, 'a contested row names nobody');
  assert.deepEqual(byId['B51-002'].ownerCandidates, ['x@turing.com', 'y@turing.com']);
  assert.deepEqual(byId['B51-002'].flags, ['contested owner'], 'contested is flagged once');
  assert.equal(byId['B51-003'].trainer, null, 'a row the index does not name stays Unattributed');
  assert.equal(live.drive.owners.attributed, 1);
  assert.equal(live.drive.owners.contested, 1);
  assert.equal(byId.T1.trainer, 'a@t.com', 'audited rows are never touched by the owner index');
}

// The published pair: every Drive batch is new to the audit.
const driveAsset = path.join(__dirname, '..', 'assets', 'drive-deliveries.json');
if (fs.existsSync(driveAsset) && fs.existsSync(asset)) {
  const live = prepareDeliveryAudit(JSON.parse(fs.readFileSync(asset, 'utf8')),
    JSON.parse(fs.readFileSync(driveAsset, 'utf8')));
  const all = filterDeliveryAudit(live.rows, {});
  assert.equal(live.rows.length, live.auditedCount + live.drive.rows, 'no Drive row was dropped');
  console.log(`with Drive: ${live.rows.length} tasks in ${Object.keys(all.byBatch).length} batches ` +
    `(${live.auditedCount} audited + ${live.drive.rows} from manifests)`);
}
// --- the Delivery tab's manifest.json export ---------------------------------
// One entry per package shown, restated from its batch manifest, batch order
// then manifest order; a task in two batches stays two entries; no trainer.
{
  const pkg = (id, batch, over) => Object.assign({
    id, batch, task: `t-${id}`, taskName: `harbor/t-${id}`, packagePath: `Non-Connector/Harder/Other/t-${id}.zip`,
    class: 'Non-Connector', category: 'Non-Connector · Other', type: 'Non-connector', bench: 'computer',
    difficulty: 'Harder', glm: 2, glmModel: 'pplx/glm-5.3', connectors: [], trainer: 'a@t.com',
    sha256: 'f'.repeat(64), sizeBytes: 1000, sourceObject: 'abc', sourceUri: 'gs://b/t.zip',
  }, over);
  const shown = [
    pkg('B10.1-002', 'Batch 10.1'),
    pkg('B9.1-010', 'Batch 9.1', {task: 'same', taskName: 'harbor/same'}),
    pkg('B10.1-001', 'Batch 10.1', {task: 'same', taskName: 'harbor/same', type: 'Connector',
      bench: 'company', class: 'CompanyBench', connectors: ['zeta-gym'], harness: 'zeta', sha256: null, sizeBytes: null}),
  ];
  const order = (a, b) => parseFloat(a.replace(/[^\d.]/g, '')) - parseFloat(b.replace(/[^\d.]/g, ''));
  const m = deliveryManifest(shown, {batchOrder: order, generatedAt: '2026-10-06T08:00:00Z',
    batches: [{batch: 'Batch 9.1', folder: 'ComputerBench/09-29 Batch 9.1 (NC 297)'}]});
  assert.equal(m.schema, 'harbor/delivery-manifest/v4');
  assert.equal(m.generated_at_ist, '20261006-133000', 'IST, written as the batch manifests write it');
  assert.deepEqual(m.tasks.map(t => t.batch + ' ' + t.task_id), ['Batch 9.1 t-B9.1-010', 'Batch 10.1 t-B10.1-001', 'Batch 10.1 t-B10.1-002'].map(s => s.replace('t-B9.1-010', 'same').replace('t-B10.1-001', 'same')),
    'batch order, then manifest order');
  assert.equal(m.tasks.filter(t => t.task_name === 'harbor/same').length, 2, 'a task delivered twice is two entries');
  assert.equal(m.batch, 'All batches');
  assert.equal(m.summary.tasks, 3);
  assert.deepEqual(m.summary.by_bench, {'Computer Bench': 2, 'Company Bench': 1});
  assert.equal(m.summary.total_bytes, 2000);
  assert.equal(m.summary.without_checksum, 1, 'a package with no checksum is counted, not invented');
  assert.equal(m.tasks[1].harness, 'zeta');
  assert.deepEqual(m.tasks[1].connector_services, [{name: 'zeta-gym'}]);
  assert.equal(m.tasks[0].original_filename, 't-B9.1-010.zip');
  assert.equal(m.tasks[0].trial_evidence.successes, 2);
  assert.ok(!JSON.stringify(m).includes('a@t.com'), 'no trainer in a delivery manifest');
  const one = deliveryManifest(shown.filter(r => r.batch === 'Batch 9.1'), {batchOrder: order, scope: 'Batch 9.1',
    batches: [{batch: 'Batch 9.1', folder: 'ComputerBench/09-29 Batch 9.1 (NC 297)'}]});
  assert.equal(one.batch, 'Batch 9.1');
  assert.equal(one.drive_batch, '09-29 Batch 9.1 (NC 297)');

  // The published Drive rows carry everything an entry restates.
  const drivePath = path.join(__dirname, '..', 'assets', 'drive-deliveries.json');
  if (fs.existsSync(drivePath)) {
    const drive = JSON.parse(fs.readFileSync(drivePath, 'utf8'));
    const full = deliveryManifest(drive.rows, {batches: drive.batches});
    assert.equal(full.tasks.length, drive.rows.length);
    assert.equal(full.summary.without_checksum, 0, 'every Drive package keeps its full sha256');
    assert.ok(full.tasks.every(t => t.package_path && Number.isInteger(t.size_bytes)));
  }
}
console.log('delivery audit checks passed: attribution, partition, buckets, filters, manifest export');

// --- the trainer credit sheet ------------------------------------------------
// Same spellings as tools/test_trainer_sheet.py; fills only rows the bucket
// cannot settle, never replaces a trainer it names.
{
  const {sheetVariants, trainerSheetKeys} = require('../delivery-audit.js');
  const cases = {
    'harbor/task_verify_vip_account_8241_interest_fixed.zip': 'verify-vip-account-8241-interest',
    '100601-august-2024-interest-calculation-payout-r-4457f3-v9': 'august-2024-interest-calculation-payout-r',
    'audit-missing-due-dates-on-linked-bill-counterpa-8b8b51-v1': 'audit-missing-due-dates-on-linked-bill-counterpa',
    'seven-urgent-messages-the-filter-buried.zip': 'seven-urgent-messages-the-filter-buried',
  };
  Object.entries(cases).forEach(([raw, expected]) =>
    assert.ok(sheetVariants(raw).includes(expected), `${raw} -> ${expected}`));
  assert.deepEqual(sheetVariants('abc'), []);
  assert.ok(trainerSheetKeys({packageName: '100601-august-2024-interest-4457f3-v9'}).includes('tt:100601'));
  assert.ok(trainerSheetKeys({packageName: 'ASTR_101554'}).includes('tt:astr_101554'));

  const drive = {rows: [
    {id: 'D-1', batch: 'CompanyBench 9', task: 'one-task-name', bench: 'company', trainer: 'Unattributed'},
    {id: 'D-2', batch: 'CompanyBench 9', task: 'two-task-name', bench: 'company', trainer: 'Unattributed'},
    {id: 'D-3', batch: 'CompanyBench 9', task: 'three-task-name', bench: 'company', trainer: 'Unattributed'},
    {id: 'D-4', batch: 'CompanyBench 9', task: 'four-task-name', bench: 'company', trainer: 'Unattributed'},
  ]};
  const owners = {owners: {
    'D-2': {trainer: null, source: 'Contested', route: 'records', candidates: ['a@t.com', 'b@t.com']},
    'D-3': {trainer: 'c@t.com', source: 'GCS trainer records', route: 'records'},
  }};
  const sheet = {entries: [
    {tab: 'zeta', trainer: 's@t.com', keys: ['one-task-name']},
    {tab: 'zeta', trainer: 'b@t.com', keys: ['two-task-name']},
    {tab: 'zeta', trainer: 's@t.com', keys: ['three-task-name']},
    {tab: 'zeta', trainer: 'x@t.com', keys: ['four-task-name']},
    {tab: 'aster', trainer: 'y@t.com', keys: ['four-task-name']},
  ]};
  const got = prepareDeliveryAudit({...base, rows: []}, drive, owners, sheet);
  const by = Object.fromEntries(got.rows.map(r => [r.id, r]));
  assert.equal(by['D-1'].trainer, 's@t.com', 'unattributed takes the sheet trainer');
  assert.equal(by['D-1'].source, 'Trainer credit sheet');
  assert.equal(by['D-2'].trainer, 'b@t.com', 'contested is settled by the sheet');
  assert.deepEqual(by['D-2'].contestedBefore, ['a@t.com', 'b@t.com']);
  assert.ok(!by['D-2'].flags.includes('contested owner'));
  assert.equal(by['D-3'].trainer, 's@t.com', 'for Company Bench the sheet replaces the bucket trainer');
  assert.equal(by['D-3'].bucketTrainer, 'c@t.com', 'and the replaced trainer is kept on the row');
  assert.equal(by['D-4'].trainer, null, 'two sheet trainers settle nothing');
  assert.equal(got.drive.sheet.filled, 3);
  const computer = prepareDeliveryAudit({...base, rows: []},
    {rows: [{...drive.rows[2], bench: 'computer'}]}, owners, sheet);
  assert.equal(computer.rows[0].trainer, 'c@t.com', 'a Computer Bench trainer the bucket names is kept');

  // The published files: every row the sheet fills was unsettled before, and
  // the count agrees with the builder's when both read the same owner index.
  const root = path.join(__dirname, '..');
  const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
  if (fs.existsSync(path.join(root, 'assets', 'trainer-sheet.json'))) {
    const live = read('drive-deliveries.json'), liveOwners = read('drive-owners.json'), liveSheet = read('trainer-sheet.json');
    const after = prepareDeliveryAudit({...base, rows: []}, live, liveOwners, liveSheet);
    const filled = after.rows.filter(r => r.trainerRoute === 'sheet');
    assert.ok(filled.every(r => r.bench === 'company' || !(liveOwners.owners[r.id] || {}).trainer),
      'outside Company Bench only unsettled rows are filled');
    if (liveSheet.ownersGeneratedAt === liveOwners.generatedAt) {
      const expected = Object.entries(liveSheet.coverage).filter(([k]) => k.endsWith(':filled') || k.endsWith(':replaced'))
        .reduce((n, [, v]) => n + v, 0);
      assert.equal(filled.length, expected, 'the page and the builder fill the same rows');
    }
    console.log(`trainer sheet: ${filled.length} Drive rows filled from the sheet`);
  }
}
console.log('trainer sheet checks passed');

// --- the hand-reviewed trainer table ------------------------------------------
// A reviewed task takes the review's trainer ahead of the sheet and the bucket;
// a review with no trainer leaves the task without one.
{
  const drive = {rows: [
    {id: 'R-1', batch: 'Batch 9', task: 'reviewed-contested-task', bench: 'company', trainer: 'Unattributed'},
    {id: 'R-2', batch: 'Batch 9', task: 'reviewed-named-task', bench: 'computer', trainer: 'Unattributed'},
    {id: 'R-3', batch: 'Batch 9', task: 'reviewed-no-trainer-task', bench: 'company', trainer: 'Unattributed'},
    {id: 'R-4', batch: 'Batch 8', task: 'reviewed-named-task', bench: 'computer', trainer: 'Unattributed'},
  ]};
  const owners = {owners: {
    'R-1': {trainer: null, source: 'Contested', route: 'records', candidates: ['a@t.com', 'b@t.com']},
    'R-2': {trainer: 'c@t.com', source: 'GCS trainer records', route: 'records'},
  }};
  const sheet = {entries: [{tab: 'zeta', trainer: 's@t.com', keys: ['reviewed-contested-task']}]};
  const review = {entries: [
    {task: 'reviewed-contested-task', batch: 'Batch 9', trainer: 'r@t.com', confidence: 'High'},
    {task: 'reviewed-named-task', batch: 'Batch 9', trainer: 'q@t.com', confidence: 'Low'},
    {task: 'reviewed-no-trainer-task', batch: 'Batch 9', trainer: null, trainerType: 'In-house / DataOS (leads)'},
  ]};
  const got = prepareDeliveryAudit({...base, rows: []}, drive, owners, sheet, review);
  const by = Object.fromEntries(got.rows.map(r => [r.id, r]));
  assert.equal(by['R-1'].trainer, 'r@t.com', 'the review comes before the sheet');
  assert.equal(by['R-1'].source, 'Trainer review');
  assert.deepEqual(by['R-1'].contestedBefore, ['a@t.com', 'b@t.com']);
  assert.equal(by['R-2'].trainer, 'q@t.com', 'and before the bucket, on either bench');
  assert.equal(by['R-2'].bucketTrainer, 'c@t.com');
  assert.equal(by['R-3'].trainer, null, 'a review with no trainer names none');
  assert.equal(by['R-3'].reviewedNoTrainer, 'In-house / DataOS (leads)');
  assert.equal(by['R-4'].trainer, null, 'a review is for its own batch only');
  assert.deepEqual(got.drive.review, {generatedAt: undefined, named: 2, noTrainer: 1});

  // The published review lands on the published Drive rows, every entry on one row.
  const root = path.join(__dirname, '..');
  const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
  if (fs.existsSync(path.join(root, 'assets', 'trainer-review.json'))) {
    const live = read('trainer-review.json');
    const after = prepareDeliveryAudit({...base, rows: []}, read('drive-deliveries.json'), read('drive-owners.json'),
      read('trainer-sheet.json'), live);
    const named = live.entries.filter(e => e.trainer);
    assert.equal(after.rows.filter(r => r.trainerRoute === 'review').length, named.length, 'every reviewed trainer lands');
    assert.equal(after.rows.filter(r => r.reviewedNoTrainer).length, live.entries.length - named.length);
    console.log(`trainer review: ${named.length} tasks named, ${live.entries.length - named.length} reviewed as having no trainer`);
  }
}
console.log('trainer review checks passed');

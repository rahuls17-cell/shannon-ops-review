const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {prepareDeliveryAudit, filterDeliveryAudit, UNSET} = require('../delivery-audit.js');

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
console.log('delivery audit checks passed: attribution, partition, buckets, filters');

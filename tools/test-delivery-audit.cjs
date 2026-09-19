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
console.log('delivery audit checks passed: attribution, partition, buckets, filters');

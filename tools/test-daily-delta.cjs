const assert = require('node:assert/strict');
const {prepareDelta, filterDelta} = require('../daily-delta.js');
const {prepareTruth} = require('../truth.js');

// --- shape and guards ---------------------------------------------------
assert.throws(() => prepareDelta(null), /No pipeline truth/);
assert.throws(() => prepareDelta({}), /No pipeline truth/);

const model = prepareTruth({
  generatedAt: '2026-09-18T06:00:00+00:00',
  cut: '2026-09-05',
  reconciles: true,
  vocabulary: {finalState: {rejected: 2, accepted: 2, running: 1}},
  figures: [],
  tasks: [
    {id: 'a', state: 'accepted', decided: '2026-09-10', decidedInferred: false},
    {id: 'b', state: 'accepted', decided: '2026-09-10', decidedInferred: true},
    {id: 'c', state: 'rejected', decided: '2026-09-11', decidedInferred: false},
    {id: 'd', state: 'rejected', decided: '2026-09-12', decidedInferred: false},
    {id: 'e', state: 'running',  decided: '2026-09-12', decidedInferred: false},
    {id: 'f', state: 'accepted', decided: '',           decidedInferred: false}, // undated
  ],
});
const prepared = prepareDelta(model);

// the undated row is skipped, and reported rather than dropped silently
assert.equal(prepared.events.length, 5);
assert.equal(prepared.undated, 1);
// legend order follows the published vocabulary, not insertion or alphabet
assert.deepEqual(prepared.states, ['rejected', 'accepted', 'running']);

const all = filterDelta(prepared, {});
assert.deepEqual(all.days, ['2026-09-10', '2026-09-11', '2026-09-12']);
assert.equal(all.tasks, 5);
// an inferred date is counted but flagged
assert.equal(all.inferred, 1);
assert.equal(all.totals.accepted, 2);
assert.equal(all.totals.rejected, 2);
// series are dense, so the chart needs no gap handling
for (const state of all.states) {
  for (const date of all.days) assert.equal(typeof all.series[state][date], 'number');
}
assert.equal(all.series.accepted['2026-09-10'], 2);
assert.equal(all.series.accepted['2026-09-12'], 0);
assert.equal(all.peak.accepted.date, '2026-09-10');
assert.equal(all.peak.accepted.count, 2);

// --- filters ------------------------------------------------------------
const oneDay = filterDelta(prepared, {start: '2026-09-12', end: '2026-09-12'});
assert.deepEqual(oneDay.days, ['2026-09-12']);
assert.equal(oneDay.tasks, 2);

const oneState = filterDelta(prepared, {state: 'accepted'});
assert.deepEqual(oneState.states, ['accepted']);
assert.equal(oneState.tasks, 2);

const backwards = filterDelta(prepared, {start: '2026-09-12', end: '2026-09-10'});
assert.equal(backwards.invalidDates, true);
assert.equal(backwards.tasks, 0);
assert.deepEqual(backwards.days, []);

// --- against the real asset: must reconcile with the published counts ----
const fs = require('node:fs');
const path = require('node:path');
const assetPath = path.join(__dirname, '..', 'assets', 'pipeline-truth.json');
if (fs.existsSync(assetPath)) {
  const raw = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
  const live = filterDelta(prepareDelta(prepareTruth(raw)), {});
  // The delta must not invent or lose work: it tallies the same population the
  // ingest chain published, so every state total has to match exactly.
  assert.equal(live.tasks, raw.counts.inScope,
    `delta counted ${live.tasks} tasks, asset says ${raw.counts.inScope}`);
  for (const [state, count] of Object.entries(raw.counts.states)) {
    assert.equal(live.totals[state] || 0, count, `state ${state} disagrees with the asset`);
  }
}

console.log('test-daily-delta: all assertions passed');

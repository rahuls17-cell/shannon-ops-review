const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {prepareTruth, filterTruth, chainFor} = require('../truth.js');

const base = {
  generatedAt: '2026-09-17T17:00:00+00:00',
  cut: '2026-09-05',
  bucket: 'gs://obi-harbor-pipeline',
  reconciles: true,
  figures: [
    {label: 'Accepted', value: 2, note: 'n', steps: [
      {step: 'verdict objects', count: 10}, {step: 'in scope', count: 5},
      {step: 'accepted', count: 3}, {step: 'at the current bar', count: 2}]},
  ],
  vocabulary: {finalState: {accepted: 2, rejected: 1}},
  tasks: [
    {id: 'f:1', name: 'alpha', state: 'accepted', why: 'at the bar', owner: 'a@t.com',
     decided: '2026-09-10', decidedInferred: false, runs: 2, carriedOver: true,
     atCurrentBar: true, gateOnly: false, gateEra: 'KESTREL full', domain: 'General',
     connector: true, findings: ['HARBOR-CHECK'], cohorts: ['iteration_2'],
     confidence: 'high', unmerged: false, canonicalReason: 'only run', source: 'x.json'},
    {id: 'f:2', name: 'beta', state: 'accepted', why: 'grace', owner: 'b@t.com',
     decided: '2026-09-12', decidedInferred: true, runs: 1, carriedOver: false,
     atCurrentBar: true, gateOnly: false, gateEra: 'KESTREL full', domain: 'Legal',
     connector: false, findings: [], cohorts: ['iteration_2'],
     confidence: 'low', unmerged: true, canonicalReason: 'only run', source: 'y.json'},
    {id: 'f:3', name: 'gamma', state: 'legacy accepted', why: 'gate only', owner: 'a@t.com',
     decided: '2026-09-14', decidedInferred: false, runs: 3, carriedOver: false,
     atCurrentBar: false, gateOnly: true, gateEra: 'GLM-5.2 gate only', domain: 'General',
     connector: null, findings: ['DIFFICULTY-GLM-TOO-EASY'], cohorts: ['glm52_gate_only'],
     confidence: 'high', unmerged: false, canonicalReason: 'better outcome', source: 'z.json'},
    {id: 'f:4', name: 'delta', state: 'error', why: 'parked', owner: 'c@t.com',
     decided: '2026-09-15', decidedInferred: true, runs: 1, carriedOver: false,
     atCurrentBar: false, gateOnly: false, gateEra: 'KESTREL on', domain: 'Not recorded',
     connector: null, findings: [], cohorts: [], confidence: 'low', unmerged: true,
     canonicalReason: 'only run', source: 'w.json'},
  ],
};

const model = prepareTruth(base);
assert.equal(model.rows.length, 4);
assert.equal(model.figures.get('Accepted').value, 2);

// A payload that failed its own reconciliation must never render.
assert.throws(() => prepareTruth({...base, reconciles: false}), /reconciliation/);
assert.throws(() => prepareTruth(null), /No pipeline truth/);

const all = filterTruth(model.rows, {});
assert.equal(all.accepted, 2);
assert.equal(all.legacyAccepted, 1);
assert.equal(all.undecided, 1);          // error counts as undecided, not rejected
assert.equal(all.rejected, 0);
assert.equal(all.carriedOver, 1);
assert.equal(all.gateOnly, 1);
assert.equal(all.atCurrentBar, 2);
assert.equal(all.unmerged, 2);
assert.equal(all.inferredDates, 2);
assert.equal(all.owners, 3);

// Every bucket is disjoint and together they cover the population.
assert.equal(all.accepted + all.legacyAccepted + all.rejected + all.running + all.undecided,
             model.rows.length);

// Filters
assert.equal(filterTruth(model.rows, {state: 'accepted'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {gateEra: 'KESTREL full'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {owner: 'a@t.com'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {finding: 'HARBOR-CHECK'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {cohort: 'glm52_gate_only'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {delivery: 'current'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {delivery: 'gateOnly'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {delivery: 'none'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {carriedOver: 'yes'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {carriedOver: 'no'}).rows.length, 3);
assert.equal(filterTruth(model.rows, {confidence: 'low'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {connector: 'yes'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {connector: 'no'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {connector: 'unknown'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {search: 'GAMMA'}).rows.length, 1);
assert.equal(filterTruth(model.rows, {start: '2026-09-13'}).rows.length, 2);
assert.equal(filterTruth(model.rows, {start: '2026-09-14', end: '2026-09-14'}).rows.length, 1);

// An empty carriedOver filter must not be read as "no".
assert.equal(filterTruth(model.rows, {carriedOver: ''}).rows.length, 4);

// A chain is only honest for the unfiltered population.
assert.equal(chainFor(model, 'Accepted', false).stale, false);
assert.equal(chainFor(model, 'Accepted', true).stale, true);
assert.equal(chainFor(model, 'Nonexistent', false), null);
const steps = chainFor(model, 'Accepted', false).steps.map(s => s.count);
assert.deepEqual(steps, [10, 5, 3, 2]);
assert.ok(steps.every((n, i) => i === 0 || steps[i - 1] >= n), 'a chain may never grow');

// --- against the published asset, when it is present ----------------------
const asset = path.join(__dirname, '..', 'assets', 'pipeline-truth.json');
if (fs.existsSync(asset)) {
  const live = prepareTruth(JSON.parse(fs.readFileSync(asset, 'utf8')));
  const shown = filterTruth(live.rows, {});
  const total = shown.accepted + shown.legacyAccepted + shown.rejected +
                shown.running + shown.undecided;
  assert.equal(total, live.rows.length, 'published states must partition the population');
  for (const [label, value] of [['Accepted', shown.accepted],
                                ['Legacy accepted', shown.legacyAccepted],
                                ['Rejected', shown.rejected],
                                ['Running', shown.running],
                                ['Carried over', shown.carriedOver]]) {
    assert.equal(live.figures.get(label).value, value,
                 `${label}: figure disagrees with the rows`);
  }
  for (const figure of live.figures.values()) {
    const counts = figure.steps.map(s => s.count);
    assert.ok(counts.every((n, i) => i === 0 || counts[i - 1] >= n),
              `${figure.label}: chain grows`);
    assert.equal(counts.at(-1), figure.value, `${figure.label}: chain misses its value`);
  }
  console.log(`published: ${live.rows.length.toLocaleString()} rows / ` +
    `${shown.accepted} accepted, ${shown.legacyAccepted} legacy, ${shown.rejected} rejected, ` +
    `${shown.undecided} undecided, ${shown.running} running / ${shown.carriedOver} carried over`);
  console.log(`  unmerged identities: ${shown.unmerged} / dates inferred: ${shown.inferredDates}`);
}
console.log('truth checks passed: partition, filters, chains, refusal to render unreconciled data');

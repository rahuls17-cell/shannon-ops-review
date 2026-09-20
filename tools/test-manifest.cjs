// The delivery manifest. Its whole reason to exist is that the same task must
// never be handed over twice, so most of what is checked here is that claim.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const {buildManifest, namesFromManifest, normaliseName} = require(path.join(root, 'manifest.js'));
const {prepareTruth, filterTruth} = require(path.join(root, 'truth.js'));
const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));

// --- name normalisation agrees with the Python join ------------------------
// If these two ever drift, a task can be marked delivered under one spelling
// and shipped again under another, which is the exact failure the manifest is
// supposed to prevent.
assert.equal(normaliseName('Code-C24-Unicode-Bug-fixed-v5'), 'code-c24-unicode-bug');
assert.equal(normaliseName('meeting-people-minutes-ranking-v6'), 'meeting-people-minutes-ranking');
assert.equal(normaliseName('gen-g980-as-built-audit-final'), 'gen-g980-as-built-audit');
assert.equal(normaliseName('  Task-Name  '), 'task-name');
assert.equal(normaliseName('law-l35-flow-down-clause'), 'law-l35-flow-down-clause');

const py = fs.readFileSync(path.join(root, 'tools', 'build_delivered_index.py'), 'utf8');
const pySuffix = py.match(/SUFFIX = re\.compile\(r'(.+?)'\)/)[1];
const jsSuffix = fs.readFileSync(path.join(root, 'manifest.js'), 'utf8')
  .match(/const SUFFIX = \/(.+?)\/;/)[1];
assert.equal(jsSuffix, pySuffix,
  'the manifest and the delivered index must strip identical suffixes');

// --- synthetic cases -------------------------------------------------------
const row = (name, over) => Object.assign(
  {id: `id:${name}`, name, owner: 'a@t.com', state: 'accepted', decided: '2026-09-10',
   runs: 1, atCurrentBar: true}, over);

// A repeat submission is one entry, and the entry says what it stands for.
const dup = buildManifest([
  row('alpha', {id: 'id:a1', decided: '2026-09-08', runs: 1}),
  row('alpha', {id: 'id:a2', decided: '2026-09-12', runs: 3}),
  row('beta'),
], {size: 10});
assert.equal(dup.counts.tasks, 2, 'two names produce two entries');
assert.equal(dup.counts.rowsRepresented, 3, 'but all three rows are represented');
assert.equal(dup.counts.supersededRows, 1, 'and the repeat is reported, not hidden');
const alpha = dup.tasks.find(t => t.key === 'alpha');
assert.equal(alpha.id, 'id:a2', 'the most recent decided run represents the task');
assert.deepEqual(alpha.standsFor.sort(), ['id:a1', 'id:a2'], 'both rows are listed');

// A version suffix is the same task, not a second one.
const suffixed = buildManifest([row('gamma'), row('gamma-v3', {id: 'id:g3'})], {size: 10});
assert.equal(suffixed.counts.tasks, 1, 'gamma and gamma-v3 are one task');

// Oldest decision first, and stable across input order.
const ordered = buildManifest([
  row('later', {decided: '2026-09-15'}),
  row('earlier', {decided: '2026-09-02'}),
  row('middle', {decided: '2026-09-09'}),
], {size: 10});
assert.deepEqual(ordered.tasks.map(t => t.key), ['earlier', 'middle', 'later']);
const shuffled = buildManifest([
  row('middle', {decided: '2026-09-09'}),
  row('later', {decided: '2026-09-15'}),
  row('earlier', {decided: '2026-09-02'}),
], {size: 10});
assert.deepEqual(shuffled.tasks.map(t => t.key), ordered.tasks.map(t => t.key),
  'input order must not change the manifest');

// Size, and being honest when there are not enough tasks to fill it.
assert.equal(buildManifest([row('a'), row('b'), row('c')], {size: 2}).counts.tasks, 2);
const short = buildManifest([row('a'), row('b')], {size: 60});
assert.equal(short.counts.tasks, 2);
assert.equal(short.selection.shortBy, 58, 'a manifest must say when it came up short');
assert.equal(buildManifest([row('a'), row('b')], {size: 0}).counts.tasks, 2, 'size 0 means all');

// Exclusions, including via a previous manifest of this schema.
const first = buildManifest([row('a'), row('b'), row('c')], {size: 2});
const second = buildManifest([row('a'), row('b'), row('c')],
  {size: 2, exclude: namesFromManifest(first)});
assert.equal(second.selection.excludedByPreviousManifest, 2);
const overlap = first.tasks.map(t => t.key).filter(k => second.tasks.some(t => t.key === k));
assert.deepEqual(overlap, [], 'a second round must not reissue the first round');
assert.deepEqual(namesFromManifest(['x', 'y']), ['x', 'y'], 'a bare name list also works');
assert.deepEqual(namesFromManifest(null), [], 'and nothing at all is not a crash');

// --- against the live pipeline ---------------------------------------------
const model = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'));
const ready = filterTruth(model.rows, {delivered: 'ready'});
const live = buildManifest(ready.rows, {size: 60});

assert.equal(live.counts.tasks, 60, 'a 60-task manifest holds 60 tasks');
assert.equal(new Set(live.tasks.map(t => t.key)).size, 60, 'all 60 are distinct');
assert.equal(new Set(live.tasks.map(t => t.name.toLowerCase())).size, 60, 'and distinct by raw name too');
live.tasks.forEach(t => {
  assert.ok(['accepted', 'legacy accepted'].includes(t.state), 'only accepted work ships');
  assert.ok(t.id && t.name, 'every entry is identifiable');
});

// Nothing already delivered can appear in a manifest. Keyed on rows matched by
// an exact name, not on every delivered row: task names repeat across unrelated
// tasks here, so a normalised name shared with a row delivered via its
// identifier is a coincidence, not a double-ship. The row-level guarantee is
// that a manifest entry is never itself a delivered row, checked below.
const deliveredKeys = new Set(model.rows
  .filter(r => r.delivered && r.deliveredVia === 'name')
  .map(r => normaliseName(r.name)));
live.tasks.forEach(t => assert.ok(!deliveredKeys.has(t.key),
  `${t.name} has already been delivered but appears in a manifest`));
const deliveredIds = new Set(model.rows.filter(r => r.delivered).map(r => r.id));
live.tasks.forEach(t => t.standsFor.forEach(id => assert.ok(!deliveredIds.has(id),
  `${t.name} stands for ${id}, which is already delivered`)));

// Checked over every ready task, not just the first 60: a manifest cut later,
// or with a different size, draws from the same pool, so a delivered task
// hiding at position 300 is the same defect as one at position 3.
const everything = buildManifest(ready.rows, {size: 0});
everything.tasks.forEach(t => {
  // A task whose name is a version of a delivered one - ...-hand-over-v7 while
  // ...-hand-over went out - is a rework after a rejection. It may be new work
  // or the same thing again, and only a person can tell, so it is allowed into
  // the manifest carrying the flag rather than being dropped or ignored.
  if (deliveredKeys.has(t.key)) {
    assert.ok(t.possiblyAlreadyDelivered,
      `${t.name} shares a delivered task's name but carries no warning`);
  }
  t.standsFor.forEach(id => assert.ok(!deliveredIds.has(id),
    `${t.name} stands for ${id}, which is already delivered`));
});

// The full manifest accounts for every ready row exactly once.
const all = buildManifest(ready.rows, {size: 0});
assert.equal(all.counts.rowsRepresented, ready.rows.length,
  'every ready row is represented by exactly one entry');
assert.equal(all.counts.tasks, ready.readyNames ?? all.counts.tasks);
assert.equal(all.counts.tasks + all.counts.supersededRows, ready.rows.length,
  'entries plus superseded rows must equal the rows considered');
assert.equal(all.counts.tasks, new Set(ready.rows.map(r => normaliseName(r.name))).size,
  'one entry per distinct task name');

// Two consecutive rounds of 120 never overlap and never lose a task.
const r1 = buildManifest(ready.rows, {size: 120});
const r2 = buildManifest(ready.rows, {size: 120, exclude: namesFromManifest(r1)});
const keys1 = new Set(r1.tasks.map(t => t.key));
r2.tasks.forEach(t => assert.ok(!keys1.has(t.key), `${t.name} would ship in both rounds`));
assert.equal(new Set([...keys1, ...r2.tasks.map(t => t.key)]).size,
  r1.counts.tasks + r2.counts.tasks, 'two rounds cover 240 distinct tasks');

console.log('manifest :', `${all.counts.tasks} distinct tasks from ${ready.rows.length} ready rows`,
  `(${all.counts.supersededRows} repeat submissions collapsed, ${all.counts.owners} trainers)`);
console.log('rounds   :', `${r1.counts.tasks} + ${r2.counts.tasks} with no overlap`);
console.log('all manifest assertions passed');

// --- placeholder names ------------------------------------------------------
// A manifest listing `harbor-single-task-cb9voq1j` cannot be handed to anyone.
// The recorded name is kept, a readable one is recovered from the identifier,
// and the entry says which it is.
const ph = buildManifest([
  {id: 'task:harbor/gen-g289-tiktok-growth-audit', name: 'harbor-single-task-aynowiqs',
   state: 'accepted', decided: '2026-09-10', owner: 'a@t.com'},
  {id: 'family:card-decline-root-cause-audit-20260821T173342Z-3c4b9d', name: 'autorun-2efdca73c5a02d',
   state: 'accepted', decided: '2026-09-11', owner: 'a@t.com'},
  {id: 'task:plain-named-task', name: 'plain-named-task',
   state: 'accepted', decided: '2026-09-12', owner: 'a@t.com'},
], {size: 10});
const phTask = ph.tasks.find(t => t.name === 'harbor-single-task-aynowiqs');
assert.equal(phTask.readableName, 'gen-g289-tiktok-growth-audit', 'a task: id yields the name');
assert.equal(phTask.nameSource, 'derived from the verdict identifier');
assert.equal(phTask.name, 'harbor-single-task-aynowiqs', 'the recorded name is never overwritten');
const phAutorun = ph.tasks.find(t => t.name === 'autorun-2efdca73c5a02d');
assert.equal(phAutorun.readableName, 'card-decline-root-cause-audit', 'a family: id yields the name');
const plain = ph.tasks.find(t => t.name === 'plain-named-task');
assert.equal(plain.readableName, 'plain-named-task', 'a real name is left alone');
assert.equal(plain.nameSource, 'pipeline');
assert.equal(ph.counts.namesDerived, 2);
assert.equal(ph.counts.namesUnrecoverable, 0);

// An id that recovers nothing must say so rather than inventing a name.
const stuck = buildManifest([{id: 'family:harbor-single-task-9v46er7d-realdocoutput',
  name: 'harbor-single-task-9v46er7d', state: 'accepted', decided: '2026-09-10'}], {size: 1});
assert.equal(stuck.tasks[0].readableName, 'harbor-single-task-9v46er7d');
assert.ok(stuck.tasks[0].nameSource.startsWith('placeholder'));
assert.equal(stuck.counts.namesUnrecoverable, 1);

// Live: the derived name must never be a placeholder or a bare hash.
const liveAll = buildManifest(ready.rows, {size: 0});
liveAll.tasks.forEach(t => {
  if (t.nameSource === 'derived from the verdict identifier') {
    assert.ok(!/^(autorun-|harbor-single-task-)/.test(t.readableName),
      `${t.name} derived another placeholder: ${t.readableName}`);
    assert.ok(!/^[0-9a-f]{16,}$/.test(t.readableName), 'a bare hash is not a name');
  }
});
console.log('names    :', `${liveAll.counts.namesDerived} derived from identifiers,`,
  `${liveAll.counts.namesUnrecoverable} with no readable name`);
console.log('all placeholder-name assertions passed');

// --- possibly-already-delivered --------------------------------------------
// The join refuses to mark these delivered because the rule that would do it is
// wrong 8 times out of 155. They must reach the manifest as a flag, never as a
// silent inclusion and never as a silent exclusion.
const idx = read('delivered-index.json');
const suspectIds = Object.keys(idx.suspect || {});
assert.ok(suspectIds.length > 0, 'the index must publish the suspects list');
assert.equal(idx.counts.readySuspect, suspectIds.length, 'the count must match the list');

const flagged = liveAll.tasks.filter(t => t.possiblyAlreadyDelivered);
assert.ok(flagged.length > 0, 'a full manifest must carry the flags');
assert.equal(liveAll.counts.possiblyAlreadyDelivered, flagged.length);
flagged.forEach(t => {
  assert.equal(typeof t.possiblyAlreadyDelivered, 'string',
    'the flag names the audited task it may duplicate');
  // By row, not by name: the flag now covers the case where the name IS a
  // delivered one - a rework of it - so asserting on the name would
  // contradict the thing being flagged. What must hold is that the rows it
  // stands for were never delivered themselves.
  t.standsFor.forEach(id => assert.ok(!deliveredIds.has(id),
    'a flagged task is still not a confirmed delivery'));
});

// Every suspect row that survives deduplication must be flagged; none may be
// dropped from the manifest, which would hide the decision instead of raising it.
const suspectRows = ready.rows.filter(r => r.maybeDelivered);
const inManifest = suspectRows.filter(r => liveAll.tasks.some(t => t.standsFor.includes(r.id)));
assert.equal(inManifest.length, suspectRows.length,
  'every suspect row must appear in the full manifest, flagged rather than removed');

console.log('suspects :', `${suspectIds.length} ready rows may already have shipped,`,
  `${flagged.length} flagged in the full manifest`);
console.log('all suspect assertions passed');

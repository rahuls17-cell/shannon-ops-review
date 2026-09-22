// The delivered/ready split on the Pipeline tab, against the live assets.
//
// The join is computed by tools/build_delivered_index.py, so what is tested
// here is that the page agrees with the index, and that the index agrees with
// the two datasets it was built from. A drift in any of the three shows up as
// a failure rather than as a plausible-looking number.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const {prepareTruth, filterTruth} = require(path.join(root, 'truth.js'));
const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));

const truthAsset = read('pipeline-truth.json');
const index = read('delivered-index.json');
const audit = read('delivery-audit.json');
const c = index.counts;

// --- the index describes the data it was built from ------------------------
assert.equal(c.auditedTasks, audit.rows.length, 'index audited count must match the audit asset');
assert.equal(c.pipelineTasks, truthAsset.tasks.length, 'index pipeline count must match the truth asset');
assert.equal(c.auditedMatched + c.auditedUnmatched, c.auditedTasks,
  'every audited task is either matched or reported as unmatched');
assert.equal(index.unmatchedAudit.length, c.auditedUnmatched,
  'the unmatched list must be as long as the unmatched count');

// Every delivered id is a real pipeline task; the join cannot invent one.
const ids = new Set(truthAsset.tasks.map(t => t.id));
Object.keys(index.delivered).forEach(id =>
  assert.ok(ids.has(id), `delivered id ${id} is not a pipeline task`));

// --- the model marks exactly what the index says ---------------------------
const model = prepareTruth(truthAsset, index);
const marked = model.rows.filter(r => r.delivered);
assert.equal(marked.length, Object.keys(index.delivered).length,
  'rows marked delivered must equal the index size');
assert.equal(marked.length, c.deliveredRows, 'and must equal the count the index publishes');
marked.forEach(r => assert.ok(r.deliveredVia, 'a delivered row must record how it was matched'));

// Without the index nothing is marked - the page must be able to tell
// "not delivered" from "delivery unknown".
const blind = prepareTruth(truthAsset);
assert.equal(blind.rows.filter(r => r.delivered).length, 0, 'no index means no delivered flag');
assert.equal(blind.deliveredIndex, null, 'and the model says the index is absent');

// --- the filter and the tallies agree --------------------------------------
const all = filterTruth(model.rows, {});
assert.equal(all.delivered, c.deliveredRows, 'delivered tally must match the index');
assert.equal(all.deliveredNames, c.deliveredNames, 'distinct delivered names must match');
assert.equal(all.readyForDelivery, c.readyRows, 'ready tally must match the index');
assert.equal(all.readyNames, c.readyNames, 'distinct ready names must match');

// The delivered filter answers in tasks; `submissions` is the row count it
// folded them from. Both are checked so neither can drift unnoticed.
const yes = filterTruth(model.rows, {delivered: 'yes'});
assert.equal(yes.submissions, c.deliveredRows, 'the delivered filter must select every delivered row');
assert.ok(yes.rows.length < yes.submissions, 'and must show them folded into tasks');

const ready = filterTruth(model.rows, {delivered: 'ready'});
assert.equal(ready.submissions, c.readyRows, 'the ready filter must select every ready row');
// One row per TASK, which folds -v3 and -v4 together; readyNames counts
// distinct names and is the larger number. Both are checked.
assert.equal(ready.rows.length, c.readyTasks, 'and must show one row per task');
assert.ok(c.readyTasks <= c.readyNames, 'folding names into tasks cannot increase the count');
ready.rows.forEach(r => {
  assert.ok(!r.delivered, 'a ready task cannot already be delivered');
  assert.ok(r.atCurrentBar, 'a ready task must have a package at the current bar');
  assert.ok(['accepted', 'legacy accepted'].includes(r.state), 'a ready task must be accepted');
});

const no = filterTruth(model.rows, {delivered: 'no'});
assert.equal(no.submissions + yes.submissions, model.rows.length,
  'delivered and not-delivered must partition the population');
assert.ok(ready.rows.length <= no.rows.length, 'ready is a subset of not-delivered');

// Ready must not overlap delivered. By row is exact and always holds.
//
// By name it does not: 5,844 rows carry 4,364 distinct names - "task" alone
// appears 13 times - so two unrelated tasks can share one. A row delivered via
// its identifier or a normalised name can therefore sit next to a genuinely
// different ready row of the same name, which is what turned this red in CI
// against a pipeline that happened to contain one.
//
// Where the name IS the identity - the row was matched by an exact name match -
// the index marks every row carrying it, so a ready row with that name would
// mean the join missed one. That is the version worth asserting.
const nameOf = row => (row.name || '').trim().toLowerCase();
const deliveredByName = new Set(marked.filter(r => r.deliveredVia === 'name').map(nameOf));
ready.rows.forEach(r => assert.ok(!deliveredByName.has(nameOf(r)),
  `${r.name} is offered as ready but the join marked that exact name delivered`));

// --- the join stays honest about what it missed ----------------------------
// This is the figure that decides whether the split can be trusted. If a lot of
// accepted deliveries stop matching, the "ready" number starts counting work
// that has already gone out, and that must fail loudly rather than drift.
assert.ok(c.unmatchedAccepted <= 5,
  `${c.unmatchedAccepted} accepted deliveries failed to match the pipeline; ` +
  'the ready figure can no longer be trusted');

// The delivery filter is unrelated and must not be disturbed by the new one.
const bar = filterTruth(model.rows, {delivery: 'current'});
assert.equal(bar.rows.length, all.atCurrentBar, 'the current-bar filter still works');

console.log('delivered index :',
  `${c.auditedMatched}/${c.auditedTasks} audited matched (${JSON.stringify(c.byMethod)}),`,
  `${c.auditedUnmatched} unmatched of which ${c.unmatchedAccepted} accepted`);
console.log('pipeline        :',
  `${c.deliveredRows} rows delivered (${c.deliveredNames} names) /`,
  `${c.readyRows} ready (${c.readyNames} unique names) of ${c.acceptedAtCurrentBar} accepted at the bar`);
console.log('all delivered-index assertions passed');

// The staleness guard must fire, or it is decoration. The index resolves to
// pipeline ids, so one rebuilt without the other marks the wrong rows.
assert.equal(model.deliveredStale, false, 'the published index must match the published pipeline');
assert.equal(
  prepareTruth(truthAsset, {...index, pipelineGeneratedAt: '2026-01-01T00:00:00+00:00'}).deliveredStale,
  true, 'an index built against another pipeline must be reported as stale');
console.log('staleness guard fires');

// --- one row per task while the Delivered filter is on ----------------------
// The pipeline emits a row per submission. For the delivered population that
// over-counts badly, so any figure taken while this filter is set must be a
// task count, not a row count.
const {collapseByTask} = require(path.join(root, 'truth.js'));

const rawYes = model.rows.filter(r => r.delivered);
const colYes = filterTruth(model.rows, {delivered: 'yes'});
assert.ok(colYes.collapsed, 'the delivered filter must collapse');
assert.equal(colYes.submissions, rawYes.length, 'submissions must be the uncollapsed count');
assert.ok(colYes.rows.length < colYes.submissions, 'collapsing must actually remove repeats');
assert.equal(colYes.rows.length + colYes.versionsFolded, colYes.submissions,
  'shown tasks plus folded versions must equal the submissions');

// No task may appear twice once collapsed.
const keys = colYes.rows.map(r => r.versionKey);
assert.equal(new Set(keys).size, keys.length, 'a task cannot appear twice when collapsed');

// Nothing is lost: every submission is either shown or listed under one.
const accounted = new Set();
colYes.rows.forEach(r => {
  accounted.add(r.id);
  (r.otherVersions || []).forEach(v => accounted.add(v.id));
});
rawYes.forEach(r => assert.ok(accounted.has(r.id),
  `${r.name} vanished when the rows were collapsed`));
assert.equal(accounted.size, rawYes.length, 'collapsing must not invent rows either');

// Every collapsed row explains itself: how many versions, which is shown, why.
colYes.rows.filter(r => r.versions > 1).forEach(r => {
  assert.equal(r.versions, r.otherVersions.length + 1, 'the version count must match the list');
  assert.ok(r.chosenBecause && r.chosenBecause.length > 10, 'a folded row must say why this version');
  r.otherVersions.forEach(v => assert.ok(v.id && v.state, 'each other version is identifiable'));
});

// The shown version is the most recently decided one.
colYes.rows.filter(r => r.versions > 1).forEach(r => {
  r.otherVersions.forEach(v => assert.ok((r.decided || '') >= (v.decided || ''),
    `${r.name} shows ${r.decided} but a version decided ${v.decided} exists`));
});

// Ready collapses to the same number the manifest ships.
const colReady = filterTruth(model.rows, {delivered: 'ready'});
assert.equal(colReady.rows.length, c.readyTasks,
  'the collapsed ready count must equal the distinct task count the index publishes');

// With no Delivered filter nothing is collapsed - other views keep row counts.
const none = filterTruth(model.rows, {});
assert.equal(none.collapsed, false, 'no delivered filter means no collapsing');
assert.equal(none.rows.length, model.rows.length);
assert.equal(none.versionsFolded, 0);

// Collapsing is idempotent and order-independent.
assert.equal(collapseByTask(collapseByTask(rawYes)).length, collapseByTask(rawYes).length,
  'collapsing twice must change nothing');
assert.equal(collapseByTask([...rawYes].reverse()).length, collapseByTask(rawYes).length,
  'row order must not change the task count');

console.log('collapse :', `${colYes.submissions} delivered rows shown as ${colYes.rows.length} tasks`,
  `(${colYes.versionsFolded} repeat versions counted once);`,
  `ready ${colReady.submissions} rows -> ${colReady.rows.length} tasks`);
console.log('all collapse assertions passed');

// --- a refresh must not drop the delivered index ----------------------------
// prepareTruth without the index leaves every row unmarked, which is not the
// same as "nothing is delivered": Already delivered falls to 0 and Ready rises
// to include work that has already gone out, which is the exact double-delivery
// this feature exists to prevent. The stale guard cannot catch it either - it
// compares timestamps, and an absent index has none. So the page must never
// prepare a refreshed payload without also fetching the index.
const withIndex = filterTruth(prepareTruth(truthAsset, index).rows, {});
const without = filterTruth(prepareTruth(truthAsset).rows, {});
assert.ok(without.readyForDelivery > withIndex.readyForDelivery,
  'sanity: dropping the index must inflate ready, or this test proves nothing');
assert.equal(without.delivered, 0, 'sanity: dropping the index unmarks every row');

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const watcher = app.slice(app.indexOf('function watchForRebuild'),
                          app.indexOf('async function rebuildTruth'));
assert.ok(watcher.includes('loadTruth()'),
  'watchForRebuild must reload through loadTruth so the delivered index comes with it');
assert.ok(!/prepareTruth\(payload\)/.test(watcher),
  'watchForRebuild must not prepare a payload without the delivered index');
console.log('refresh keeps the delivered index:',
  `${withIndex.readyForDelivery} ready with it, ${without.readyForDelivery} without`);

// --- the delivery join has to reconcile -------------------------------------
// The strip states three figures as a split of one: audited = found + not
// found. It used to show 574 delivered ROWS, which fell to 371 the moment the
// Delivered filter was set, for the same population - the fold only ran when
// that filter was on. Both are now task counts, and the three add up.
const jc = index.counts;
assert.equal(jc.auditedMatched + jc.auditedUnmatched, jc.auditedTasks,
  'found + not found must be exactly the audited tasks');
assert.ok(jc.auditedMatched > 0 && jc.auditedUnmatched > 0);

// Every audited task counted as found must be one the page can actually point
// at. The -realdocoutput case broke this: its only pipeline row was already
// claimed by a shorter audited name, so it counted as matched while naming no
// row, and 372 + 40 came to 412 only by accident of the two being counted in
// different places.
const claimed = new Set(Object.values(index.deliveredTask));
assert.equal(claimed.size, jc.auditedMatched,
  'an audited task is counted as found but names no pipeline row');
const listed = new Set((index.unmatchedAudit || []).map(r => r.task));
assert.equal(listed.size, jc.auditedUnmatched,
  'the panel must list every task the figure claims could not be found');
assert.equal(claimed.size + listed.size, jc.auditedTasks);
assert.ok([...claimed].every(t => !listed.has(t)),
  'no audited task may be both found and not found');
(index.unmatchedAudit || []).forEach(r => assert.ok(r.reason,
  `${r.task} is listed as not found with no reason`));

// The task count must not depend on a filter that looks unrelated to it.
const prepared = prepareTruth(truthAsset, index);
const unfiltered = filterTruth(prepared.rows, {});
const folded = filterTruth(prepared.rows, {delivered: 'yes'});
assert.equal(unfiltered.deliveredTasks, folded.rows.length,
  'delivered tasks must read the same with and without the Delivered filter');
assert.equal(unfiltered.deliveredTasks, jc.auditedMatched,
  'the tasks shown as delivered must be the audited tasks the index found');
assert.ok(unfiltered.delivered > unfiltered.deliveredTasks,
  'sanity: there are repeat submissions, or this test proves nothing');
assert.equal(unfiltered.readyTasks, filterTruth(prepared.rows, {delivered: 'ready'}).rows.length,
  'ready tasks must read the same with and without the Delivered filter');

// The strip is a reconciliation between two datasets, so it must not be wired
// to the filtered result - that would read "not found here" for tasks that are
// merely filtered out.
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const join = appSrc.slice(appSrc.indexOf("byId('truthJoin').innerHTML"),
                          appSrc.indexOf("byId('truthMakeup').innerHTML"));
assert.ok(/c\.auditedTasks/.test(join) && /c\.auditedMatched/.test(join) && /c\.auditedUnmatched/.test(join),
  'the three tiles must come from the index counts');
assert.ok(!/result\.delivered\b/.test(join),
  'the join tiles must not be driven by the filtered result');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok(/id="truthJoin" class="stats stats-3"/.test(html), 'the join strip holds three tiles');

console.log(`delivery join reconciles: ${jc.auditedTasks} audited = ${jc.auditedMatched} found + ${jc.auditedUnmatched} not found`);
console.log(`  the ${jc.auditedMatched} found stand on ${jc.deliveredRows} pipeline rows`);
console.log(`  ready: ${unfiltered.readyTasks} tasks from ${unfiltered.readyForDelivery} rows`);

// --- where the unmatched ones sit ------------------------------------------
// "Not found here" reads as "missing work", and it is not: the pipeline reads
// verdicts decided on or after its cut, while the bucket holds every accepted
// package whenever it was decided. Every one of these has an accepted package
// sitting there, so the tile has to say so or it invites the wrong conclusion.
assert.equal(jc.unmatchedInBucket + jc.unmatchedAbsent >= jc.auditedUnmatched - jc.unmatchedClaimed, true);
assert.equal(jc.unmatchedInBucket + jc.unmatchedAbsent, jc.auditedUnmatched,
  'every unmatched task is either in the bucket or it is not');
assert.equal(jc.unmatchedAbsent, 0,
  'none of the unmatched audited tasks are missing from the bucket');
(index.unmatchedAudit || []).forEach(r => {
  assert.equal(typeof r.inBucket, 'boolean', `${r.task} has no whereabouts`);
  if (r.inBucket) {
    assert.ok((r.cohorts || []).length, `${r.task} is in the bucket but names no cohort`);
    assert.ok((r.outcome || []).length, `${r.task} is in the bucket but names no outcome`);
  }
});
// The cohort tallies overlap by construction - one task can have folders in
// several - so they must never be presented, or asserted, as a split.
const cohortTotal = Object.values(jc.unmatchedCohorts).reduce((a, b) => a + b, 0);
assert.ok(cohortTotal >= jc.unmatchedInBucket,
  'cohort counts overlap; they cannot come to less than the tasks');

const appJoin = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const tile = appJoin.slice(appJoin.indexOf("stat('not found here'"),
                           appJoin.indexOf("byId('truthMakeup').innerHTML"));
assert.ok(/unmatchedInBucket/.test(tile), 'the tile must say where they sit');
assert.ok(/so those overlap/.test(tile), 'the tile must say the cohort counts overlap');

console.log(`the ${jc.auditedUnmatched} not found here: ${jc.unmatchedInBucket} have an accepted package in the bucket, `
  + `${jc.unmatchedClaimed} name collision, ${jc.unmatchedAbsent} missing outright`);
Object.entries(jc.unmatchedCohorts).forEach(([c, n]) => console.log(`    ${String(n).padStart(3)}  ${c}`));

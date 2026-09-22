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
assert.ok(/c\.manifestTasks/.test(join) && /c\.manifestLiveConfirmed/.test(join)
  && /c\.manifestLiveMissing/.test(join),
  'the three tiles must reconcile the manifests against the bucket');
assert.equal(jc.manifestLiveConfirmed + jc.manifestLiveMissing, jc.manifestTasks,
  'still in the bucket + no longer there must be every delivered task');
assert.equal((jc.manifestMissing || []).length, jc.manifestLiveMissing,
  'the panel must be able to name every package the figure claims is gone');
(jc.manifestMissing || []).forEach(m => {
  assert.ok(m.task && m.batch && m.sourceUri,
    'a missing package must name itself, its batch and the object that was sent');
  assert.ok(['absent', 'repackaged'].includes(m.state));
});
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
const tile = appJoin.slice(appJoin.indexOf("stat('no longer there'"),
                           appJoin.indexOf("byId('truthMakeup').innerHTML"));
assert.ok(/all three accepted prefixes/.test(tile),
  'the tile must say it looked beyond the prefix the package was cut from');
assert.ok(/Not a failed delivery/.test(tile),
  'and it must say what a missing copy does not mean');

console.log(`the ${jc.auditedUnmatched} not found here: ${jc.unmatchedInBucket} have an accepted package in the bucket, `
  + `${jc.unmatchedClaimed} name collision, ${jc.unmatchedAbsent} missing outright`);
Object.entries(jc.unmatchedCohorts).forEach(([c, n]) => console.log(`    ${String(n).padStart(3)}  ${c}`));

// --- the accepted-at-the-bar split ------------------------------------------
// The one strip on this tab whose figures add up, and the reason they do is
// that the population has exactly two states: a task that is accepted and
// whose package is collectable has either gone out or has not. It has to hold
// under every filter, not just unfiltered, or the strip tells the reader
// something that stops being true the moment they touch a control.
{
  const model = prepareTruth(truthAsset, index);
  [{}, {connector: 'yes'}, {connector: 'no'}, {state: 'accepted'},
   {delivered: 'ready'}, {delivered: 'yes'}, {carriedOver: 'yes'},
   {search: 'audit'}].forEach(f => {
    const r = filterTruth(model.rows, f);
    assert.equal(r.acceptedAtBarTasks, r.deliveredAtBarTasks + r.readyTasks,
      `delivered + ready must be the whole of accepted-at-the-bar under ${JSON.stringify(f)}`);
    assert.ok(r.acceptedAtBarRows >= r.acceptedAtBarTasks,
      'rows can never be fewer than the tasks they fold into');
  });

  const whole = filterTruth(model.rows, {});
  // The split is a subset of the join, never the same number under two names:
  // the join counts audited tasks in every state, and a rejected task is not
  // waiting to be delivered. Conflating them is what made this look wrong.
  assert.ok(whole.deliveredAtBarTasks < whole.deliveredTasks,
    'some delivered tasks are not accepted at the bar');
  // And it is a task count, so it must not equal the row count on the Accepted
  // card - that difference is the whole reason the strip exists.
  assert.ok(whole.acceptedAtBarRows > whole.acceptedAtBarTasks,
    'sanity: repeat submissions exist, or the fold proves nothing');

  const htmlSplit = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(/id="truthSplit" class="stats stats-3"/.test(htmlSplit), 'the split holds three tiles');
  const appSplit = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/truthSplit:/.test(appSplit), 'the split needs its own explanation, not the join’s');
  const flagsBlock = appSplit.slice(appSplit.indexOf("byId('truthFlags').innerHTML"),
                                    appSplit.indexOf("byId('truthSplit').innerHTML"));
  assert.ok(!/ready for delivery/.test(flagsBlock),
    'ready belongs to the split, not to a strip labelled as overlapping');

  console.log(`accepted at the bar splits: ${whole.acceptedAtBarTasks} tasks = `
    + `${whole.deliveredAtBarTasks} delivered + ${whole.readyTasks} ready `
    + `(folded from ${whole.acceptedAtBarRows} rows; the join's ${whole.deliveredTasks} counts every state)`);
}

// A legacy-accepted task with a collectable package is not in today's data, so
// nothing above would notice if `ready` quietly stopped covering that state -
// the split would go on balancing because every such row is zero. Synthetic
// rows make the branch real: a task waiting to be delivered under the old gate
// is still a task waiting to be delivered.
{
  const row = (id, state, over) => Object.assign({
    id, name: id, state, atCurrentBar: true, delivered: false, runs: 1,
    gateEra: 'KESTREL full', owner: 'a@turing.com', decided: '2026-09-10',
    findings: [], cohorts: [], connector: null, domain: 'Not recorded',
  }, over);
  const rows = [
    row('a', 'accepted'),
    row('b', 'accepted', {delivered: true, deliveredTask: 'b'}),
    row('c', 'legacy accepted'),
    row('d', 'legacy accepted', {delivered: true, deliveredTask: 'd'}),
    row('e', 'rejected'),
    row('f', 'accepted', {atCurrentBar: false}),
  ];
  const r = filterTruth(rows, {});
  assert.equal(r.acceptedAtBarTasks, 4, 'both accepted states count, and only at the bar');
  assert.equal(r.deliveredAtBarTasks, 2);
  assert.equal(r.readyTasks, 2, 'a legacy-accepted task at the bar is still ready to send');
  assert.equal(r.acceptedAtBarTasks, r.deliveredAtBarTasks + r.readyTasks);
  console.log('legacy-accepted work is counted as ready: 4 = 2 delivered + 2 ready on synthetic rows');
}

// --- the delivery manifests -------------------------------------------------
// These are the record of what was handed over, so what is asserted here is
// that the page cannot claim more than they support.
{
  const mpath = path.join(root, 'assets', 'manifest-index.json');
  assert.ok(fs.existsSync(mpath), 'the manifest index must be built and committed');
  const mi = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  const mc = mi.counts;

  assert.equal(mc.tasks, 412, 'four manifests, 412 handed-over tasks');
  assert.equal(Object.values(mc.batches).reduce((a, b) => a + b, 0), mc.tasks);
  assert.equal(mc.verified + mc.repackaged + mc.absent, mc.tasks,
    'every delivered package is accounted for against the bucket');
  assert.equal(new Set(mi.tasks.map(t => t.name)).size, mc.tasks,
    'a task name must not appear in two manifests');
  mi.tasks.forEach(t => {
    assert.ok(t.sha256, `${t.name} has no hash, so its delivery cannot be checked`);
    assert.ok(t.bucket && t.bucket.state, `${t.name} was never checked against the bucket`);
  });

  // The manifests and the audit are the same 412. If they ever diverge, one of
  // the two is wrong about what shipped and the page must not pick a side
  // silently.
  const audit = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'delivery-audit.json'), 'utf8'));
  const norm = s => String(s || '').trim().toLowerCase().replace(/^(harbor|obi)\//, '');
  const auditNames = new Set(audit.rows.map(r => norm(r.task)));
  const manNames = new Set(mi.tasks.map(t => norm(t.name)));
  assert.equal(auditNames.size, manNames.size);
  assert.ok([...auditNames].every(n => manNames.has(n)),
    'the delivery audit names a task no manifest delivered');

  // Claims are the point of the exercise, and the refusal is the safeguard:
  // a row named like a VERSION of delivered work may be rework that still has
  // to ship, and marking it delivered means it never ships at all.
  assert.ok(jc.manifestClaimed > 0, 'the manifests should place rows the name join cannot');
  assert.equal(jc.manifestClaimed, (index.counts.byMethod['delivery manifest'] || 0),
    'every manifest-placed row must be recorded under that method');
  const claimedIds = Object.entries(index.delivered)
    .filter(([, how]) => how === 'delivery manifest').map(([id]) => id);
  assert.equal(claimedIds.length, jc.manifestClaimed);
  const byId2 = new Map(truthAsset.tasks.map(r => [r.id, r]));
  const PLACEHOLDER = /^(harbor-single-task-|autorun-|content-[0-9a-f]{16,}|task\d*$|task[-_]|g\d+_|code-c\d+$|tasks?$)/i;
  claimedIds.forEach(id => {
    const row = byId2.get(id);
    assert.ok(row, `${id} was claimed but is not a pipeline task`);
    const task = index.deliveredTask[id];
    assert.ok(task, `${id} was claimed but names no delivered task`);
    const name = norm(row.name);
    assert.ok(PLACEHOLDER.test(name) || name === norm(task),
      `${row.name} was claimed on a name that is neither a placeholder nor the delivered name`);
  });

  // Nothing may be both delivered and flagged as maybe-delivered.
  const flagged = new Set(Object.keys(index.suspect || {}));
  assert.ok(claimedIds.every(id => !flagged.has(id)),
    'a row cannot be both counted as delivered and flagged as possibly delivered');

  console.log(`manifests: ${mc.tasks} delivered tasks in ${Object.keys(mc.batches).length} batches`);
  console.log(`  against the bucket: ${mc.verified} hash-verified, ${mc.repackaged} repackaged since, ${mc.absent} not in the scan`);
  console.log(`  placed ${jc.manifestClaimed} rows the name join could not see, flagged ${jc.manifestFlagged} more`);
}

// --- the live bucket listing ------------------------------------------------
// A listing needs credentials, so CI cannot make one. That makes two failure
// modes worth guarding: a rebuild silently ERASING the check, and the page
// presenting a months-old check as if it were fresh.
{
  const mi = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'manifest-index.json'), 'utf8'));
  const mc = mi.counts;
  assert.ok(mc.liveCheckedOn,
    'the committed manifest index must carry a live bucket check; a rebuild without '
    + '--listing has to carry the previous answers forward, not erase them');
  {
    const states = mi.tasks.filter(t => t.live).length;
    assert.equal(states, mc.tasks, 'a live check must cover every delivered package or none');
    assert.equal(Object.values(mc.live).reduce((a, b) => a + b, 0), mc.tasks);
    assert.equal(mc.liveConfirmed,
      (mc.live.object || 0) + (mc.live.moved || 0),
      'confirmed means the exact archive is there, at its path or moved within its folder');
    mi.tasks.forEach(t => assert.ok(t.live.checkedOn,
      `${t.name} has a live state with no date, so nobody can tell how old it is`));
    // The live answer must reach the page, and it must not be quietly replaced
    // by the scan-based one, which covers less and reported more as missing.
    assert.equal(index.counts.manifestLiveConfirmed, mc.liveConfirmed);
    assert.equal(index.counts.manifestLiveCheckedOn, mc.liveCheckedOn);
    const app2 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.ok(/manifestLiveCheckedOn/.test(app2),
      'the page must say when the bucket was listed, not just what was found');
    console.log(`live listing on ${mc.liveCheckedOn}: ${mc.liveConfirmed}/${mc.tasks} packages still in the bucket `
      + `(${mc.live.object || 0} at their exact path, ${mc.live.moved || 0} moved within their folder, `
      + `${(mc.live.absent || 0) + (mc.live.repackaged || 0)} not found)`);
  }
}

// --- the bucket lister is read-only -----------------------------------------
// This runs on the Harbor VM with that machine's own credentials, against a
// bucket nothing in this project is allowed to write to. The guard is that the
// code cannot express a write, so it is asserted rather than trusted.
{
  const src = fs.readFileSync(path.join(root, 'tools', 'list_delivery_prefix.py'), 'utf8');
  const body = src.split('"""').slice(2).join('"""');   // past the module docstring
  ['method=', 'PUT', 'POST', 'DELETE', 'PATCH', 'upload', 'rewrite', 'delete(']
    .forEach(verb => assert.ok(!body.includes(verb),
      `list_delivery_prefix.py must not be able to ${verb} - the bucket is read-only`));
  assert.ok(/devstorage\.read_only/.test(src), 'it must ask for a read-only scope');
  assert.ok(/nextPageToken/.test(src),
    'a truncated listing reads as packages having vanished, so it must paginate');
  assert.ok(/min-objects|min_objects/.test(src),
    'it must refuse to overwrite a good listing with a suspiciously short one');
  assert.ok(/\.replace\(out\)/.test(src),
    'the listing must be moved into place whole, never written in-place half-done');
  // A token must never reach stdout, which is what the listing is read from.
  assert.ok(!/print\([^)]*token/i.test(body), 'it must never print a credential');
  console.log('bucket lister: read-only scope, paginated, atomic, no credential printed');
}

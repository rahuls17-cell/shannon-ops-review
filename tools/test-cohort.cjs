// The accepted cohort counted by bucket folder. The whole point of this index
// is that it does NOT guess an identity from a name, so what is asserted here
// is that the four figures are one arithmetic and that the weak spots are
// reported rather than hidden.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const file = path.join(root, 'assets', 'cohort-index.json');
assert.ok(fs.existsSync(file), 'the cohort index must be built and committed');
const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
const c = idx.counts;
const folders = Object.values(idx.folders);

// --- the four figures are one arithmetic -----------------------------------
assert.equal(folders.length, c.packages);
assert.equal(c.decided + c.beforeCut, c.packages, 'the cut must split the cohort exactly');
assert.equal(c.latestAccepted + c.latestLegacyAccepted + c.latestRejected + c.latestOther,
  c.decided, 'the verdict split must cover every decided folder');
assert.equal(c.delivered + c.notDelivered, c.packages, 'delivery must split the cohort exactly');
assert.ok(c.latestAccepted < c.decided && c.decided <= c.packages,
  'each figure must narrow the one before it');

// --- one folder is one task ------------------------------------------------
assert.equal(new Set(folders.map(f => f.folder)).size, c.packages,
  'a folder cannot appear twice; if it can, the identity claim is false');

// --- delivery is a direct join, never a name match -------------------------
// The manifest records the folder it packaged from, so a delivered folder must
// be one that exists. If this ever needed normalising, the claim that this
// index avoids name guessing would be untrue.
const delivered = folders.filter(f => f.delivered);
assert.equal(delivered.length, c.delivered);
assert.ok(delivered.every(f => typeof f.batch === 'string' && f.batch),
  'every delivered folder must name the batch it went out in');

// --- the weak spots are reported -------------------------------------------
assert.equal(folders.filter(f => f.placeholderName).length, c.placeholderNames);
assert.ok(c.placeholderNames > 0,
  'sanity: machine-named folders exist, and pretending otherwise would hide the weakest joins');
assert.equal(folders.filter(f => (f.states || []).length > 1).length, c.disagreeAcrossRuns);
assert.ok(c.disagreeAcrossRuns > 0,
  'sanity: folders whose runs disagree exist; that is why latest-accepted is reported apart');

// --- no rejected figure, on purpose ----------------------------------------
assert.ok(!('rejected' in c) && !('packagesRejected' in c),
  'this index must not publish a rejected figure: rejected work has no folder, '
  + 'so any such number would describe only the accepted side');

// --- the page states it rather than just printing it -----------------------
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.ok(/truthCohort/.test(app), 'the strip must be rendered');
assert.ok(/^ {2}cohort: \(\) => \{/m.test(app),
  'the strip explanation must read the loaded index, not a figure typed into a string');
assert.ok(/Counted by bucket folder/.test(app),
  'and it must still say what makes this strip different from the others');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok(/id="truthCohort"/.test(html) && /id="truthCohortNote"/.test(html));

console.log(`cohort: ${c.packages.toLocaleString()} packages = ${c.decided.toLocaleString()} decided since ${idx.cut}`
  + ` + ${c.beforeCut} before it`);
console.log(`  of the decided: ${c.latestAccepted} accepted, ${c.latestRejected} rejected on a later run, ${c.latestOther} other`);
console.log(`  delivered ${c.delivered}, still to deliver ${c.notDelivered}`);
console.log(`  reported weak spots: ${c.placeholderNames} machine-named folders, ${c.disagreeAcrossRuns} with runs that disagree`);

// --- the dashboard's Accepted comes from the bucket -------------------------
// Decided rule: the finalisation prefix IS the acceptance decision. A package
// sits there because client QC accepted it, and all 412 deliveries were cut
// from that prefix, so no other cohort belongs in the figure. The verdicts
// check it; they do not produce it.
{
  assert.equal(idx.cohort, 'finalisation_client_qc_accepted_iteration_2',
    'Accepted is scoped to the prefix deliveries are cut from');
  assert.ok(/acceptedFromBucket/.test(app),
    'the Accepted card must read the cohort, not the verdict tally');
  assert.ok(/accepted packages in the bucket/.test(app),
    'and it must say on its face where it came from');
  // The bar underneath splits verdict states and must not be handed the bucket
  // figure, or its percentages stop meaning anything.
  const figures = app.slice(app.indexOf('function renderTruthFigures'),
                            app.indexOf("animateCounts(byId('truthFigures'))"));
  assert.ok(/const split = \[/.test(figures),
    'the partition must keep its own verdict-based list');
  assert.ok(/result\.accepted/.test(figures.slice(figures.indexOf('const split'))),
    'the partition must use the verdict count for Accepted');
  // And the chain has to show both sides, because the number now has two.
  assert.ok(/This figure is read from the bucket, not from the chain below/.test(app),
    'the Accepted chain must say the bucket produced it and the verdicts check it');
  assert.ok(/white-space: pre-line/.test(fs.readFileSync(path.join(root, 'styles.css'), 'utf8')),
    'the cross-check is written in paragraphs and needs them kept');

  console.log(`Accepted on the dashboard = ${c.packages.toLocaleString()} folders in ${idx.cohort}`);
  console.log(`  checked against the verdicts: ${c.decided.toLocaleString()} decided since ${idx.cut}, `
    + `${c.latestAccepted} still accepted, ${c.latestRejected} rejected on a later run`);
}

// --- delivered means one thing on every tab ---------------------------------
// The Delivery tab had a plan card labelled "Delivered" sitting beside
// "Audited tasks 412": 391 days delivered against a schedule, which reads as a
// contradiction of a package count it has nothing to do with.
{
  assert.ok(/Delivered against plan/.test(app),
    'the plan card must not be called Delivered next to a package count');
  assert.ok(!/card\('Delivered',/.test(app), 'the bare label must be gone');
  assert.ok(/Verified in the bucket/.test(app),
    'the audit row must show how many audited tasks still have a folder');

  // The Pipeline split is now the same population as the Accepted card, so it
  // has to be folder-based too or the two argue on one screen.
  const splitBlock = app.slice(app.indexOf("byId('truthSplit').innerHTML"),
                               app.indexOf("animateCounts(byId('truthSplit'))"));
  assert.ok(/cx\.packages/.test(splitBlock) && /cx\.delivered/.test(splitBlock),
    'the split must read the cohort, not the verdict tallies');
  assert.ok(/acceptedAtBarTasks/.test(splitBlock),
    'and it must still fall back to the verdict count when the listing is absent');
  assert.equal(c.delivered + c.notDelivered, c.packages,
    'delivered + still to deliver must be the whole of the accepted packages');

  console.log(`delivered reads the same everywhere: ${c.delivered} of ${c.packages} packages, `
    + `${c.notDelivered} still to deliver`);
}

// --- Accepted lists the bucket, not a selection of verdict rows -------------
// Filtering the verdict rows to accepted gives 1,145 rows that cover only
// 1,021 folders while missing 104 that hold an accepted package and have no
// accepted verdict row: a list that is too long and incomplete at once.
{
  const {prepareTruth, filterTruth} = require(path.join(root, 'truth.js'));
  const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
  const model = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'),
    read('connector-index.json'), read('glm-index.json'), idx);

  assert.ok(model.cohortRows, 'the model must expose one row per folder');
  assert.equal(model.cohortRows.length, c.packages,
    'the Accepted list must be exactly the folders in the bucket');
  assert.equal(new Set(model.cohortRows.map(r => r.cohortFolder)).size, c.packages,
    'one row per folder, no folder twice');
  assert.equal(model.cohortRows.filter(r => r.cohortDelivered).length, c.delivered);

  // A folder with no verdict must not borrow another task's row to fill its
  // columns - that would invent a trainer and a date for it.
  const bare = model.cohortRows.filter(r => r.noVerdict);
  assert.ok(bare.length > 0);
  bare.forEach(r => {
    assert.equal(r.runs, 0, 'a folder with no verdict has no runs');
    assert.ok(r.id.startsWith('folder:'), 'and is identified by its folder, not a verdict id');
    assert.ok(/no verdict inside the pipeline window/i.test(r.why));
  });

  // The verdict-row route is still what every other filter uses.
  const rejected = filterTruth(model.rows, {state: 'rejected'});
  assert.ok(rejected.rows.every(r => !r.fromBucket),
    'only Accepted comes from the bucket');

  const app2 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/const byBucket = filters\.state === 'accepted'/.test(app2),
    'the Accepted filter must switch the table to the bucket rows');
  assert.ok(/\{\.\.\.filters, state: ''\}/.test(app2),
    'and must drop the state filter, since every folder here is accepted by definition');

  console.log(`Accepted lists ${model.cohortRows.length.toLocaleString()} folders `
    + `(${bare.length} with no verdict in the window, ${c.delivered} delivered)`);
}

// --- the dropdown must count what it selects --------------------------------
// "accepted (1,145 submissions)" beside a card reading 1,125 looked like one of
// the two was broken. Picking accepted now lists the bucket's folders, so the
// count beside it has to be that number and say which unit it is in.
{
  const app3 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/states\.accepted = truth\.cohortRows\.length/.test(app3),
    'the accepted option must count the folders it selects');
  assert.ok(/value === 'accepted' && truth\.cohortRows \? 'packages' : 'submissions'/.test(app3),
    'and each option must name its own unit, because the tab genuinely has two');
  console.log(`dropdown: accepted (${c.packages.toLocaleString()} packages), everything else in submissions`);
}

// --- the Accepted list reads in a sensible order, and the cards say what they
// --- are counting ----------------------------------------------------------
// Folder order is alphabetical, which tells a reader nothing. And with the
// bucket driving the list, "Rejected 173" under an Accepted filter is not a
// contradiction - it is the latest verdict of those accepted packages - but it
// only reads that way if the card says so.
{
  const {prepareTruth} = require(path.join(root, 'truth.js'));
  const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
  const model = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'),
    read('connector-index.json'), read('glm-index.json'), idx);

  const dated = model.cohortRows.filter(r => r.decided).map(r => r.decided);
  assert.ok(dated.length > 1);
  assert.deepEqual(dated, [...dated].sort().reverse(),
    'the Accepted list must run newest decision first');
  const firstBlank = model.cohortRows.findIndex(r => !r.decided);
  if (firstBlank > -1) {
    assert.ok(model.cohortRows.slice(firstBlank).every(r => !r.decided),
      'folders with no verdict sort last, not as if decided long ago');
  }

  const app4 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const {filterTruth: ft} = require(path.join(root, 'truth.js'));
  const only = ft(model.cohortRows, {});
  assert.equal(only.accepted, model.cohortRows.length, 'every row under Accepted is accepted');
  [only.rejected, only.undecided, only.running, only.legacyAccepted].forEach(n =>
    assert.equal(n, 0, 'selecting Accepted must zero every other state'));
  assert.ok(model.cohortRows.every(r => r.state === 'accepted'),
    'a row cannot be listed under Accepted with another state');
  const later = model.cohortRows.filter(r => r.latestVerdict && r.latestVerdict !== 'accepted');
  assert.ok(later.length > 0, 'sanity: later runs that failed exist');
  assert.ok(/A later run<\/dt>/.test(app4),
    'a later failed run must be shown in the evidence, not as the row’s state');
  assert.ok(!/of these packages, latest run /.test(app4),
    'the other cards must not be relabelled; they are zero');

  console.log(`Accepted list runs ${dated[0]} back to ${dated[dated.length - 1]}, `
    + `${model.cohortRows.length - dated.length} undated folders last`);
}

// --- everything the Accepted view drives must read the same rows ------------
// Found by sweeping the filters: the table showed 715 while the CSV wrote 695
// and the manifest reported 712, because the export and the manifest were
// still cutting from the verdict rows and the fold was merging folders whose
// names normalise alike.
{
  const {prepareTruth: prep, filterTruth: ft} = require(path.join(root, 'truth.js'));
  const {buildManifest} = require(path.join(root, 'manifest.js'));
  const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
  const model = prep(read('pipeline-truth.json'), read('delivered-index.json'),
    read('connector-index.json'), read('glm-index.json'), idx);

  // Delivery splits the cohort exactly; three packages used to fall through
  // both halves because the fold merged them.
  const yes = ft(model.cohortRows, {delivered: 'yes'}).rows.length;
  const no = ft(model.cohortRows, {delivered: 'no'}).rows.length;
  assert.equal(yes, c.delivered, 'the Delivered filter must agree with the manifests');
  assert.equal(yes + no, c.packages, 'delivered + not delivered must be every package');

  // A folder is its own identity, so nothing may fold two of them together.
  const ready = ft(model.cohortRows, {delivered: 'ready'});
  const manifest = buildManifest(ready.rows, {size: 0});
  assert.equal(manifest.counts.tasks, ready.rows.length,
    'the manifest must hold one entry per folder, never merging two');
  assert.equal(manifest.counts.supersededRows, 0);

  // Every package in the cohort is collectable - it is in the bucket.
  assert.ok(model.cohortRows.every(r => r.atCurrentBar),
    'a package in the accepted prefix is collectable by definition');

  const app5 = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/function shownRows\(\)/.test(app5),
    'the export, the manifest and the join note must share one row source');
  assert.ok(!/window\.filterTruth\(truth\.rows, truthFilters\(\)\)/.test(app5),
    'nothing may reach past it to the verdict rows');
  assert.ok(/acceptedShown/.test(app5),
    'the Accepted card must narrow with the filters rather than sitting at the total');

  console.log(`Accepted view is consistent: ${c.packages} packages, ${yes} delivered, ${no} to deliver, `
    + `manifest ${manifest.counts.tasks} entries`);
}

// --- connector comes from the folder's own package --------------------------
// It was being inherited from whichever verdict row happened to match, which
// left 69 folders unclassified and put non-connector at 714 where the scan can
// read 771. The folder IS the package; nothing else is a better source.
{
  const {prepareTruth: pt, filterTruth: f2} = require(path.join(root, 'truth.js'));
  const read = g => JSON.parse(fs.readFileSync(path.join(root, 'assets', g), 'utf8'));
  const model = pt(read('pipeline-truth.json'), read('delivered-index.json'),
    read('connector-index.json'), read('glm-index.json'), idx);

  assert.equal(f2(model.cohortRows, {connector: 'yes'}).rows.length, c.connectorTasks,
    'the connector filter must agree with the folders');
  assert.equal(f2(model.cohortRows, {connector: 'no'}).rows.length, c.nonConnectorTasks);
  assert.equal(f2(model.cohortRows, {connector: 'unknown'}).rows.length, c.connectorUnknown);
  assert.equal(c.connectorTasks + c.nonConnectorTasks + c.connectorUnknown, c.packages,
    'every package is classified or explicitly not known');

  // Whatever the scan read for a folder is what the row must carry.
  const folders = Object.values(idx.folders);
  const byFolder = new Map(model.cohortRows.map(r => [r.cohortFolder, r]));
  folders.forEach(entry => {
    const row = byFolder.get(entry.folder);
    assert.ok(row, `${entry.folder} has no row`);
    assert.equal(row.connector === undefined ? null : row.connector,
      entry.connector === undefined ? null : entry.connector,
      `${entry.folder} is classified differently from its own package`);
  });
  assert.ok(c.connectorUnknown < c.packages * 0.05,
    'a large unknown share means the classification is being taken from the wrong place');

  console.log(`connector, from each folder's package: ${c.connectorTasks} connector, `
    + `${c.nonConnectorTasks} non-connector, ${c.connectorUnknown} not known`);
}

// --- the last unknowns, and why they are not guessed from the name ----------
// All 20 unclassified folders were simply absent from the scan. 16 had been
// delivered, so a manifest already recorded what their task.toml declared -
// the same structural fact, written down at packaging time. Using it is not a
// guess. Reading the NAME would be: these 20 alone hold
// `appointment-backlog-placeholder-and-duplicate-audit` (a connector) and
// `gen-g91-hotel-rate-parity-audit` (not one).
{
  const folders = Object.values(idx.folders);
  const viaManifest = folders.filter(f => f.connectorVia === 'the delivery manifest that packaged it');
  assert.equal(viaManifest.length, c.connectorFromManifest);
  assert.ok(viaManifest.every(f => f.delivered),
    'only a delivered folder can be classified from a manifest - nothing else was packaged');
  // Held structurally rather than by luck. The fallback used to match a name
  // with its version suffixes stripped, so the first new version of an already
  // delivered task - code-c594-...-v59, 23 Sep - inherited the older version's
  // answer under a label saying the manifest had packaged it. It had not. Both
  // questions now read the same mapping, so the assertion above cannot be
  // broken by a folder the manifest never saw.
  const builder = fs.readFileSync(path.join(root, 'tools', 'build_cohort_index.py'), 'utf8');
  const fallback = builder.slice(builder.indexOf('from_manifest = {'),
    builder.indexOf('entries, how = {}'));
  assert.ok(fallback.includes('delivered_folders.items()'),
    'the manifest fallback must be keyed off the folders a manifest actually packaged');
  assert.ok(!/norm\(/.test(fallback),
    'matching a stripped-down name here is what let a different version answer for this one');
  const unresolved = c.unresolved || [];
  assert.equal(unresolved.length, c.connectorUnknown,
    'every unknown must be named, or the resolver cannot be pointed at it');
  assert.ok(c.connectorUnknown <= 25,
    'more than one batch left unknown means the resolver is not running, '
    + 'not that a single folder slipped through');
  assert.ok(folders.filter(f => f.connector === null).every(f => !f.delivered),
    'a delivered folder can never be unknown: a manifest read its package');
  assert.ok(c.connectorFromPackage > 0,
    'the last few must be settled by reading the package, not by guessing');

  // Every classification names where it came from, and none of them is a name.
  folders.filter(f => f.connector !== null).forEach(f =>
    assert.ok(f.connectorVia === 'the folder’s own package'
      || f.connectorVia === 'the delivery manifest that packaged it'
      || String(f.connectorVia).startsWith('its task.toml'),
      `${f.folder} is classified from something unexpected: ${f.connectorVia}`));
  const src = fs.readFileSync(path.join(root, 'tools', 'build_cohort_index.py'), 'utf8');
  assert.ok(!/startswith\(\('gen-|connector.*prefix/.test(src),
    'connector must never be inferred from a name prefix');

  console.log(`connector: ${c.connectorTasks} / ${c.nonConnectorTasks} / ${c.connectorUnknown} unknown `
    + `(${c.connectorFromManifest} read from the manifest that packaged them)`);
}

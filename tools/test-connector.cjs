// Connector / non-connector classification on the Pipeline tab.
//
// The claim being protected is narrow and worth stating: connector status is
// read from mcp_servers in task.toml, so it is known only for a task whose
// package was scanned, and a task without one is unknown rather than guessed.
// Most of what follows checks that the unknowns stay unknown.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const {prepareTruth, filterTruth} = require(path.join(root, 'truth.js'));
const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));

const truthAsset = read('pipeline-truth.json');
const index = read('connector-index.json');
const c = index.counts;

// --- the index describes the pipeline it was built from --------------------
assert.equal(c.pipelineTasks, truthAsset.tasks.length,
  'the index must be built against the published pipeline');
assert.equal(index.pipelineGeneratedAt, truthAsset.generatedAt,
  'and against the same build of it');
assert.equal(c.connector + c.nonConnector, c.classified,
  'every classified task is one or the other');
assert.equal(c.classified + c.unknown, c.pipelineTasks,
  'classified and unknown must partition the population');

const ids = new Set(truthAsset.tasks.map(t => t.id));
Object.keys(index.connector).forEach(id =>
  assert.ok(ids.has(id), `${id} is not a pipeline task`));

// --- the model marks exactly what the index says ---------------------------
const model = prepareTruth(truthAsset, null, index);
const all = filterTruth(model.rows, {});
assert.equal(all.connectorRows, c.connector, 'connector rows must match the index');
assert.equal(all.nonConnectorRows, c.nonConnector, 'non-connector rows must match');
assert.equal(all.connectorUnknownRows, c.unknown, 'unknown rows must match');
assert.equal(all.connectorTasks, filterTruth(model.rows, {connector: 'yes'}).rows.length,
  'the connector figure must equal what the connector filter shows');
assert.equal(all.nonConnectorTasks, filterTruth(model.rows, {connector: 'no'}).rows.length);
assert.equal(all.connectorUnknown, filterTruth(model.rows, {connector: 'unknown'}).rows.length);
assert.ok(all.connectorTasks < all.connectorRows,
  'sanity: repeat submissions exist, so tasks must be fewer than rows');
const spread = all.connectorTasks + all.nonConnectorTasks + all.connectorUnknown;
assert.ok(spread >= all.rows.length, 'the three states must cover every task');
assert.ok(spread - all.rows.length < all.rows.length * 0.02,
  'a task counted in two connector states is a package disagreeing with its '
  + 'sibling, which should be rare - a large overlap means the join is wrong');
console.log(`  connector states cover ${all.rows.length.toLocaleString()} tasks, `
  + `${(spread - all.rows.length).toLocaleString()} of which have submissions that disagree`);

// Without the index the page must not invent an answer. It keeps whatever the
// ingest chain knew, which for most rows is nothing.
const blind = prepareTruth(truthAsset);
assert.equal(blind.connectorIndex, null, 'no index means the model says so');
const blindAll = filterTruth(blind.rows, {});
assert.ok(blindAll.connectorTasks <= all.connectorTasks,
  'the index may only widen what the chain already knew, never narrow it');

// --- the index never contradicts the chain ---------------------------------
// Both read mcp_servers from the same scanner. If they ever disagree, one of
// them is reading a different package for the same task and the number is not
// trustworthy - so this is a hard failure, not a tolerance.
let compared = 0;
truthAsset.tasks.forEach(task => {
  const fromIndex = index.connector[task.id];
  if (task.connector === null || task.connector === undefined || !fromIndex) return;
  compared += 1;
  assert.equal(fromIndex.isConnector, task.connector,
    `${task.name}: the chain says ${task.connector}, the scan says ${fromIndex.isConnector}`);
});
assert.ok(compared > 100, `only ${compared} tasks could be cross-checked; expected hundreds`);

// --- the filter returns what it claims -------------------------------------
const yes = filterTruth(model.rows, {connector: 'yes'});
const no = filterTruth(model.rows, {connector: 'no'});
const unknown = filterTruth(model.rows, {connector: 'unknown'});
assert.equal(yes.connectorRows, c.connector);
assert.equal(no.nonConnectorRows, c.nonConnector);
assert.equal(unknown.connectorUnknownRows, c.unknown);
assert.equal(yes.rows.length, yes.connectorTasks, 'the filter shows the tasks it counted');
assert.equal(no.rows.length, no.nonConnectorTasks);
assert.equal(unknown.rows.length, unknown.connectorUnknown);
assert.ok(yes.rows.length + no.rows.length + unknown.rows.length >= all.rows.length,
  'the three filters must cover every task shown');
assert.equal(yes.connectorRows + no.nonConnectorRows + unknown.connectorUnknownRows,
  model.rows.length, 'and they must partition the submissions exactly');
yes.rows.forEach(r => assert.equal(r.connector, true));
no.rows.forEach(r => assert.equal(r.connector, false));
unknown.rows.forEach(r => assert.ok(r.connector === null || r.connector === undefined));

// A connector task should name the gyms it mounts; that is the evidence for the
// classification, not decoration.
const withServices = yes.rows.filter(r => (r.connectorServices || []).length);
assert.ok(withServices.length > 0, 'connector tasks must carry the services they mount');
withServices.forEach(r => r.connectorServices.forEach(s =>
  assert.ok(typeof s === 'string' && s.length, 'each service is a name')));
no.rows.forEach(r => assert.equal((r.connectorServices || []).length, 0,
  'a non-connector task cannot mount a gym'));

// --- coverage is honest about its own limit --------------------------------
// The marker lives in the package, so the meaningful denominator is tasks that
// have one. If that ever drops, the split is being read off too little data.
assert.ok(c.classifiedAtBar / c.withPackageAtBar > 0.9,
  `only ${c.classifiedAtBar}/${c.withPackageAtBar} tasks with a package are classified`);
assert.ok(c.unknown > 0,
  'unknown should not be zero here: most pipeline tasks have no package to read');

console.log('connector index :',
  `${c.connector} connector, ${c.nonConnector} non-connector, ${c.unknown} unknown`,
  `of ${c.pipelineTasks} (${c.scannedPackages} packages scanned)`);
console.log('coverage        :',
  `${c.classifiedAtBar}/${c.withPackageAtBar} of tasks with a package at the bar;`,
  `${compared} cross-checked against the chain with no disagreement`);
console.log('services        :', Object.keys(c.services).length, 'distinct gyms');
console.log('all connector assertions passed');

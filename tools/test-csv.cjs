// The CSV export. It is handed to spreadsheets and to other people's scripts,
// so the things checked here are the ones that corrupt a file silently: broken
// quoting, a value a spreadsheet executes, and a header that has drifted from
// what the page shows.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const {truthCsv, cell, COLUMNS} = require(path.join(root, 'csv.js'));
const {prepareTruth, filterTruth} = require(path.join(root, 'truth.js'));
const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));

// A parser, so the assertions below are about what a reader gets out rather
// than about the string we happened to write. Deliberately not a regex split.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- quoting ---------------------------------------------------------------
assert.equal(cell('plain'), 'plain');
assert.equal(cell('a,b'), '"a,b"');
assert.equal(cell('said "no"'), '"said ""no"""');
assert.equal(cell('two\nlines'), '"two\nlines"');
assert.equal(cell(null), '');
assert.equal(cell(undefined), '');
assert.equal(cell(['a', 'b']), 'a | b');
assert.equal(cell(0), '0', 'zero is a value, not an absence');
assert.equal(cell(false), 'false');

// --- spreadsheet formula injection -----------------------------------------
// This is not hypothetical: the pipeline carries names like `-task-51e30c`.
['=cmd()', '+1', '-task-51e30c', '@SUM(A1)'].forEach(value => {
  assert.equal(cell(value)[0], "'", `${value} must not reach a spreadsheet as a formula`);
});
assert.equal(cell('gen-g985-audit'), 'gen-g985-audit', 'an interior dash is not a formula');

// --- a round trip through a parser -----------------------------------------
const awkward = {
  name: '-task-51e30c', state: 'accepted', owner: 'a@turing.com',
  why: 'the verdict said "pass", then, later, "fail"',
  findings: ['flaky, intermittent', 'timeout'],
  canonicalReason: 'line one\nline two',
  runs: 3, connector: true, connectorServices: ['slack'],
};
const parsed = parseCsv(truthCsv([awkward]));
assert.equal(parsed.length, 2, 'a newline inside a quoted field must not start a row');
assert.deepEqual(parsed[0], COLUMNS);
const got = Object.fromEntries(COLUMNS.map((c, i) => [c, parsed[1][i]]));
assert.equal(got.task_name, "'-task-51e30c");
assert.equal(got.why_this_state, 'the verdict said "pass", then, later, "fail"');
assert.equal(got.canonical_run, 'line one\nline two');
assert.equal(got.findings, 'flaky, intermittent | timeout');
assert.equal(got.connector, 'yes');

// --- connector has three answers, not two ----------------------------------
// Blank is not "no". The marker only exists inside a package, so a task with
// no package scanned has no answer, and a CSV that wrote `no` there would turn
// 4,348 unknowns into a claim nobody made.
const three = parseCsv(truthCsv([{connector: true}, {connector: false}, {connector: null}]));
const at = COLUMNS.indexOf('connector');
assert.deepEqual([three[1][at], three[2][at], three[3][at]], ['yes', 'no', '']);

// --- against the published pipeline ----------------------------------------
const truth = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'), read('connector-index.json'));

const all = filterTruth(truth.rows, {});
const everything = parseCsv(truthCsv(all.rows));
assert.equal(everything.length, all.rows.length + 1,
  'every shown row must be one CSV record, header aside');
assert.ok(everything.every(r => r.length === COLUMNS.length),
  'a row with the wrong number of fields means quoting broke somewhere');

// The export is whatever the table is showing, so it has to move with the
// filters rather than always writing the whole pipeline.
const connectors = filterTruth(truth.rows, {connector: 'yes'});
assert.ok(connectors.rows.length < all.rows.length);
assert.equal(parseCsv(truthCsv(connectors.rows)).length, connectors.rows.length + 1);
const ci = COLUMNS.indexOf('connector');
assert.ok(parseCsv(truthCsv(connectors.rows)).slice(1).every(r => r[ci] === 'yes'));

// --- the fold is carried into the file -------------------------------------
// With the Delivered filter on, the page counts a task once however many times
// it was submitted. A CSV that disagreed with the figure printed above it
// would be worse than no CSV.
const ready = filterTruth(truth.rows, {delivered: 'ready'});
assert.ok(ready.collapsed, 'the delivered filter folds versions');
const readyRows = parseCsv(truthCsv(ready.rows)).slice(1);
assert.equal(readyRows.length, ready.rows.length);
const vi = COLUMNS.indexOf('versions_counted_once');
const oi = COLUMNS.indexOf('other_versions');
const folded = readyRows.filter(r => Number(r[vi]) > 1);
assert.ok(folded.length, 'some ready tasks were submitted more than once');
folded.forEach(r => assert.equal(r[oi].split(' | ').length, Number(r[vi]) - 1,
  'a folded row must name every version it stands for'));

const names = new Set(readyRows.map(r => r[COLUMNS.indexOf('task_name')]));
assert.equal(names.size, readyRows.length, 'no task may appear twice in a ready export');

// --- the file matches the page ---------------------------------------------
// Both of these are how the export stops being a separate, quietly diverging
// account of the same tasks.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok(/id="tExport"/.test(html), 'the button must exist');
assert.ok(/<script src="csv\.js">/.test(html), 'the page must load the module it calls');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.ok(/renderExportButton\(result\)/.test(app),
  'the count on the button has to be redrawn with the rest of the tab');
assert.ok(/window\.truthCsv\(result\.rows\)/.test(app),
  'the export must write the filtered rows, not truth.rows');

console.log(`csv checks passed: quoting, formula guard, ${COLUMNS.length} columns`);
console.log(`  full export     : ${all.rows.length.toLocaleString()} rows`);
console.log(`  connector only  : ${connectors.rows.length.toLocaleString()} rows`);
console.log(`  ready for delivery: ${ready.rows.length.toLocaleString()} tasks, ${folded.length} of them folded from repeat submissions`);

// --- the GLM band travels with the export -----------------------------------
// The column is on screen, so it has to be in the file people take away. The
// thing worth guarding is the same one the column guards: a task with no
// trials must export blank, never 0. 0/4 says the task was never solved, and
// a spreadsheet full of zeros for tasks nobody trialled would be a false
// claim about every one of them.
{
  const gi = COLUMNS.indexOf('glm_passes');
  const bi = COLUMNS.indexOf('glm_band');
  const ri = COLUMNS.indexOf('glm_rewards');
  assert.ok(gi > -1 && bi > -1 && ri > -1, 'the export must carry the GLM band');

  const sample = parseCsv(truthCsv([
    {name: 'scored', glmPasses: 2, glmTrials: 4, glmRewards: [1, 0, 0, 1]},
    {name: 'zero', glmPasses: 0, glmTrials: 4, glmRewards: [0, 0, 0, 0]},
    {name: 'unscanned'},
  ])).slice(1);
  assert.deepEqual([sample[0][gi], sample[0][bi], sample[0][ri]], ['2', '2/4', '1 | 0 | 0 | 1']);
  assert.deepEqual([sample[1][gi], sample[1][bi]], ['0', '0/4'],
    'a genuine 0/4 must export as 0/4, because it is a real result');
  assert.deepEqual([sample[2][gi], sample[2][bi], sample[2][ri]], ['', '', ''],
    'a task with no trials must export blank, never 0');

  const truth2 = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'),
    read('connector-index.json'), read('glm-index.json'));
  const banded = filterTruth(truth2.rows, {glm: 'band'});
  const out = parseCsv(truthCsv(banded.rows)).slice(1);
  assert.equal(out.length, banded.rows.length);
  assert.ok(out.every(r => r[bi] && r[bi] !== '0/4' && r[bi] !== '4/4'),
    'the 1-3 band filter must export only banded tasks');
  out.forEach(r => assert.equal(Number(r[gi]), r[ri].split(' | ').filter(v => v === '1').length,
    'the exported pass count must be the exact ones in the exported rewards'));

  const none = parseCsv(truthCsv(filterTruth(truth2.rows, {glm: 'none'}).rows)).slice(1);
  assert.ok(none.every(r => r[gi] === '' && r[bi] === ''),
    'unscanned tasks must export with no band at all');
  console.log(`csv carries the GLM band: ${banded.rows.length.toLocaleString()} banded tasks export a band, `
    + `${none.length.toLocaleString()} unscanned export blank`);
}

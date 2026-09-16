// Command view checks. The previous version of this file tested the pre-f4302bd
// architecture (accepted-tasks.js, commandSnapshot().groups, a teamFilter) and had
// been failing on a missing require ever since that redesign. This covers what the
// view actually does now: cross-cohort dedupe, unattributed folders, and the date
// range that slices the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

const elements = new Map();
const element = () => ({value: '', style: {}, textContent: '', innerHTML: '', hidden: false,
  addEventListener() {}, querySelectorAll: () => [], dataset: {}});
const context = vm.createContext({
  window: {}, Intl, console, setInterval() {}, setTimeout() {}, location: {hash: ''},
  getComputedStyle: () => ({getPropertyValue: () => '#000000'}),
  document: {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  },
});

for (const name of ['assets/data.js', 'finalisation.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
}
// init() wires the live DOM; the stub above is not a browser, so skip it.
vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);

// Two folders of one task plus a distinct one: three folders, two tasks, one repeat.
// The middle row has no trainer, and each sits on a different day.
run(`
  gcsPipeline = {generatedAt: '2026-09-15', current: [
    {id: '1', task: 'alpha', trainer: 'a@example.com', status: 'Accepted', date: '2026-09-10'},
    {id: '2', task: 'beta',  trainer: 'b@example.com', status: 'Submitted', date: '2026-09-14'},
    {id: '3', task: 'gamma', trainer: 'b@example.com', status: 'Failed',    date: ''}
  ]};
  finalisationRows = [
    {name: 'alpha', trainer: {email: 'a@example.com'}, date: '2026-09-10'},
    {name: 'alpha', trainer: {email: 'a@example.com'}, date: '2026-09-14'},
    {name: 'beta',  trainer: null,                     date: '2026-09-14'}
  ];
`);

// --- no range: everything counts -----------------------------------------
assert.equal(run('commandSnapshot().folders.length'), 3);
assert.equal(run('commandSnapshot().tasks.size'), 2);
assert.equal(run('commandSnapshot().duplicates'), 1, 'alpha is finalised twice');
assert.equal(run('commandSnapshot().unassigned'), 1, 'beta has no trainer');
assert.equal(run('commandSnapshot().current.length'), 3);

// --- a bound excludes rows outside it, and undated rows drop out ----------
run("byId('commandStart').value = '2026-09-14';");
assert.equal(run('commandSnapshot().folders.length'), 2);
assert.equal(run('commandSnapshot().current.length'), 1, 'undated gamma drops once a bound is set');

run("byId('commandEnd').value = '2026-09-14';");
assert.equal(run('commandSnapshot().folders.length'), 2);
assert.equal(run('commandSnapshot().tasks.size'), 2);
assert.equal(run('commandSnapshot().duplicates'), 0, 'only one alpha folder is in range');

// --- an inverted range returns nothing rather than silently ignoring one end
run("byId('commandStart').value = '2026-09-20'; byId('commandEnd').value = '2026-09-01';");
assert.equal(run('commandDateRange().invalid'), true);
assert.equal(run('commandSnapshot().folders.length'), 0);
assert.equal(run('commandSnapshot().current.length'), 0);

// --- readiness tracks the data loading, not the filter matching -----------
assert.equal(run('commandSnapshot().ready'), true, 'an empty filter result is not an unready page');

// --- clearing both ends restores the unfiltered counts --------------------
run("byId('commandStart').value = ''; byId('commandEnd').value = '';");
assert.equal(run('commandSnapshot().folders.length'), 3);
assert.equal(run('commandSnapshot().current.length'), 3);

console.log('Command checks passed: dedupe, unattributed, date range, inverted range, readiness, clear.');

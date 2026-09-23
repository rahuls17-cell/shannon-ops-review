// The DUP badge on the Accepted rows.
//
// Accepted counts bucket folders, because one folder is one delivered package.
// That is the right unit for a delivery and the wrong one for a task: the same
// task is re-cut under a new folder name after a review, and reappears under a
// console placeholder like `harbor-single-task-2sy38tlg`. Counting folders
// therefore counts some tasks more than once, and nothing on the page said so.
//
// What this checks is that the claim is READ and not guessed. Two things that
// look like they should settle it do not:
//
//   - the folder name. A rule loose enough to join `gen-g236-...` to
//     `gen-g236-...-review-resolved-20260918-rerun` also joins ASTR_101198 to
//     ASTR_101214, which are six separate tasks.
//   - the package bytes. No two packages in the prefix are byte-identical,
//     because a re-cut differs, so the object hash finds nothing.
//
// The `[task] name` inside each package's task.toml does settle it, and that is
// what assets/task-names.json carries.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
const {prepareTruth, filterTruth} = require(path.join(root, 'truth.js'));
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

const names = read('task-names.json');
const model = prepareTruth(read('pipeline-truth.json'), read('delivered-index.json'),
  read('connector-index.json'), read('glm-index.json'), read('cohort-index.json'),
  read('bench-index.json'), names);

// --- the index itself --------------------------------------------------------
{
  assert.ok(names.task && Object.keys(names.task).length > 1000,
    'the folder -> task map must cover the prefix');
  assert.ok(names.counts.distinctTasks < names.counts.folders,
    'if tasks equalled folders there would be nothing to flag');
  const groups = {};
  Object.entries(names.task).forEach(([folder, task]) => {
    (groups[task] = groups[task] || []).push(folder);
  });
  const multi = Object.values(groups).filter(g => g.length > 1);
  assert.strictEqual(multi.length, names.counts.tasksUnderMoreThanOneFolder,
    'the recorded duplicate-group count must match the map it was derived from');
  assert.strictEqual(multi.reduce((n, g) => n + g.length - 1, 0),
    names.counts.foldersAboveTheFirst,
    'the overcount must equal the folders above the first in each group');
  console.log(`task names: ${fmtN(Object.keys(names.task).length)} folders -> ` +
    `${fmtN(names.counts.distinctTasks)} tasks, ${names.counts.tasksUnderMoreThanOneFolder} with duplicates`);
}

// --- the flag lands on every folder of a duplicated task ---------------------
{
  const rows = model.cohortRows;
  assert.ok(rows && rows.length, 'the Accepted view must be the bucket folders');
  const flagged = rows.filter(r => r.dupFolders);
  assert.strictEqual(flagged.length, names.counts.foldersInThoseGroups,
    'every folder in a duplicate group is flagged, not just the extras - each ' +
    'one is equally a folder holding that task');
  const tasks = new Set(flagged.map(r => r.packageTask));
  assert.strictEqual(tasks.size, names.counts.tasksUnderMoreThanOneFolder,
    'the flagged rows must cover exactly the duplicated tasks');
  flagged.forEach(row => {
    assert.ok(row.dupFolders.includes(row.cohortFolder),
      `${row.cohortFolder} must appear in its own group, or the panel cannot mark "this row"`);
    assert.strictEqual(row.duplicateSiblings, row.dupFolders.length - 1,
      'the sibling count excludes the row itself');
    assert.strictEqual(row.duplicateTier, 'confirmed',
      'a read identity is not the same claim as the name heuristic');
  });
  console.log(`DUP: ${flagged.length} rows across ${tasks.size} tasks`);
}

// --- the name heuristic must not leak into the folder view -------------------
// A cohort row spreads the verdict row it matched, and that row may carry the
// name-and-trainer flag. That is a claim about two SUBMISSIONS. Repeating it
// against a folder made 326 rows claim DUP when 98 are duplicates.
{
  const stray = model.cohortRows.filter(r => r.possibleDuplicate && !r.dupFolders);
  assert.strictEqual(stray.length, 0,
    `${stray.length} folder rows carry the heuristic duplicate flag; in the folder ` +
    'view only the read identity counts');
  const shown = filterTruth(model.cohortRows, {duplicate: 'yes'}).rows;
  assert.strictEqual(shown.length, names.counts.foldersInThoseGroups,
    'the Duplicates filter must select exactly the flagged folders');
  console.log(`Duplicates filter under Accepted: ${shown.length} rows, no heuristic leakage`);
}

// --- a task that is NOT duplicated keeps its identity recorded ---------------
{
  const single = model.cohortRows.filter(r => r.packageTask && !r.dupFolders);
  assert.ok(single.length > 900, 'most folders hold a task nothing else holds');
  console.log(`${fmtN(single.length)} folders hold a task no other folder holds`);
}

// --- the badge opens something ----------------------------------------------
{
  assert.ok(/class="flag flag-\$\{esc\(tone\)\} flag-btn"/.test(app),
    'the confirmed DUP must render as a button, not a span: a title attribute ' +
    'cannot hold nine folder names');
  assert.ok(app.includes("closest('.drill-toggle, .flag-btn[data-dup]')"),
    'the badge must be handled by delegation, or it stops working once a filter redraws the table');
  assert.ok(/function dupPanel\(row\)/.test(app), 'the panel must be built from the row');
  const panel = app.slice(app.indexOf('function dupPanel'), app.indexOf('function dupPanel') + 2600);
  ['State', 'Trainer', 'Decided', 'Gate', 'Domain', 'Connector', 'Bench', 'Delivery', 'GLM', 'Runs']
    .forEach(column => assert.ok(panel.includes(`<th>${column}</th>`) || panel.includes(`>${column}<`),
      `the panel must carry the ${column} column, so a duplicate is compared on the same terms`));
  assert.ok(panel.includes('truth.cohortRows'),
    'the siblings must come from the same rows the table shows, not a second source');
  console.log('badge: a delegated button opening a panel with every column');
}

// --- the count pill has to be legible ---------------------------------------
// It shipped as `background: currentColor` with a light `color` on the same
// rule; currentColor resolves to the colour set on that element, so the pill
// came out white on white.
{
  const rule = css.slice(css.indexOf('.flag-btn b'), css.indexOf('.flag-btn b') + 260);
  assert.ok(!/background:\s*currentColor/.test(rule),
    'currentColor on the same element as color is what made the count invisible');
  assert.ok(/background:\s*rgb\(0 0 0/.test(rule),
    'the pill should darken the badge tone it sits on rather than recolour it');
  console.log('count pill: readable on the badge colour');
}

function fmtN(n) { return n.toLocaleString('en-US'); }

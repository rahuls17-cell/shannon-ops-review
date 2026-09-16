const assert = require('node:assert/strict');
const {buildThroughput, acceptedTasks} = require('../throughput.js');

// Prepared finalisation rows, as prepareFinalisation leaves them.
const row = (name, date, bench, type, extra = {}) =>
  ({name, date, bench, filterType: type, outcome: 'accepted', duplicate: false, ...extra});

// --- dedupe: one task, dated by its first acceptance -----------------------
const repeated = acceptedTasks([
  row('alpha', '2026-09-12', 'company', 'Non-connector', {duplicate: false}),
  row('alpha', '2026-09-05', 'company', 'Non-connector', {duplicate: true}),
  row('beta', '2026-09-10', 'computer', 'Non-connector', {outcome: 'rejected'}),
]);
assert.equal(repeated.length, 1, 'rejected rows and repeats do not count');
assert.equal(repeated[0].date, '2026-09-05', 'dated by the earliest acceptance, not the newest archive');

// --- pace and forecast ------------------------------------------------------
// Scan on the 16th, quarter ends the 30th: 14 days left, 7-day window = 9th..15th.
const config = {
  quarterEnd: '2026-09-30', forecastWindowDays: 7,
  targets: [
    {id: 'company', measure: 'company', min: 20, max: 30},
    {id: 'computer', measure: 'computer-nonconnector', min: 10, max: 10},
    {id: 'connector', measure: 'connector', min: 0, max: 0},
    {id: 'aster', measure: null, min: 50, max: 50},
  ],
};
const rows = [];
// Company: 7 tasks inside the window (1/day) -> 7 + 1*14 = 21, on track for 20.
for (let d = 9; d <= 15; d++) rows.push(row(`c${d}`, `2026-09-${String(d).padStart(2, '0')}`, 'company', 'Non-connector'));
// Outside the window and on the partial scan day: counted as delivered, not as pace.
rows.push(row('c-old', '2026-09-01', 'company', 'Non-connector'));
rows.push(row('c-today', '2026-09-16', 'company', 'Non-connector'));
// Computer: 1 task, no pace -> behind on its own, but 7 unattributed non-connector
// tasks at 1/day could carry it: 1+7 + 1*14 = 22 >= 10.
rows.push(row('k1', '2026-09-02', 'computer', 'Non-connector'));
for (let d = 9; d <= 15; d++) rows.push(row(`u${d}`, `2026-09-${String(d).padStart(2, '0')}`, 'unassigned', 'Non-connector'));
// Connector computer-bench work must not count toward the non-connector target.
rows.push(row('k-conn', '2026-09-10', 'computer', 'Connector'));

const model = buildThroughput(rows, config, '2026-09-16');
const by = id => model.targets.find(target => target.id === id);

assert.equal(model.daysLeft, 14);
assert.equal(by('company').measured.delivered, 9, 'window, older and scan-day tasks all delivered');
assert.equal(by('company').measured.perDay, 1, 'scan day and pre-window tasks excluded from pace');
assert.equal(by('company').measured.forecast, 23);
assert.equal(by('company').status.key, 'ok');

assert.equal(by('computer').measured.delivered, 1, 'connector work is not non-connector delivery');
assert.equal(by('computer').status.key, 'depends', 'behind alone, reachable if unattributed work is theirs');
assert.equal(by('computer').bestCase.forecast, 22);

assert.equal(by('connector').measured.delivered, 1);
assert.equal(by('connector').status.key, 'warn', 'a zero target flags new volume still arriving');
assert.equal(by('aster').measured, null);
assert.equal(by('aster').status.key, 'none', 'no source is said, not guessed');

// --- local target edits override the committed file ------------------------
// Company's best case also counts the 7 unattributed tasks: 16 delivered, 2/day -> 44.
const reachable = buildThroughput(rows, config, '2026-09-16', {company: {min: 40, max: 40}});
assert.equal(reachable.targets[0].edited, true);
assert.equal(reachable.targets[0].status.key, 'depends', 'above its own forecast, within the best case');
const unreachable = buildThroughput(rows, config, '2026-09-16', {company: {min: 50, max: 50}});
assert.equal(unreachable.targets[0].status.key, 'warn', 'past even the best case is behind');

// --- chart series: 14 days, cumulative with daily delta ---------------------
const company = model.lines.find(line => line.id === 'company');
assert.equal(company.points.length, 14);
assert.equal(company.points[0].day, '2026-09-03');
assert.equal(company.points.at(-1).total, 9);
assert.equal(company.points.find(p => p.day === '2026-09-12').delta, 1);

console.log('throughput checks passed: dedupe, first-acceptance date, pace window, forecast, attribution status, zero target, overrides, series.');

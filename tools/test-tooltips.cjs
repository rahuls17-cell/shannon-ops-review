// Tooltips have to be true, and the ones that carry numbers have to get them
// from the loaded data. Every hardcoded figure in these went stale at least
// once - 534 rows, 152 delivered, 1,501 of 6,356, "99% are classified" - and
// each time the page said one thing while the tile beside it said another.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// --- every ? button has copy, and every copy is reachable -------------------
const used = [...html.matchAll(/data-info="([a-zA-Z]+)"/g)].map(m => m[1]);
const block = app.slice(app.indexOf('const infoCopy'), app.indexOf('\n};', app.indexOf('const infoCopy')));
const defined = new Set([...block.matchAll(/^  ([a-zA-Z]+):/gm)].map(m => m[1]));
[...new Set(used)].forEach(key => assert.ok(defined.has(key),
  `the ? button for ${key} has no copy behind it`));

// --- the ones about live figures must read them, not hardcode them ----------
const live = ['truthSplit', 'truthDelivered', 'truthConnector', 'truthMakeup',
              'glm', 'cohort', 'truthVersions', 'pipelineAccepted'];
live.forEach(key => {
  const start = block.indexOf(`\n  ${key}: `);
  assert.ok(start > -1, `${key} is missing`);
  const body = block.slice(start, block.indexOf('\n  },', start));
  assert.ok(/^\n {2}\w+: \(\) => \{/.test(body.slice(0, 40)),
    `${key} must be a function so its numbers come from the data`);
  assert.ok(/cohortIndex|deliveredIndex|glmIndex|truth\./.test(body),
    `${key} must read the loaded indexes`);
  // A comma-grouped figure in the prose is a number typed in by hand.
  const prose = body.replace(/fmt\([^)]*\)/g, '');
  const hard = prose.match(/\b\d{1,3},\d{3}\b/g) || [];
  assert.deepEqual(hard, [], `${key} still hardcodes ${hard.join(', ')}`);
});

// --- claims that are no longer true must not come back ----------------------
const gone = [
  ['99% are classified', 'connector coverage is complete for the accepted packages now'],
  ['534 rows for 367 real tasks', 'those counts moved'],
  ['1,501 of the 6,356 rows', 'the pipeline grows every ten minutes'],
  ['the audit against the whole pipeline', 'the join is the manifests against the bucket'],
  ['found plus not found is the 412', 'it is now still-in-the-bucket plus no-longer-there'],
];
gone.forEach(([text, why]) => assert.ok(!app.includes(text),
  `"${text}" is stale: ${why}`));

// --- the Overview must not disagree with the Pipeline -----------------------
const hero = app.slice(app.indexOf('const pipelineAccepted'), app.indexOf('const share ='));
assert.ok(/cohortIndex \? cohortIndex\.counts\.packages/.test(hero),
  'the Overview tile must read the same accepted figure the Pipeline shows');

console.log(`tooltips: ${new Set(used).size} buttons, all with copy; `
  + `${live.length} carry live figures and none is hardcoded`);

// --- a redrawn ? button must still work -------------------------------------
// These were wired one by one at startup, so any tile redrawn afterwards came
// back with a dead button. Several are redrawn, because the indexes load after
// the first paint - the Overview's own "Pipeline accepted" explanation had
// been unreachable for exactly that reason. Delegation survives a redraw.
{
  const wiring = app.slice(app.indexOf('const asWhy ='), app.indexOf('// Chart segments get'));
  assert.ok(wiring, 'the ? buttons must be wired by delegation');
  assert.ok(!/querySelectorAll\('\.why'\)\.forEach/.test(app),
    'per-button wiring dies whenever a tile is re-rendered');
  ['mouseover', 'focusin', 'click'].forEach(evt =>
    assert.ok(wiring.includes(`addEventListener('${evt}'`),
      `${evt} must be delegated too, or the button works by mouse but not keyboard`));
  console.log('? buttons are delegated, so a redrawn tile keeps its explanation');
}

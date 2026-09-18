// The nav, the .view sections and the VIEWS whitelist in app.js must agree.
// A tab present in two of the three renders its data but can never be opened -
// which is exactly how the Carried over tab shipped broken.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const nav = [...html.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]);
const sections = [...html.matchAll(/id="view-([a-z]+)"/g)].map(m => m[1]);
const listed = (app.match(/const VIEWS = \[([^\]]+)\]/) || [])[1];
assert.ok(listed, 'VIEWS not found in app.js');
const views = listed.split(',').map(s => s.trim().replace(/^'|'$/g, ''));

const sorted = a => [...new Set(a)].sort();
assert.deepEqual(sorted(nav), sorted(sections), 'nav tabs and .view sections disagree');
assert.deepEqual(sorted(views), sorted(sections), 'VIEWS whitelist and .view sections disagree');
assert.deepEqual(sorted(views), sorted(nav), 'VIEWS whitelist and nav tabs disagree');

// Every script index.html loads must exist on disk.
for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])) {
  assert.ok(fs.existsSync(path.join(root, src.split('?')[0])), `missing script: ${src}`);
}

console.log(`view checks passed: ${views.length} views agree across nav, sections and VIEWS ` +
  `(${sorted(views).join(', ')})`);

// Reading connector status out of a task.toml.
//
// The trap: `mcp_servers = []` mentions the key and declares nothing. Four
// packages hit exactly that, and a first attempt at this reader called all
// four connectors because a lazy dotall regex skipped the empty brackets and
// ran on to the next `]` several lines below - reading `[environment.env]` as
// the contents. These cases are pinned so that cannot come back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const tool = path.join(root, 'tools', 'read_task_toml.py');
const src = fs.readFileSync(tool, 'utf8');

// Exercise the classifier itself through python, on text rather than a bucket.
const check = text => JSON.parse(execFileSync('python', ['-c', `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location('r', ${JSON.stringify(tool)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
c, gyms, how = m.classify(sys.stdin.read())
print(json.dumps({'connector': c, 'gyms': gyms, 'how': how}))
`], {input: text, encoding: 'utf8'}));

// The four real packages: declared and empty, with more brackets below.
const empty = `[environment]
mcp_servers = []

[environment.env]
FOO = "bar"

[solution.env]
`;
assert.equal(check(empty).connector, false,
  'an empty mcp_servers list is a declaration of nothing');
assert.match(check(empty).how, /empty/);

assert.equal(check('[environment]\nmcp_servers = ["slack-gym", "jira-gym"]\n').connector, true);
assert.deepEqual(check('[environment]\nmcp_servers = ["slack-gym", "jira-gym"]\n').gyms,
  ['jira-gym', 'slack-gym']);

const table = `[[environment.mcp_servers]]
name = "google-drive-gym"

[[environment.mcp_servers]]
name = "email-gym"

[verifier]
`;
assert.equal(check(table).connector, true);
assert.deepEqual(check(table).gyms, ['email-gym', 'google-drive-gym']);

assert.equal(check('[environment]\nimage = "x"\n').connector, false,
  'no mention at all is a non-connector, not an unknown');

// The regex must not be able to cross a line again.
assert.ok(!/re\.S|re\.DOTALL/.test(src.split('def classify')[0]),
  'the inline matcher must not span lines; that is what caused the original error');
assert.ok(src.indexOf('EMPTY.search') < src.indexOf('inline = INLINE.search'),
  'empty must be tested before a non-empty list, or an empty one matches the next bracket');

// What was actually read from the bucket, if it has been run.
const readsPath = path.join(root, 'assets', 'task-toml-reads.json');
if (fs.existsSync(readsPath)) {
  const reads = JSON.parse(fs.readFileSync(readsPath, 'utf8'));
  const rows = Object.entries(reads.reads);
  assert.ok(rows.length > 0);
  rows.forEach(([folder, r]) => {
    assert.ok(r.basis, `${folder} records no basis`);
    assert.ok(r.object && r.object.startsWith('gs://'),
      `${folder} must name the object it was read from`);
    assert.ok(r.connector !== true || r.services.length > 0,
      `${folder} is called a connector with no gyms, which is the empty-list bug`);
  });
  console.log(`task.toml reads: ${rows.length} packages opened, `
    + `${rows.filter(([, r]) => r.connector).length} connector, `
    + `${rows.filter(([, r]) => r.connector === false).length} non-connector`);
}
console.log('task.toml classifier: empty list, inline list, table form and no mention all read correctly');

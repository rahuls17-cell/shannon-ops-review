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

// --- which bench a connector belongs to -------------------------------------
// Derived from the FROM line of environment/Dockerfile, because that is the
// only place it appears: task.toml does not carry it and the bucket scan
// records an image for none of the 2,022 packages it covers.
//
// Pinned against every labelled row of the reference sheet. Order matters in
// the rule and it is easy to get backwards: benchmark-base sits under
// data-obi-rl-gym and is a COMPANY image, while obi-benchmark under
// connectors-rl-gym is a COMPUTER one, so the registry path has to be tested
// before the image name. Testing the name first scored 344/348.
{
  const refPath = path.join(root, 'assets', 'bench-reference.json');
  assert.ok(fs.existsSync(refPath), 'the labelled reference must be committed');
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  assert.ok(ref.labelled.length > 300, 'the reference must cover the whole labelled set');

  const bench = image => JSON.parse(execFileSync('python', ['-c', `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location('r', ${JSON.stringify(tool)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.bench_type(sys.stdin.read().strip())))
`], {input: image, encoding: 'utf8'}));

  // Every distinct image in the reference, checked once.
  const distinct = new Map();
  ref.labelled.forEach(r => distinct.set(r.image, r.bench));
  let checked = 0;
  distinct.forEach((expected, image) => {
    assert.equal(bench(image), expected,
      `${image.slice(0, 70)} should be ${expected}`);
    checked += 1;
  });

  // The ordering trap, stated as its own case so it cannot regress quietly.
  assert.equal(bench('us-central1-docker.pkg.dev/delivery-g-obi/data-obi-rl-gym/benchmark-base@sha256:x'),
    'company bench zeta', 'benchmark-base under data-obi-rl-gym is a company image');
  assert.equal(bench('us-central1-docker.pkg.dev/delivery-g-obi/connectors-rl-gym/obi-benchmark@sha256:x'),
    'computer bench synth', 'connectors-rl-gym at a digest the register does not list is a computer image');
  assert.equal(bench('kuzphi/connectors-harness-aster:company-aster-v6'), 'company bench aster',
    'aster is a company bench despite the connectors-harness name');
  assert.equal(bench('kuzphi/connectors-harness:real-data-v4'), 'computer bench real');
  assert.equal(bench('python:3.12-slim-bookworm'), null,
    'a plain base image is not a bench at all');

  // The image register Rahul shared: every Zeta and Aster image in it.
  const register = {
    'us-central1-docker.pkg.dev/delivery-g-obi/data-obi-rl-gym/benchmark-base@sha256:ccc08929160ba6a33ba86c070a240f0865c75f83a20b981e6e571998b8b41c83': 'company bench zeta',
    'docker.io/kuzphi/company-bench-private@sha256:ccc08929160ba6a33ba86c070a240f0865c75f83a20b981e6e571998b8b41c83': 'company bench zeta',
    'us-central1-docker.pkg.dev/delivery-g-obi/data-obi-rl-gym/benchmark-base@sha256:975f115a995790786a6dbf124204433ccf77460f0277227fbdd21745388e56ca': 'company bench zeta',
    'docker.io/kuzphi/company-bench-private@sha256:cb2fee77bd5b1bbe02471664111fae13711c2a0851147f7da987105bf015f293': 'company bench zeta',
    'us-central1-docker.pkg.dev/delivery-g-obi/connectors-rl-gym/obi-benchmark@sha256:1e2fbc7a1278c395f1d80d97fa468429854827776b70e84e056789b0f73112c8': 'company bench zeta',
    'docker.io/kuzphi/company-bench-private@sha256:1e2fbc7a1278c395f1d80d97fa468429854827776b70e84e056789b0f73112c8': 'company bench zeta',
    'kuzphi/company-bench-private:zeta-newdbs2-20260918': 'company bench zeta',
    'us-central1-docker.pkg.dev/delivery-g-obi/connectors-rl-gym/connectors-harness-aster@sha256:832fec69897f00d324614205d2e70797eab8e991d7b172ea1a52091181011ae2': 'company bench aster',
    'us-central1-docker.pkg.dev/delivery-g-obi/connectors-rl-gym/connectors-harness-aster@sha256:3623dc5a28e7e7823e2760342ee389c5b82702c6e5e3739cc918bb4fea69ab44': 'company bench aster',
    'docker.io/kuzphi/connectors-harness-aster@sha256:9ee229262fbfc9c57b6f5f54e589296c980f68e7d4655cecba12cfe2b393adf3': 'company bench aster',
  };
  Object.entries(register).forEach(([image, expected]) =>
    assert.equal(bench(image), expected, `register: ${image.slice(0, 80)} should be ${expected}`));

  // The page applies the same rule to the cached readings; it must agree with
  // this one on every image the bench index holds.
  const {benchOfImage} = require(path.join(root, 'truth.js'));
  const index = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'bench-index.json'), 'utf8'));
  const images = [...new Set(Object.values(index.bench).map(v => v.image).filter(Boolean)), ...Object.keys(register)];
  const py = JSON.parse(execFileSync('python', ['-c', `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location('r', ${JSON.stringify(tool)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.bench_type(i) for i in json.loads(sys.stdin.read())]))
`], {input: JSON.stringify(images), encoding: 'utf8'}));
  images.forEach((image, i) => assert.equal(benchOfImage(image), py[i], `the page and the scanner disagree on ${image.slice(0, 80)}`));

  const counts = {};
  ref.labelled.forEach(r => { counts[r.bench] = (counts[r.bench] || 0) + 1; });
  console.log(`bench rule: ${checked} distinct images, ${ref.labelled.length} labelled rows, all reproduced`);
  console.log('  ' + Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' | '));
}

// --- FROM takes flags before the image ---------------------------------------
// `FROM --platform=linux/amd64 <image>` is the common spelling here. Reading the
// first token after FROM captured the flag as the image for 106 tasks, every one
// of which then classified as no bench at all - including all 27 accepted
// connectors that had no bench. The flags have to be skipped.
{
  const src = fs.readFileSync(path.join(__dirname, 'read_task_toml.py'), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('FROM_LINE'));
  assert.ok(line, 'read_task_toml.py must define FROM_LINE');
  assert.ok(line.includes('--'),
    'FROM_LINE must skip the flags, or --platform is read as the image');
  const body = line.slice(line.indexOf("r'") + 2, line.lastIndexOf("'"));
  const re = new RegExp(body.replace(/\s/g, '\s'), 'i');
  const cases = [
    ['FROM --platform=linux/amd64 reg/connectors-rl-gym/obi:v3', 'reg/connectors-rl-gym/obi:v3'],
    ['FROM reg/connectors-harness-aster/base:v1', 'reg/connectors-harness-aster/base:v1'],
    ['FROM --platform=linux/amd64 --x=1 d/benchmark-base:v2', 'd/benchmark-base:v2'],
  ];
  cases.forEach(([line_, want]) => {
    const got = re.exec(line_);
    assert.ok(got, `no FROM match in ${line_}`);
    assert.strictEqual(got[1], want, `wrong image from ${line_}`);
  });
  console.log('FROM line: flags skipped, image taken');
}

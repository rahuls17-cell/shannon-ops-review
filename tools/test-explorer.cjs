const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createExplorer, shardOf, sha1} = require('../explorer.js');

// The browser computes a folder's shard rather than looking it up, so the JS
// implementation MUST agree with the Python indexer byte for byte. A mismatch
// would not throw - every folder would simply come back empty.
const pythonShard = (path, buckets) =>
  crypto.createHash('sha1').update(path, 'utf8').digest().readUInt32BE(0) % buckets;

const paths = [
  '', 'a', 'ab', 'abc', 'abcd', 'abcde', 'tasks', 'trainer',
  'tasks/finalization_qc_accepted',
  'tasks/finalisation_client_qc_accepted_iteration_2/code-c471-nft-wallet-holder-of-record',
  'trainer/evaluation-6efde4b4842e4c18',
  'üñïçødé/path',
  'emoji/\u{1F4C1}/folder',
  'x'.repeat(200),
  'a/'.repeat(120),
];
for (const path of paths) {
  assert.equal(shardOf(path, 512), pythonShard(path, 512), `shard mismatch for ${JSON.stringify(path.slice(0, 40))}`);
  assert.equal(shardOf(path, 64), pythonShard(path, 64), `shard mismatch at 64 buckets for ${path.slice(0, 40)}`);
}

// Random paths, because the hand-picked ones all happen to be short or ASCII.
for (let i = 0; i < 500; i += 1) {
  const path = crypto.randomBytes(1 + (i % 90)).toString('base64url');
  assert.equal(shardOf(path, 512), pythonShard(path, 512), `shard mismatch for random ${path}`);
}

// sha1 itself, against node's implementation, at the block boundaries where a
// hand-rolled implementation usually breaks (55/56/63/64/119/120 bytes).
for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
  const message = 'x'.repeat(size);
  const mine = sha1(message).map(word => (word >>> 0).toString(16).padStart(8, '0')).join('');
  assert.equal(mine, crypto.createHash('sha1').update(message).digest('hex'), `sha1 wrong at ${size} bytes`);
}

// Shard indexes must stay inside the bucket range.
for (let i = 0; i < 200; i += 1) {
  const value = shardOf(`folder/${i}`, 512);
  assert.ok(Number.isInteger(value) && value >= 0 && value < 512, `shard out of range: ${value}`);
}

// --- explorer behaviour, against a stubbed index --------------------------
const SHARDS = {};
const manifest = {shardBuckets: 512, scope: ['tasks/demo/'], objects: 3, folders: 2};
const put = (path, entry) => {
  const bucket = shardOf(path, 512);
  (SHARDS[bucket] = SHARDS[bucket] || {})[path] = entry;
};
put('', {dirs: ['tasks'], files: []});
put('tasks/demo', {dirs: ['inner'], files: [['b.txt', 20, '2026-09-02T00:00:00Z'], ['a.txt', 300, '2026-09-01T00:00:00Z']]});

global.fetch = async url => {
  if (url.endsWith('manifest.json')) return {ok: true, json: async () => manifest};
  const match = /shards\/(\d{3})\.json$/.exec(url);
  if (match) return {ok: true, json: async () => SHARDS[Number(match[1])] || {}};
  return {ok: false, status: 404};
};

(async () => {
  const explorer = createExplorer({base: 'idx'});
  await explorer.load();

  const root = await explorer.open('');
  assert.deepEqual(root.dirs.map(d => d.name), ['tasks']);
  assert.equal(root.dirs[0].path, 'tasks');

  const demo = await explorer.open('tasks/demo');
  assert.equal(demo.files.length, 2);
  assert.equal(demo.bytes, 320);
  assert.equal(demo.files[0].path, 'tasks/demo/b.txt');
  assert.equal(demo.dirs[0].path, 'tasks/demo/inner');
  assert.equal(demo.missing, false);

  // Trailing and leading slashes must resolve to the same folder.
  assert.equal((await explorer.open('/tasks/demo/')).files.length, 2);

  // A folder inside the scope but absent from the index was pruned; one outside
  // the scope was never indexed. The UI says different things, so they differ.
  const pruned = await explorer.open('tasks/demo/gone');
  assert.equal(pruned.missing, true);
  assert.equal(pruned.inScope, true);
  const outside = await explorer.open('worker/somewhere');
  assert.equal(outside.missing, true);
  assert.equal(outside.inScope, false);

  assert.deepEqual(explorer.crumbs('tasks/demo/inner').map(c => c.path),
    ['tasks', 'tasks/demo', 'tasks/demo/inner']);

  const short = await explorer.findFolders('ab', 10);
  assert.equal(short.rows.length, 0);
  assert.match(short.reason, /three characters/);

  console.log('explorer checks passed: shard agreement with Python, sha1, path resolution, scope vs pruned');
})().catch(error => { console.error(error); process.exit(1); });

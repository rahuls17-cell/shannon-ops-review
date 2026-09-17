(function (root) {
  // GCS file explorer. Metadata only - this never fetches object bytes.
  //
  // The index is published as a fixed number of shards. A folder's shard is
  // COMPUTED from its path (sha1 % shardBuckets), so the browser needs no
  // folder -> shard lookup table; at 30k+ folders such a table would be a
  // bigger download than the data it indexes.
  //
  // Scope is the delivery prefixes only. The full bucket is 22.5M+ objects and
  // 9.3M+ folders, which cannot be mirrored into a static site - openScope()
  // reports what is and is not covered so the UI can say so.

  function sha1(message) {
    // Minimal SHA-1; we only need the first 4 bytes and Web Crypto is async.
    const rotl = (n, s) => (n << s) | (n >>> (32 - s));
    const bytes = new TextEncoder().encode(message);
    const total = ((bytes.length + 8) >> 6 << 4) + 16;
    const words = new Uint32Array(total);
    for (let i = 0; i < bytes.length; i += 1) {
      words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    }
    words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
    words[total - 1] = bytes.length * 8;

    const h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    const w = new Uint32Array(80);
    for (let block = 0; block < total; block += 16) {
      for (let i = 0; i < 16; i += 1) w[i] = words[block + i];
      for (let i = 16; i < 80; i += 1) {
        w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      }
      let [a, b, c, d, e] = h;
      for (let i = 0; i < 80; i += 1) {
        const f = i < 20 ? ((b & c) | (~b & d)) + 0x5A827999
          : i < 40 ? (b ^ c ^ d) + 0x6ED9EBA1
          : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8F1BBCDC
          : (b ^ c ^ d) + 0xCA62C1D6;
        const t = (rotl(a, 5) + f + e + w[i]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = t;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
    }
    return h;
  }

  function shardOf(folder, buckets) {
    // First four bytes of the digest, as the indexer does.
    return ((sha1(folder)[0] >>> 0) % buckets);
  }

  function createExplorer(options) {
    const base = (options && options.base) || 'gcs-index';
    const cache = new Map();
    let manifest = null;

    async function load() {
      if (manifest) return manifest;
      const response = await fetch(`${base}/manifest.json`, {cache: 'no-store'});
      if (!response.ok) throw new Error(`index manifest unavailable (${response.status})`);
      manifest = await response.json();
      return manifest;
    }

    async function shard(index) {
      if (cache.has(index)) return cache.get(index);
      const name = String(index).padStart(3, '0');
      const pending = fetch(`${base}/shards/${name}.json`)
        .then(response => {
          if (!response.ok) throw new Error(`shard ${name} unavailable (${response.status})`);
          return response.json();
        })
        .catch(error => { cache.delete(index); throw error; });
      cache.set(index, pending);
      return pending;
    }

    // One folder's direct children. `path` is the GCS prefix without a
    // trailing slash; '' is the bucket root.
    async function open(path) {
      const meta = await load();
      const key = String(path || '').replace(/^\/+|\/+$/g, '');
      const body = await shard(shardOf(key, meta.shardBuckets));
      const entry = body[key];
      if (!entry) {
        return {path: key, dirs: [], files: [], missing: true,
                inScope: inScope(key, meta)};
      }
      return {
        path: key,
        dirs: entry.dirs.map(name => ({name, path: key ? `${key}/${name}` : name})),
        files: entry.files.map(([name, size, updated]) => ({
          name, size, updated, path: key ? `${key}/${name}` : name,
        })),
        bytes: entry.files.reduce((total, row) => total + row[1], 0),
        missing: false,
        inScope: true,
      };
    }

    function inScope(path, meta) {
      const scope = (meta && meta.scope) || [];
      const key = `${path}/`;
      return scope.some(prefix => key.startsWith(prefix) || prefix.startsWith(key));
    }

    function crumbs(path) {
      const parts = String(path || '').split('/').filter(Boolean);
      return parts.map((name, index) => ({
        name, path: parts.slice(0, index + 1).join('/'),
      }));
    }

    // Search is over folder paths, which the tree holds; file names live in
    // the shards and are only searched within an opened folder.
    async function findFolders(term, limit) {
      const meta = await load();
      const needle = String(term || '').trim().toLowerCase();
      if (needle.length < 3) return {rows: [], reason: 'Type at least three characters'};
      if (!meta.treeLoaded) {
        const response = await fetch(`${base}/tree.json`);
        if (!response.ok) return {rows: [], reason: 'Folder tree unavailable'};
        meta.tree = await response.json();
        meta.treeLoaded = true;
      }
      const rows = [];
      for (const path of Object.keys(meta.tree)) {
        if (path.toLowerCase().includes(needle)) {
          rows.push(path);
          if (rows.length >= (limit || 200)) break;
        }
      }
      return {rows, reason: rows.length ? '' : 'No folder matches'};
    }

    return {load, open, crumbs, findFolders, shardOf, scopeOf: () => manifest};
  }

  root.createExplorer = createExplorer;
  root.explorerShardOf = shardOf;
  if (typeof module !== 'undefined') module.exports = {createExplorer, shardOf, sha1};
})(typeof window === 'undefined' ? globalThis : window);

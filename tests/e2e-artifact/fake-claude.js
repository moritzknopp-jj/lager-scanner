// Stand-in for claude.ai's window.claude runtime (db, sample, downloads, assets), injected before the page loads.
// Follows the documented call shapes: db.doc/collection, onSnapshot, sample.json(prompt, {images, model}),
// downloads.save({filename, data}), assets.upload(blob).
export function installFakeClaude({ dbKey }) {
  const KEY = 'fakedb:' + dbKey;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const store = new Map(JSON.parse(localStorage.getItem(KEY) || '[]'));
  const persist = () => localStorage.setItem(KEY, JSON.stringify([...store]));
  const subs = new Set();

  // claude.ai hands out read-only snapshot data (Safari: "Attempted to assign to readonly property").
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  const snapDoc = (path) => {
    const d = store.get(path);
    return { id: path.split('/').pop(), exists: !!d, data: () => (d ? deepFreeze(clone(d)) : undefined), metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) };
  };
  const querySnap = (q) => {
    const depth = q.coll.split('/').length + 1;
    let docs = [...store.keys()].filter((k) => k.startsWith(q.coll + '/') && k.split('/').length === depth).sort().map(snapDoc);
    if (q.order) {
      const { f, d } = q.order;
      docs = docs.filter((s) => s.data()[f] !== undefined).sort((a, b) => (a.data()[f] < b.data()[f] ? -1 : a.data()[f] > b.data()[f] ? 1 : 0) * (d === 'desc' ? -1 : 1));
    }
    if (q.limit) docs = docs.slice(0, q.limit);
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const fire = () => { for (const s of subs) setTimeout(() => s.cb(s.q ? querySnap(s.q) : snapDoc(s.path)), 0); };
  const check = (d) => { if (!d || typeof d !== 'object' || Array.isArray(d)) throw { code: 'invalid_argument', message: 'body must be an object' }; if (JSON.stringify(d).length > 262144) throw { code: 'invalid_argument', message: 'document over 256 KiB' }; };

  const doc = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => snapDoc(path),
    set: async (d) => { check(d); store.set(path, clone(d)); persist(); fire(); },
    update: async (d) => { if (!store.has(path)) throw { code: 'invalid_argument' }; store.set(path, { ...store.get(path), ...clone(d) }); persist(); fire(); },
    delete: async () => { store.delete(path); persist(); fire(); },
    onSnapshot: (cb) => { const s = { path, cb }; subs.add(s); setTimeout(() => cb(snapDoc(path)), 0); return () => subs.delete(s); },
    collection: (c) => query(path + '/' + c),
  });
  const query = (coll, order = null, limit = null) => {
    const q = { coll, order, limit };
    return {
      path: coll,
      orderBy: (f, d = 'asc') => query(coll, { f, d }, limit),
      limit: (n) => query(coll, order, n),
      where() { return this; },
      get: async () => querySnap(q),
      onSnapshot: (cb) => { const s = { q, cb }; subs.add(s); setTimeout(() => cb(querySnap(q)), 0); return () => subs.delete(s); },
      doc: (id) => doc(coll + '/' + (id || Math.random().toString(36).slice(2))),
      add: async (d) => { const r = doc(coll + '/' + Math.random().toString(36).slice(2)); await r.set(d); return r; },
    };
  };
  const db = { doc, collection: (c) => query(c) };

  // Another device writing: used by the sync test.
  window.__fakeDb = {
    remoteSet: (path, data) => { store.set(path, clone(data)); persist(); fire(); },
    get: (path) => clone(store.get(path) || null),
    paths: () => [...store.keys()],
  };

  const toB64 = async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  };

  const json = async (input, opts = {}) => {
    const images = opts.images ? [].concat(opts.images) : [];
    const r = await window.__sampleReply(String(input), images.length, opts.model || '', opts.modelTier || '');
    if (r && r.__error) throw { code: r.__error, message: r.__error };
    return r;
  };
  const sample = Object.assign(async (input, opts) => ({ text: JSON.stringify(await json(input, opts)), truncated: false }), {
    json,
    limits: async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 5_000_000, mediaTypes: ['image/jpeg', 'image/png'] } }),
  });

  const blobs = new Map();
  const assets = {
    upload: async (blob) => { const id = Math.random().toString(16).slice(2).padEnd(32, '0'); blobs.set(id, blob); return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: blob.type }; },
    list: async () => ({ assets: [...blobs.keys()].map((id) => ({ id })), usage: {} }),
    delete: async (id) => { blobs.delete(id); },
  };
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      await window.__savedFile(filename, await toB64(blob));
      return { status: 'saved' };
    },
  };

  const caps = { db, sample, assets, downloads };
  window.claude = { use: async (name) => caps[name] ?? null };
}

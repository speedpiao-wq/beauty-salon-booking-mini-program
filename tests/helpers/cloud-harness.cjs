// Local behavioral harness: snapshot isolation, per-document write conflict and SDK-style retry.
// It never connects to WeChat and does not substitute for deployed-cloud acceptance.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const clone = value => structuredClone(value);
const predicate = fn => ({ test: fn, and(other) { return predicate(x => fn(x) && other.test(x)); } });
const command = {
  gt: v => predicate(x => x > v), gte: v => predicate(x => x >= v),
  lt: v => predicate(x => x < v), lte: v => predicate(x => x <= v),
  eq: v => predicate(x => x === v), neq: v => predicate(x => x !== v),
  in: v => predicate(x => v.includes(x)), inc: value => ({ increment: value }),
};
function createHarness(fixtures = {}, options = {}) {
  let records = clone(fixtures);
  const revisions = new Map();
  const stats = { attempts: 0, conflicts: 0, commits: 0 };
  const reads = [];
  function database(snapshot, writes) {
    return { command, collection(name) {
      const query = { filter: {}, sorts: [], offset: 0, count: 100,
        where(value) { this.filter = value; return this; },
        orderBy(key, direction) { this.sorts.push([key, direction]); return this; },
        skip(value) { this.offset = value; return this; }, limit(value) { this.count = value; return this; },
        async get() {
          reads.push(name);
          let rows = (snapshot[name] || []).filter(row => Object.entries(this.filter).every(([key, value]) => value && value.test ? value.test(row[key]) : value === row[key]));
          rows = rows.slice().sort((a, b) => {
            for (const [key, direction] of this.sorts) { const diff = String(a[key]).localeCompare(String(b[key])); if (diff) return direction === 'desc' ? -diff : diff; }
            return 0;
          });
          return { data: clone(rows.slice(this.offset, this.offset + this.count)) };
        },
        doc(id) {
          function write(data, merge) {
            if (options.failCollection === name) throw new Error('TEST_WRITE_FAILURE');
            if (!writes) throw new Error('Unexpected non-transactional write');
            snapshot[name] ||= [];
            const index = snapshot[name].findIndex(row => row._id === id);
            if (merge && index < 0) throw new Error('DOCUMENT_NOT_FOUND');
            const row = merge ? { ...snapshot[name][index] } : { _id: id };
            for (const [key, value] of Object.entries(data)) row[key] = value && value.increment !== undefined ? (Number(row[key]) || 0) + value.increment : clone(value);
            if (index < 0) snapshot[name].push(row); else snapshot[name][index] = row;
            writes.set(`${name}/${id}`, { name, id, row });
          }
          return {
            async get() { reads.push(name); return { data: clone((snapshot[name] || []).find(row => row._id === id)) }; },
            async set({ data }) { write(data, false); }, async update({ data }) { write(data, true); },
          };
        },
      };
      return query;
    } };
  }
  const db = { command, collection(name) { return database(records).collection(name); }, async runTransaction(callback) {
    for (let attempt = 0; attempt < 4; attempt++) {
      stats.attempts++;
      const baseRevisions = new Map(revisions), snapshot = clone(records), writes = new Map();
      const result = await callback(database(snapshot, writes));
      if ([...writes.keys()].some(key => (baseRevisions.get(key) || 0) !== (revisions.get(key) || 0))) {
        stats.conflicts++;
        if (attempt === 3) throw new Error('database transaction conflict');
        continue;
      }
      for (const [key, { name, id, row }] of writes) {
        records[name] ||= [];
        const index = records[name].findIndex(item => item._id === id);
        if (index < 0) records[name].push(clone(row)); else records[name][index] = clone(row);
        revisions.set(key, (revisions.get(key) || 0) + 1);
      }
      stats.commits++;
      return result;
    }
  } };
  return { stats, reads, data: () => clone(records), function(name, openid = 'founder') {
    const scope = { exports: {}, Date, console: { error() {}, warn() {} }, require(dependency) {
      if (dependency === 'crypto') return crypto;
      if (dependency === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db, getWXContext: () => ({ OPENID: openid }) };
      throw new Error(dependency);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions', name, 'index.js'), 'utf8'), scope);
    return scope.exports.main;
  } };
}
module.exports = { createHarness, root };

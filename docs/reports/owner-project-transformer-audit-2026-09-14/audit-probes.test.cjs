// Read-only audit characterizations. PASS means observed behavior was reproduced,
// not that the behavior is correct. No app boot, production IO, or source edits.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const root = process.env.OWNER_PROJECT_AUDIT_ROOT || path.join(os.homedir(), 'owner-project-central-server');
const transformer = path.join(root, 'Services/Transformer');
const appRequire = createRequire(path.join(root, 'package.json'));
const acorn = appRequire('acorn');
const quiet = { log() {}, error() {}, warn() {}, time() {}, timeEnd() {} };
function ast(file) {
  const source = fs.readFileSync(file, 'utf8');
  return { source, tree: acorn.parse(source, { ecmaVersion: 'latest' }) };
}
function method(file, className, name, bindings = {}) {
  const { source, tree } = ast(file);
  const cls = tree.body.find(n => n.type === 'ClassDeclaration' && n.id.name === className);
  const fn = cls.body.body.find(n => n.key.name === name).value;
  const code = `(${fn.async ? 'async ' : ''}function${source.slice(fn.start, fn.end)})`;
  return vm.runInNewContext(code, { console: quiet, structuredClone, Map, Set, ...bindings });
}
function load(file, deps) {
  const module = { exports: {} };
  const scope = { module, exports: module.exports, console: quiet, Map, Set, structuredClone,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name];
      throw Error(`Unapproved import: ${name}`);
    } };
  scope.global = scope;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), scope, { filename: file, timeout: 2000 });
  return module.exports;
}
const comparator = load(path.join(transformer, 'SpecObjComparator.js'), {
  'owner-project-libs/AviUtil': {}, 'graph-data-structure': appRequire('graph-data-structure'),
  crypto: require('node:crypto'),
});
const computer = require(path.join(transformer, 'ComparatorConfigs/Computer.js'));
test('positive: RAM comparison orders capacity and recognizes equality', () => {
  const fn = computer.specObj.CUSTOM.find(([props]) => props[0] === 'ram')[1].theFunc;
  assert.equal(fn('8GB', '16GB'), -1);
  assert.equal(fn('16GB', '8GB'), 1);
  assert.equal(fn('16GB', '16GB'), 0);
});
test('positive: opposing property improvements are incomparable, not a scalar score', () => {
  const c = new comparator();
  c.specObjCompareFunctions = new Map([['ram', () => 1], ['disk', () => -1]]);
  assert.equal(c.compare({}, {}), undefined);
});
test('characterization: swapped-drive superiority loses the reverse comparison', () => {
  const fn = computer.specObj.CUSTOM.find(([props]) => props[0] === 'hd1')[1].theFunc;
  const larger = ['2000SSD', '500SSD'], smaller = ['250SSD', '1000SSD'];
  assert.equal(fn(smaller, larger), -1);
  assert.equal(fn(larger, smaller), undefined, 'expected mathematical inverse would be +1');
});
test('positive: physical upgrade and superior-spec substitution are distinct paths', () => {
  const c = new comparator();
  Object.assign(c, {
    skuToGroupMap: {}, groupingRules: [{ groupName: 'synthetic', propRegexMap: {} }],
    upgradeGroupMap: { synthetic: { functionMap: { ram: () => 20 } } },
    specObjCompareFunctions: new Map([['ram', (a, b) => Math.sign(parseInt(a.ram) - parseInt(b.ram))]]),
    propCompareFunctions: new Map(), allProperties: ['ram'],
    miscRules: { fixedUpgradeCost: 5, percentUpgradeCost: 10 },
  });
  const up = c.getTransforms({ sku: 'a', ram: '8GB' }, { sku: 'b', ram: '16GB' });
  assert.equal(up.transformable, true);
  assert.equal(up.cost, 27);
  const sub = c.getTransforms({ sku: 'b', ram: '16GB' }, { sku: 'a', ram: '8GB' });
  assert.equal(sub.transformable, true);
  assert.equal(sub.cost, 0);
  assert.equal(Object.keys(sub.impersonations).length, 1);
});
test('characterization: missing SQLite weight shifts later weight to an earlier pair', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE W0_0(fromIndex INTEGER,toIndex INTEGER,weight REAL); INSERT INTO W0_0 VALUES(1,1,77);');
    const Getter = require(path.join(transformer, 'WeightGetterByCategoryGroup.js'));
    const getter = new Getter(null, async sql => db.prepare(sql).all(), 'W', 0);
    const rows = await getter.getWeightsFromTos(0, [[0, 0], [1, 1]]);
    assert.equal(rows[0].weight, 77, 'query consumer pairs this with [0,0], not [1,1]');
    assert.equal(rows[1], undefined);
  } finally { db.close(); }
});
test('positive: complete SQLite pair rows retain requested order', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE W0_0(fromIndex INTEGER,toIndex INTEGER,weight REAL); INSERT INTO W0_0 VALUES(1,1,77),(0,0,22);');
    const Getter = require(path.join(transformer, 'WeightGetterByCategoryGroup.js'));
    const rows = await new Getter(null, async sql => db.prepare(sql).all(), 'W', 0)
      .getWeightsFromTos(0, [[0, 0], [1, 1]]);
    assert.deepEqual(rows.map(r => r.weight), [22, 77]);
  } finally { db.close(); }
});
test('characterization: child exit does not settle pending RPC; success retains callback', async () => {
  class Child extends EventEmitter { send() {} kill() {} }
  let id = 0;
  const file = appRequire.resolve('owner-project-libs/ProcessRouterParent.js');
  const Router = load(file, {
    'node:child_process': { fork: () => new Child() },
    './AviUtil.js': { generateAlphaNumericKey: () => String(++id) },
    './Serializer.cjs': { Serializer: { stringify: JSON.stringify, parse: JSON.parse } },
  });
  const r = new Router();
  await r.spawnChild('synthetic', 0, []);
  const first = r.runOnChild(0, 'query', []);
  r.children[0].emit('message', JSON.stringify({ messageId: '1', res: 7 }));
  assert.equal(await first, 7);
  assert.ok(r.waitingOnResponseMap['1']);
  let settled = false;
  r.runOnChild(0, 'query', []).then(() => { settled = true; }, () => { settled = true; });
  r.children[0].emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
});
test('characterization: category failure returns a success-shaped partial result', async () => {
  let dispatched = false;
  class MemoryMap extends Map { async wait() {} transaction(fn) { fn(); } }
  class Properties extends Map { async createView(_name, keys) { return new Map(keys.map(k => [k, this.get(k)])); } drop() {} }
  const maps = [];
  class SharedMap extends MemoryMap { constructor() { super(); maps.push(this); } }
  const query = method(path.join(transformer, 'SKUTransformerMaster.js'), 'SKUTransformerMaster', 'query', {
    SharedMap, GC: { MEMORYSTORE: 'synthetic' },
    DataStore: { loadData: async () => {}, constructor: { upcToAsinMap: new Map() },
      getAsinAssociations: async () => new Map() },
    getSkusCategorized: () => ({ categoryToSkusArrayMap: [['a']], categoryToSubIdArrayMap: [], undefineds: [] }),
    extractGroupFromSKU: x => x,
  });
  const result = await query.call({
    categoryIndexes: [0], skuToCategoryIndexMap: { a: 0 },
    processorRouter: { runOnChild: async () => { dispatched = true; throw Error('synthetic child failure'); } },
  }, 'audit', {}, [], [], [], ['SKU'], '', [], undefined,
  new Properties([['a', { cost: 10, qty: 1 }]]), false, 'unused', 'OBJECT', 'audit', {});
  assert.ok(result.TO.SKU);
  assert.equal(dispatched, true, 'positive control: failure-producing child was actually reached');
  assert.equal(result.err, undefined);
  assert.equal(result.STATS.totalPathCount, 0);
  assert.equal(result.failedCategories, undefined);
});
test('characterization: inventory convenience path calls a missing inflate method', async () => {
  const file = path.join(transformer, 'Transformer.js');
  const { tree } = ast(file);
  const cls = tree.body.find(n => n.type === 'ClassDeclaration' && n.id.name === 'TransformerInterface');
  assert.equal(cls.body.body.some(n => n.key.name === 'inflate'), false);
  const Parent = load(path.join(root, 'lib/OwnerProjectInterface.js'), {
    fs: {}, './Util': {}, './Logger': class {}, '../lib/Communicator.js': class {},
    'node-fetch': () => { throw Error('network forbidden'); },
  });
  assert.equal(typeof Parent.inflate, 'undefined', 'checked actual inherited static surface');
  const fn = method(file, 'Transformer', 'queryWithInstockInventory', {
    DataStore: { loadData: async () => {} }, GC: { TRANSFORMER_SITE: 'synthetic' },
    AviUtil: { getRandomString: () => 'audit' }, TransformerInterface: class extends Parent {},
  });
  await assert.rejects(fn.call({
    com: { res: async () => ({}) },
    runWithStockQuery: async () => ({ ALL: { FROM: {}, TO: {}, STATS: {} } }),
  }, { query: {}, generateUpdatesArg: {}, combine: true }), /inflate is not a function/);
});
test('characterization: save removes existing folder before undefined-identifier failure', async () => {
  const calls = [];
  const fn = method(path.join(transformer, 'Transformer.js'), 'Transformer', 'saveTransformerToFileFBE', {
    rootDir: 'synthetic', fsExists: () => true, skuTransformerMap: { model: {} },
    AviUtil: { getOrThrow: (o, k) => o[k] },
    fs: { rm: async p => calls.push(['rm', p]), mkdir: async p => calls.push(['mkdir', p]) },
  });
  await assert.rejects(fn.call({}, { name: 'model' }), /transformerName is not defined/);
  assert.deepEqual(calls.map(c => c[0]), ['rm', 'mkdir']);
});

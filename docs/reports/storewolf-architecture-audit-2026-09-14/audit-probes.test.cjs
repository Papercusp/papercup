// Audit characterizations: passing means the described behavior was reproduced,
// NOT that the behavior is desirable. No app boot, real credentials, DB or external IO.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const os = require('node:os');
const root = process.env.STOREWOLF_AUDIT_ROOT || path.join(os.homedir(), 'storewolf-central-server');
const lib = process.env.STOREWOLF_LIBS_AUDIT_ROOT || path.join(os.homedir(), 'Storewolf-Libs');
const appRequire = createRequire(path.join(root, 'package.json'));
const quiet = { log() {}, error() {}, group() {}, groupEnd() {} };
const util = { generateAlphaNumericKey: () => 'synthetic-request', sleep: async () => {} };
const serializer = { stringify: JSON.stringify, parse: JSON.parse, serialize: x => x, deserialize: async x => x };
function load(file, deps, extras = {}) {
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console: quiet,
    require(name) {
      if (Object.hasOwn(deps, name)) return deps[name];
      throw new Error(`Unexpected dependency (no real IO allowed): ${name}`);
    },
    __dirname: path.dirname(file), GC: { INMEMORY: false },
    setImmediate, setTimeout() {}, clearTimeout() {},
    Response, AbortSignal, ...extras,
  };
  sandbox.global = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 1000 });
  return module.exports;
}
function loadInterface() {
  return load(path.join(root, 'lib/StoreWolfInterface.js'), {
    fs: {}, './Util': util, './Logger': class {},
    '../lib/Communicator.js': class {}, 'node-fetch': () => { throw Error('network forbidden'); },
  });
}
function loadCommunicator(sharedResponse) {
  return load(path.join(root, 'lib/Communicator.js'), {
    '../lib/Util.js': util,
    './ComSharedMem.js': { getAndDestroyResponse: () => sharedResponse },
    'storewolf-libs/Serializer.cjs': { Serializer: serializer },
    'node-fetch': async () => ({ text: async () => JSON.stringify({ result: { ok: true } }) }),
  });
}
test('RPC characterization: ordinary non-shared JSON result is discarded', async () => {
  const Com = loadCommunicator(undefined);
  const com = new Com('https://synthetic.invalid/services/', 'synthetic-key');
  assert.equal(await com.run('Example', 'read', {}), undefined);
});
test('RPC positive control: result retrieved from shared store survives', async () => {
  const Com = loadCommunicator({ result: { ok: true } });
  const com = new Com('http://localhost:1/services/', 'synthetic-key');
  const result = await com.run('Example', 'read', {});
  assert.equal(result.result.ok, true);
});
test('authorization characterization: child proxy replaces employee with system-admin identity', async () => {
  const Interface = loadInterface();
  class Example extends Interface {
    constructor() {
      super({});
      this.adminOnly = { roles: ['admin'], fn: async () => ({ result: 'executed' }) };
    }
  }
  const endpoint = new Example();
  assert.equal((await endpoint.run('adminOnly', {}, { roles: ['employee'] })).status, 403);
  let usedRoles;
  class FakeCom {
    constructor(_url, key) { this.key = key; }
    async run(_service, name, body) {
      usedRoles = this.key === 'synthetic-system' ? ['admin'] : ['employee'];
      return endpoint.run(name, body, { roles: usedRoles });
    }
  }
  const Manager = load(path.join(root, 'ServiceManager/ServiceManager.js'), {
    'storewolf-libs/Serializer.cjs': { Serializer: serializer },
    stream: require('node:stream'), '../lib/Communicator.js': FakeCom,
    '../lib/ComSharedMem.js': {}, fs: {}, path, '../lib/Util.js': util, child_process: {},
  });
  const manager = new Manager({
    users: {
      system: { type: 'token', secret: 'synthetic-system', roles: ['admin'] },
      employee: { type: 'token', secret: 'synthetic-employee', roles: ['employee'] },
    },
  }, 1, {});
  manager.services = {
    ServiceManager: { logApiRequest: { fn: async () => {} } },
    Example: { isChild: true },
  };
  let result;
  await manager.handleServiceRequest({
    hostname: 'synthetic.invalid', method: 'POST',
    url: '/services/Example/adminOnly', body: {},
    headers: { storewolfkey: 'synthetic-employee' },
  }, { status() { return this; }, send(text) { result = JSON.parse(text); } });
  assert.equal(usedRoles[0], 'admin');
  assert.equal(result.result, 'executed');
});
test('job characterization: rejected Error can be marked complete without an err field', () => {
  const Interface = loadInterface();
  const endpoint = new Interface({});
  endpoint.polls.synthetic = { running: true };
  endpoint.pollData.execution = {};
  endpoint.polledFunctionComplete('example', 'synthetic', 'execution',
    { expiration: false, delay: 0 }, new Error('synthetic failure'));
  assert.equal(endpoint.pollData.execution.complete, true);
  assert.equal(endpoint.pollData.execution.err, undefined);
});
test('worker characterization: completed requests retain callbacks and worker exit leaves pending request', async () => {
  class FakeWorker extends EventEmitter { postMessage() {} terminate() {} }
  const Router = load(path.join(lib, 'ProcessRouterParentWorker.js'), {
    worker_threads: { Worker: FakeWorker },
    './AviUtil.js': { generateAlphaNumericKey: (() => { let id = 0; return () => `synthetic-${++id}`; })() },
    './Serializer.cjs': { Serializer: serializer },
  });
  const router = new Router('synthetic');
  await router.spawnChild('synthetic', 0, {});
  const response = router.runOnChild(0, 'read', {});
  const first = Object.keys(router.waitingOnResponseMap)[0];
  router.children[0].emit('message', JSON.stringify({ messageId: first, res: 1 }));
  assert.equal(await response, 1);
  assert.ok(router.waitingOnResponseMap[first], 'callback remains after success');
  let settled = false;
  router.runOnChild(0, 'read', {}).then(() => { settled = true; }, () => { settled = true; });
  router.children[0].emit('exit', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(Object.keys(router.waitingOnResponseMap).length, 2);
});
test('health characterization: zero services and disconnected DB still report ok true', async () => {
  const handlers = {};
  const Router = load(path.join(root, 'Router.js'), {
    express: { static: () => () => {} }, fs: {}, path,
  });
  const app = { get(route, fn) { handlers[route] = fn; }, post() {}, use() {} };
  await new Router(app, { noweb: true }).updateRoutes({ db: false, services: {} });
  let payload;
  handlers['/healthz']({}, { json(value) { payload = value; } });
  assert.equal(payload.ok, true);
  assert.equal(payload.databaseConnected, false);
  assert.equal(payload.serviceCount, 0);
});
test('config characterization: legacy default missing boot keys; production profile has them', () => {
  const jsonc = appRequire('jsonc-parser');
  const read = file => jsonc.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const key of ['DEBUGDIR', 'CACHEDIR', 'GCPATH']) {
    assert.equal(read('config.jsonc')[key], undefined);
    assert.equal(typeof read('config_avi_prod.jsonc')[key], 'string');
  }
});

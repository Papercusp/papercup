import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  censusSources, inScope, validateClassifications, inlineClassifications, validateSeed, seedClassifications,
  type NotifyCensus, type NotifyClassification,
} from '../../../scripts/check-fire-and-forget-classification.mjs';

const scan = (source: string) => censusSources({ 'src/app.ts': source });
const classify = (c: NotifyCensus): NotifyClassification[] => c.sites.map(s => ({
  id: s.id, path: s.path, classification: 'durable',
  reason: 'Owner notice must survive the producer exiting.', durablePath: 'src/delivery.ts#outbox',
}));

describe('fire-and-forget notification census and classification', () => {
  it('keeps a bundled host import free of census CLI startup effects', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const scratch = mkdtempSync(join(tmpdir(), 'notification-census-bundled-import-'));
    try {
      symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
      const outfile = join(scratch, 'hono-host.mjs');
      await build({
        stdin: {
          contents: `import { censusSources } from './scripts/check-fire-and-forget-classification.mjs';
console.log(JSON.stringify({ sites: censusSources({ 'src/app.ts': 'void notifyOwner();' }).sites.length }));`,
          resolveDir: root,
        },
        outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
      });
      const output = execFileSync(process.execPath, [outfile], {
        cwd: scratch, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(JSON.parse(output)).toEqual({ sites: 1 });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('still executes the census CLI directly and through a symlinked checkout path', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const scratch = mkdtempSync(join(tmpdir(), 'notification-census-cli-control-'));
    try {
      symlinkSync(join(root, 'scripts'), join(scratch, 'scripts'), 'dir');
      const census = scan('void notifyOwner();');
      const seedFrom = join(scratch, 'census.json');
      writeFileSync(seedFrom, JSON.stringify({
        ...census, sourceDigest: createHash('sha256').update(JSON.stringify(census.files)).digest('hex'),
      }));
      for (const scripts of [join(root, 'scripts'), join(scratch, 'scripts')]) {
        const output = execFileSync(process.execPath, [join(scripts, 'check-fire-and-forget-classification.mjs'), '--seed-from', seedFrom], {
          encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(JSON.parse(output).seedIds).toEqual(census.sites.map(site => site.id));
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('finds void, discarded promises, catch chains and stored un-awaited promises', () => {
    const c = scan('void notifyOwner(); sendAgent().catch(log); escalate(); const p = notify();');
    expect(c.sites).toHaveLength(4);
    expect(validateClassifications(c, classify(c))).toEqual([]);
  });

  it('retains awaited, returned and Promise.all custody', () => {
    expect(scan('async function run(){ await notify(); return send(); } async function other(){await Promise.all([notify(), send()]);}').sites).toEqual([]);
  });

  it('finds awaited notifications inside a discarded async IIFE', () => {
    const c = scan('void (async () => { await notifyOwner(); })();');
    expect(c.sites.some(s => s.expression === 'notifyOwner ( )' && s.mode === 'detached-wrapper')).toBe(true);
  });

  it('finds a named async wrapper and its awaited consequence', () => {
    const c = scan('async function tell(){ await notifyOwner(); } void tell();');
    expect(c.sites.map(s => s.expression)).toEqual(expect.arrayContaining(['tell ( )', 'notifyOwner ( )']));
  });

  it('resolves renamed imports through a barrel and unnamed wrapper', () => {
    const c = censusSources({
      'src/transport.ts': 'export async function tell(){ await notifyOwner(); }',
      'src/barrel.ts': 'export { tell as relay } from "./transport.js";',
      'src/app.ts': 'import { relay as quiet } from "./barrel"; void quiet();',
    });
    expect(c.sites.some(s => s.path === 'src/app.ts' && s.expression === 'quiet ( )')).toBe(true);
  });

  it('handles namespace and CommonJS destructuring aliases', () => {
    expect(scan('import * as bus from "bus"; const { notifyOwner: n } = require("bus"); const alias = n; void alias(); bus["send"]();').sites).toHaveLength(2);
  });

  it('handles computed constant names and bound function aliases', () => {
    const c = scan('const method="send"; bus[method](); const quiet=notifyOwner.bind(bus); quiet(); notifyOwner.call(bus);');
    expect(c.sites.map(s => s.expression)).toEqual(expect.arrayContaining(['bus [ method ] ( )', 'quiet ( )', 'notifyOwner . call ( bus )']));
  });

  it('includes unresolved computed dispatch conservatively instead of declaring it clean', () => {
    const c = scan('function dispatch(key){ bus[key](); } dispatch(runtimeKey);');
    expect(c.sites.some(s => s.roots.includes('<unresolved-computed-dispatch>'))).toBe(true);
    expect(validateClassifications(c, []).length).toBeGreaterThan(0);
  });

  it('handles dynamic-import destructuring and local object aliases', () => {
    const c = scan('async function run(){const {send: quiet}=await import("bus"); quiet(); const obj={relay: quiet}; obj.relay();}');
    expect(c.sites.map(s => s.expression)).toEqual(expect.arrayContaining(['quiet ( )', 'obj . relay ( )']));
  });

  it('keeps an unrelated shadowed alias separate', () => {
    const c = scan('const quiet = notifyOwner; function local(){ const quiet = unrelated; quiet(); }');
    expect(c.sites).toEqual([]);
  });

  it('propagates callback parameter injection and event callbacks', () => {
    const c = scan('function dispatch(f){f();} dispatch(notifyOwner); on("tick", async () => { await sendOwner(); });');
    expect(c.sites.some(s => s.expression === 'f ( )')).toBe(true);
    expect(c.sites.some(s => s.expression === 'sendOwner ( )')).toBe(true);
  });

  it('keeps retry callback roots separate for pure reads and owner notices', () => {
    const c = scan(`
      function retry(callback) { return callback(); }
      function readOnly() { return database.query('SELECT 1'); }
      retry(readOnly);
      retry(notifyOwner);
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.some(s => s.expression === 'retry ( readOnly )')).toBe(false);
    expect(c.sites.find(s => s.expression === 'retry ( notifyOwner )')?.roots).toContain('notifyOwner');
    expect(c.sites.find(s => s.expression === 'callback ( )')?.roots).toContain('notifyOwner');
  });

  it('retains wrapper-owned notices with a pure retry callback', () => {
    const c = scan(`
      function retry(callback) { notifyAttention(); return callback(); }
      function readOnly() { return database.query('SELECT 1'); }
      retry(readOnly);
      retry(sendOwner);
    `);
    expect(c.sites.find(s => s.expression === 'retry ( readOnly )')?.roots).toEqual(['notifyAttention']);
    expect(c.sites.find(s => s.expression === 'retry ( sendOwner )')?.roots).toEqual(['notifyAttention', 'sendOwner']);
    const records = classify(c).map(r => ({ ...r, classification: 'safe-to-lose' }));
    expect(validateClassifications(c, records)).toContain(
      `mandatory notice cannot be safe-to-lose: ${c.sites.find(s => s.expression === 'retry ( readOnly )')!.id}`,
    );
  });

  it('keeps nested forwarded callback aliases scoped to their caller', () => {
    const c = scan(`
      function retry(callback) { const alias = callback; return alias(); }
      function relay(callback) { return retry(() => callback()); }
      function readOnly() { return database.query('SELECT 1'); }
      const forwarding = relay;
      forwarding(readOnly);
      forwarding(sendOwner);
    `);
    expect(c.sites.some(s => s.expression === 'forwarding ( readOnly )')).toBe(false);
    expect(c.sites.find(s => s.expression === 'forwarding ( sendOwner )')?.roots).toContain('sendOwner');
  });

  it('keeps nested invocations of a shared workspace wrapper separate from sibling notices', () => {
    const c = censusSources({
      'src/workspace.ts': 'export function scope(workspace, callback) { return callback(); }',
      'src/operation.ts': `
        import { scope } from './workspace';
        export function status() { return scope('ws', () => database.query('SELECT 1')); }
      `,
      'src/app.ts': `
        import { scope } from './workspace';
        import { status } from './operation';
        scope('ws', () => status());
        scope('ws', notifyOwner);
      `,
    });
    expect(c.gaps).toEqual([]);
    expect(c.sites.some(s => s.path === 'src/app.ts' && s.expression === "scope ( 'ws' , ( ) => status ( ) )")).toBe(false);
    expect(c.sites.find(s => s.path === 'src/app.ts' && s.expression === "scope ( 'ws' , notifyOwner )")?.roots)
      .toEqual(['notifyOwner']);
    expect(c.sites.find(s => s.expression === 'callback ( )')?.roots).toContain('notifyOwner');
  });

  it('retains wrapper-owned notices while refining nested invocations of the same wrapper', () => {
    const c = scan(`
      function scope(callback) { notifyAttention(); return callback(); }
      function readOnly() { return database.query('SELECT 1'); }
      function status() { return scope(readOnly); }
      scope(() => status());
      scope(sendOwner);
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'scope ( ( ) => status ( ) )')?.roots)
      .toEqual(['notifyAttention']);
    expect(c.sites.find(s => s.expression === 'scope ( sendOwner )')?.roots)
      .toEqual(['notifyAttention', 'sendOwner']);
  });

  it('retains unknown computed callback dispatch and recursive notification paths', () => {
    const c = scan(`
      function retry(callback) { return callback(); }
      function dispatch() { return bus[runtimeKey](); }
      function recursive(callback) { if (again) recursive(callback); return callback(); }
      retry(dispatch);
      recursive(sendOwner);
    `);
    expect(c.sites.find(s => s.expression === 'retry ( dispatch )')?.roots).toContain('<unresolved-computed-dispatch>');
    expect(c.sites.find(s => s.expression === 'recursive ( sendOwner )')?.roots).toContain('sendOwner');
    expect(c.sites.find(s => s.expression === 'recursive ( callback )')?.roots).toContain('sendOwner');
  });

  it('retains conservative roots when callback forwarding exceeds the context depth bound', () => {
    const wrappers = Array.from({ length: 32 }, (_, i) =>
      `function step${i}(callback) { return ${i === 31 ? 'callback()' : `step${i + 1}(callback)`}; }`,
    ).join('\n');
    const c = scan(`${wrappers}\nstep0(sendOwner);`);
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'step0 ( sendOwner )')?.roots).toContain('sendOwner');
    expect(validateClassifications(c, classify(c))).toEqual([]);
  });

  it('discovers an omitted callback default and rejects missing delivery classifications', () => {
    const c = scan('function retry(callback = sendOwner) { return callback(); } retry();');
    expect(c.gaps).toEqual([]);
    expect(c.sites.map(s => [s.expression, s.roots])).toEqual([
      ['retry ( )', ['sendOwner']],
      ['callback ( )', ['sendOwner']],
    ]);
    expect(validateClassifications(c, [])).toEqual(c.sites.map(s => `unclassified: ${s.id}`));
    expect(validateClassifications(c, classify(c))).toEqual([]);
  });

  it('retains nested defaults while substituting explicit callback overrides', () => {
    const c = scan(`
      function retry(callback = sendOwner) { return callback(); }
      function outer() { notifyAttention(); return retry(); }
      function readOnly() { return database.query('SELECT 1'); }
      outer();
      retry(readOnly);
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'outer ( )')?.roots).toEqual(['notifyAttention', 'sendOwner']);
    expect(c.sites.find(s => s.expression === 'retry ( )')?.roots).toEqual(['sendOwner']);
    expect(c.sites.find(s => s.expression === 'callback ( )')?.roots).toEqual(['sendOwner']);
    expect(c.sites.some(s => s.expression === 'retry ( readOnly )')).toBe(false);
  });

  it('discovers defaults through earlier parameters and callback-valued initializers', () => {
    const c = scan(`
      function retry(first = sendOwner, callback = first) { return callback(); }
      function closure(callback = () => notifyOwner()) { return callback(); }
      retry();
      closure();
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'retry ( )')?.roots).toEqual(['sendOwner']);
    expect(c.sites.find(s => s.expression === 'closure ( )')?.roots).toEqual(['notifyOwner']);
    expect(c.sites.find(s => s.expression === 'notifyOwner ( )')?.mode).toBe('detached-wrapper');
  });

  it.each(['undefined', 'missing', 'runtimeCallback'])(
    'retains a notification default when the supplied callback is unresolved: %s', value => {
      const c = scan(`
        const missing = undefined;
        function retry(callback = sendOwner) { return callback(); }
        function readOnly() { return database.query('SELECT 1'); }
        retry(${value});
        retry(readOnly);
      `);
      expect(c.gaps).toEqual([]);
      const caller = c.sites.find(s => s.expression === `retry ( ${value} )`);
      expect(caller?.roots).toEqual(['sendOwner']);
      expect(c.sites.some(s => s.expression === 'retry ( readOnly )')).toBe(false);
      expect(validateClassifications(c, [])).toContain(`unclassified: ${caller?.id}`);
    },
  );

  it('keeps wrapper-owned notices when an unresolved callback can select its default', () => {
    const c = scan(`
      function retry(callback = sendOwner) { notifyAttention(); return callback(); }
      retry(undefined);
    `);
    expect(c.sites.find(s => s.expression === 'retry ( undefined )')?.roots)
      .toEqual(['notifyAttention', 'sendOwner']);
  });

  it('resolves a shadowed undefined parameter to its known caller callback', () => {
    const c = scan(`
      function retry(callback = sendOwner) { return callback(); }
      function caller(undefined) { return retry(undefined); }
      function readOnly() { return database.query('SELECT 1'); }
      caller(readOnly);
      caller(sendOwner);
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.some(s => s.expression === 'caller ( readOnly )')).toBe(false);
    expect(c.sites.find(s => s.expression === 'caller ( sendOwner )')?.roots).toEqual(['sendOwner']);
  });

  it.each(['false', 'true', '0', 'null', '-1', '1n'])(
    'keeps callback custody separate when a wrapper also has the primitive default %s', value => {
      const c = scan(`
        function retry(callback, option = ${value}) { return callback(); }
        function readOnly() { return database.query('SELECT 1'); }
        retry(readOnly);
        retry(sendOwner);
      `);
      expect(c.gaps).toEqual([]);
      expect(c.sites.some(s => s.expression === 'retry ( readOnly )')).toBe(false);
      expect(c.sites.find(s => s.expression === 'retry ( sendOwner )')?.roots).toEqual(['sendOwner']);
      expect(c.sites.find(s => s.expression === 'callback ( )')?.roots).toEqual(['sendOwner']);
    },
  );

  it('keeps computed dispatch conservative when its default is a primitive', () => {
    const c = scan('function dispatch(key = false) { return bus[key](); } dispatch();');
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'dispatch ( )')?.roots).toEqual(['<unresolved-computed-dispatch>']);
  });

  it.each([255, 256, 257, 1024].flatMap(count => [false, true].map(reverse => ({ count, reverse }))))(
    'keeps callback custody after $count notification-free calls (reverse=$reverse)',
    ({ count, reverse }) => {
      const callers = ['run(readOnly);', 'run(sendOwner);'];
      if (reverse) callers.reverse();
      const c = scan(`
        function readOnly() { return database.query('SELECT 1'); }
        function run(callback) { ${'readOnly();'.repeat(count)} return callback(); }
        ${callers.join('\n')}
      `);
      expect(c.gaps).toEqual([]);
      expect(c.sites.map(s => [s.expression, s.roots])).toEqual([
        ['run ( sendOwner )', ['sendOwner']],
        ['callback ( )', ['sendOwner']],
      ]);
      expect(validateClassifications(c, [])).toHaveLength(2);
    },
  );

  it.each([false, true])('retains defaults and unknown dispatch after many clean calls (reverse=%s)', reverse => {
    const callers = ['run(readOnly);', 'run();'];
    if (reverse) callers.reverse();
    const c = scan(`
      function readOnly() { return database.query('SELECT 1'); }
      function retry(callback = sendOwner) { return callback(); }
      function run(callback = () => retry()) {
        ${'readOnly();'.repeat(1024)}
        bus[runtimeKey]();
        return callback();
      }
      ${callers.join('\n')}
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'run ( )')?.roots).toEqual(['<unresolved-computed-dispatch>', 'sendOwner']);
    expect(c.sites.find(s => s.expression === 'run ( readOnly )')?.roots).toEqual(['<unresolved-computed-dispatch>']);
    expect(c.sites.find(s => s.expression === 'retry ( )')?.roots).toEqual(['sendOwner']);
    expect(validateClassifications(c, [])).toEqual(c.sites.map(s => `unclassified: ${s.id}`));
  });

  it('keeps conservative notices when notification-bearing calls exhaust the refinement budget', () => {
    const c = scan(`
      function retry(callback = sendOwner) { return callback(); }
      function run() { ${'notifyAttention();'.repeat(257)} return retry(); }
      run();
    `);
    expect(c.gaps).toEqual([]);
    expect(c.sites.find(s => s.expression === 'run ( )')?.roots).toEqual(['notifyAttention', 'sendOwner']);
    expect(c.sites.find(s => s.expression === 'retry ( )')?.roots).toEqual(['sendOwner']);
    expect(c.sites.filter(s => s.expression === 'notifyAttention ( )')).toHaveLength(257);
    expect(validateClassifications(c, [])).toEqual(c.sites.map(s => `unclassified: ${s.id}`));
  });

  it('terminates on cyclic barrel exports', () => {
    const c = censusSources({
      'src/a.ts': 'export * from "./b"; export const relay = notifyOwner;',
      'src/b.ts': 'export * from "./a";',
      'src/app.ts': 'import {relay} from "./b"; relay();',
    });
    expect(c.sites.some(s => s.expression === 'relay ( )')).toBe(true);
  });

  it('keeps both notice roots across star-export siblings sharing an object alias', () => {
    const c = censusSources({
      'src/shared.ts': 'export const channels = { first: notifyOwner, second: sendOwner };',
      'src/left.ts': 'import { channels } from "./shared"; export const relay = channels.first;',
      'src/right.ts': 'import { channels } from "./shared"; export const relay = channels.second;',
      'src/diamond.ts': 'export * from "./left"; export * from "./right";',
      'src/app.ts': 'import * as notices from "./diamond"; notices.relay();',
    });
    expect(c.gaps).toEqual([]);
    // A shared visited set would let the first barrel suppress the second
    // traversal of channels. Distinct roots expose the missing sibling.
    expect(c.sites.find(s => s.path === 'src/app.ts' && s.expression === 'notices . relay ( )')?.roots)
      .toEqual(['notifyOwner', 'sendOwner']);
  });

  it('bounds visited-set copying through deep member aliases without losing notices', () => {
    const NativeSet = globalThis.Set;
    let copiedEntries = 0;
    class TrackedSet<T> extends NativeSet<T> {
      constructor(values?: Iterable<T> | null) {
        super(values);
        if (values instanceof NativeSet) copiedEntries += values.size;
      }
    }
    const depth = 60;
    const aliases = Array.from({ length: depth }, (_, i) =>
      `const box${i} = { relay: ${i === 0 ? 'notifyOwner' : `box${i - 1}.relay`} };`,
    ).join('\n');
    vi.stubGlobal('Set', TrackedSet);
    let census: NotifyCensus;
    try {
      census = scan(`${aliases}\nbox${depth - 1}.relay();`);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(census.gaps).toEqual([]);
    expect(census.sites.find(s => s.expression === `box${depth - 1} . relay ( )`)?.roots).toContain('notifyOwner');
    // Count copied entries rather than wall time: the previous resolver copied
    // every growing ancestor set at each member branch, making aliases cubic.
    expect(copiedEntries).toBeLessThan(depth * depth);
  });

  it('resolves namespace aliases and object methods with neutral names', () => {
    const c = censusSources({
      'src/bus.ts': 'export function relay(){return notifyOwner();}',
      'src/app.ts': 'import * as bus from "./bus"; const alias=bus; alias.relay(); const o={quiet(){return notifyOwner();}}; o.quiet();',
    });
    expect(c.sites.map(s => s.expression)).toEqual(expect.arrayContaining(['alias . relay ( )', 'o . quiet ( )']));
  });

  it('resolves class instance and static wrapper methods', () => {
    const c = scan('class Bus { quiet(){return notifyOwner();} static relay(){return sendOwner();} } const b=new Bus(); b.quiet(); Bus.relay();');
    expect(c.sites.map(s => s.expression)).toEqual(expect.arrayContaining(['b . quiet ( )', 'Bus . relay ( )']));
  });

  it('resolves a wrapper assigned inside another block', () => {
    const c = scan('let quiet; {quiet=notifyOwner;} quiet();');
    expect(c.sites.some(s => s.expression === 'quiet ( )')).toBe(true);
  });

  it('derives workspace package exports and tsconfig import aliases', () => {
    const c = censusSources({
      'libs/bus/package.json': '{"name":"@internal/bus","exports":{".":"./src/index.ts"}}',
      'libs/bus/src/index.ts': 'export function relay(){return notifyOwner();}',
      'apps/app/tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
      'apps/app/src/bridge.ts': 'export {relay as quiet} from "@internal/bus";',
      'apps/app/main.ts': 'import {quiet} from "@/bridge"; quiet();',
    });
    expect(c.sites.some(s => s.path === 'apps/app/main.ts' && s.expression === 'quiet ( )')).toBe(true);
    expect(c.files.some(f => f.path === 'libs/bus/package.json')).toBe(true);
  });

  it('does not treat comments, strings or type declarations as calls', () => {
    expect(scan('// notifyOwner()\nconst text="void send()"; type T = {notify(): void};').sites).toEqual([]);
  });

  it('does not confuse escalation readers and send-side state helpers with delivery', () => {
    expect(scan('loadEscalations(); foldEscalations(); ensureSendSideWired(); markSendSideUnwired();').sites).toEqual([]);
    expect(scan('notify(); send(); escalateOwner(); createNotification(); raiseEscalation();').sites).toHaveLength(5);
  });

  it('keeps IDs stable across unrelated line movement and comments', () => {
    const a = scan('function run(){notifyOwner("x");}');
    const b = scan('\n// a line\nfunction run(){ /* comment */ notifyOwner( "x" );}');
    expect(b.sites.map(s => s.id)).toEqual(a.sites.map(s => s.id));
    expect(b.files[0].sha256).not.toBe(a.files[0].sha256);
  });

  it.each([
    'const key = `owner:${1}`;',
    'const key = `outer:${`inner:${1}`}`;',
  ])('keeps wrapper IDs stable after template interpolation: %s', (prefix) => {
    const source = `void (async () => { ${prefix} await notifyOwner(key); })();`;
    const annotated = source.replace('await notifyOwner', '// replay custody\n await notifyOwner');
    const before = scan(source);
    const after = scan(annotated);
    expect(before.sites).toHaveLength(2);
    expect(after.sites.map(s => s.id)).toEqual(before.sites.map(s => s.id));
    expect(after.sites.some(s => s.expression.includes('replay custody'))).toBe(false);
  });

  it('preserves literal whitespace and comment-like content in site IDs', () => {
    for (const [before, after] of [
      ['notifyOwner(/owner notice/);', 'notifyOwner(/ownernotice/);'],
      ['notifyOwner(`owner:${1}// first`);', 'notifyOwner(`owner:${1}// second`);'],
      ['notifyOwner("/* first */");', 'notifyOwner("/* second */");'],
    ]) {
      expect(scan(before).sites[0].id).not.toBe(scan(after).sites[0].id);
    }
  });

  it('gives repeated identical sites distinct IDs', () => {
    const c = scan('notifyOwner(); notifyOwner();');
    expect(c.sites).toHaveLength(2);
    expect(new Set(c.sites.map(s => s.id)).size).toBe(2);
  });

  it('rejects synthetic direct, alias and wrapper additions, then accepts classifications', () => {
    for (const source of ['notifyOwner();', 'const n=notifyOwner; n();', 'function quiet(){return notifyOwner();} quiet();']) {
      const c = scan(source);
      expect(c.sites.length).toBeGreaterThan(0);
      expect(validateClassifications(c, [])).toContain(`unclassified: ${c.sites[0].id}`);
      expect(validateClassifications(c, classify(c))).toEqual([]);
    }
  });

  it('rejects missing reasons, paths, duplicate, stale and missing durable records', () => {
    const c = scan('notifyOwner();');
    const [r] = classify(c);
    expect(validateClassifications(c, [r, r]).some(e => e.startsWith('duplicate'))).toBe(true);
    expect(validateClassifications(c, [{ ...r, reason: '' }]).some(e => e.startsWith('incomplete'))).toBe(true);
    expect(validateClassifications(c, [{ ...r, path: 'elsewhere.ts' }]).some(e => e.startsWith('path mismatch'))).toBe(true);
    expect(validateClassifications(c, [{ ...r, durablePath: '' }]).some(e => e.startsWith('missing durable'))).toBe(true);
    expect(validateClassifications(scan(''), [r]).some(e => e.startsWith('stale'))).toBe(true);
  });

  it('rejects owner, grading, reaper and explicitly mandatory safe-to-lose notices', () => {
    for (const source of ['sendOwner();', 'sendGrader();', 'escalate();', 'send({to:"human"});', 'notifyAttention();']) {
      const c = scan(source);
      const records = classify(c).map(r => ({ ...r, classification: 'safe-to-lose' }));
      expect(validateClassifications(c, records).some(e => e.startsWith('mandatory notice'))).toBe(true);
    }
    const c = scan('notifyPeer();');
    expect(validateClassifications(c, classify(c).map(r => ({ ...r, classification: 'safe-to-lose', mandatory: true }))).some(e => e.startsWith('mandatory notice'))).toBe(true);
  });

  it('rejects incomplete parse coverage', () => {
    const c = scan('const broken = ; notifyOwner();');
    expect(c.gaps.length).toBeGreaterThan(0);
    expect(validateClassifications(c, classify(c)).some(e => e.startsWith('coverage gap'))).toBe(true);
  });

  it('freezes the measured seed, permits removals, and rejects baseline growth', () => {
    const c = scan('notifyOwner();'); const records = classify(c);
    const seedIds = records.map(r => r.id).sort();
    const hash = createHash('sha256').update(JSON.stringify(seedIds)).digest('hex');
    expect(validateSeed({ seedIds, records }, hash)).toEqual([]);
    expect(validateSeed({ seedIds, records: [] }, hash)).toEqual([]);
    expect(validateSeed({ seedIds: [], records: [] }, hash)).toHaveLength(1);
    expect(validateSeed({ seedIds, records: [{ ...records[0], id: 'new' }] }, hash)[0]).toContain('baseline grew');
  });

  it('accepts a new source-classified site without enlarging the baseline', () => {
    const c = scan('// notify-classification: {"classification":"durable","reason":"Owner consequence","durablePath":"src/outbox.ts#commit"}\nnotifyOwner();');
    expect(validateClassifications(c, inlineClassifications(c))).toEqual([]);
    expect(inlineClassifications(c)[0].id).toBe(c.sites[0].id);
  });

  it('limits an explicit source classification to its exact site among nearby identical calls', () => {
    const source = 'notifyPeer();\nnotifyPeer();';
    const record = classify(scan(source))[1];
    const c = scan(`// notify-classification: ${JSON.stringify(record)}\n${source}`);
    expect(inlineClassifications(c).map(r => r.id)).toEqual([record.id]);
    expect(validateClassifications(c, inlineClassifications(c))).toEqual([`unclassified: ${c.sites[0].id}`]);
    expect(validateClassifications(c, [classify(c)[0], ...inlineClassifications(c)])).toEqual([]);
  });

  it.each([
    'notifyPeer("first"); notifyPeer("second");',
    'void (async () => { notifyOwner(); })();',
  ])('matches multiple nearby declarations to their own exact sites: %s', (source) => {
    const before = scan(source);
    expect(before.sites).toHaveLength(2);
    const records = classify(before).map((r, i) => ({ ...r, reason: `Reviewed consequence ${i}` }));
    const annotations = [...records].reverse().map(r => `// notify-classification: ${JSON.stringify(r)}`);
    const after = scan(`${annotations.join('\n')}\n${source}`);
    expect(after.gaps).toEqual([]);
    expect(after.sites.map(s => s.id)).toEqual(before.sites.map(s => s.id));
    expect(inlineClassifications(after)).toEqual(records);
    expect(validateClassifications(after, inlineClassifications(after))).toEqual([]);
  });

  it('prefers an exact declaration over an earlier unscoped declaration', () => {
    const source = 'notifyOwner();';
    const [record] = classify(scan(source));
    const { id: _id, ...legacy } = { ...record, reason: 'Legacy fallback' };
    const after = scan(`// notify-classification: ${JSON.stringify(legacy)}\n// notify-classification: ${JSON.stringify(record)}\n${source}`);
    expect(inlineClassifications(after)).toEqual([record]);
  });

  it('seeds requirements from a measured census without inventing verified delivery', () => {
    const c = scan('notifyOwner();');
    const sourceDigest = createHash('sha256').update(JSON.stringify(c.files)).digest('hex');
    const seed = seedClassifications({ ...c, sourceDigest });
    expect(seed.seedIds).toEqual(c.sites.map(s => s.id));
    expect(seed.seedFiles).toEqual(c.files);
    expect(seed.records[0].classification).toBe('durable');
    expect(seed.records[0].durablePath).toContain('UNVERIFIED');
    expect(seed.records[0].deliveryState).toBe('unverified');
    expect(() => seedClassifications({ ...c, sourceDigest: '', gaps: [{ path: 'src/app.ts', kind: 'unreadable' }] })).toThrow('incomplete');
    expect(() => seedClassifications({ ...c, sourceDigest: 'copied-but-not-matching' })).toThrow('unpinned');
  });

  it('includes maintained submodule sources and excludes test/generated sources explicitly', () => {
    expect(inScope('libs/papercusp/src/notify.ts')).toBe(true);
    expect(inScope('apps/operator/lib/identity-assume-production.ts')).toBe(true);
    expect(inScope('apps/operator/vitest-shims-production/notify.ts')).toBe(true);
    for (const path of ['src/a.test.ts', 'src/a.d.ts', 'src/__tests__/a.ts', 'apps/operator/dist-host/a.mjs', 'src/fixtures/a.ts', 'apps/operator/vitest-shims/identity-assume-production.ts', 'papercusp-desktop/src-tauri/env-sidecars/staging/serve.mjs', 'libs/ui/storybook-static/manager.js']) expect(inScope(path)).toBe(false);
    const c = censusSources({ 'libs/example/src/a.ts': 'notify();', 'src/a.test.ts': 'notify();',
      'apps/operator/vitest-shims/identity-assume-production.ts': 'notify();' });
    expect(c.files.map(f => f.path)).toEqual(['libs/example/src/a.ts']);
  });

  it('retains a pinned genesis registry and permits its reviewed obligations to shrink', () => {
    const registry = JSON.parse(readFileSync(new URL('../../../scripts/fire-and-forget-classification.json', import.meta.url), 'utf8'));
    expect(validateSeed(registry)).toEqual([]);
    expect(registry.seedIds.length).toBeGreaterThan(0);
    expect(new Set(registry.records.map((r: NotifyClassification) => r.id)).size).toBe(registry.records.length);
    expect(registry.records.every((r: NotifyClassification) => registry.seedIds.includes(r.id))).toBe(true);
    expect(new Set(registry.seedFiles.map((f: { path: string }) => f.path)).size).toBe(registry.seedFiles.length);
    expect(registry.seedFiles.every((f: { sha256: string }) => /^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);
    expect(createHash('sha256').update(JSON.stringify(registry.seedFiles)).digest('hex')).toBe(registry.seedSourceDigest);
    expect(registry.seedCoverage.unscannedPresent).toEqual([]);
    for (const record of registry.records) {
      expect(record.path).toBeTruthy();
      expect(record.reason.trim()).not.toBe('');
      expect(['durable', 'safe-to-lose']).toContain(record.classification);
      if (record.classification === 'durable') {
        expect(record.durablePath.trim()).not.toBe('');
        expect(['unverified', 'verified']).toContain(record.deliveryState);
        if (record.deliveryState === 'unverified') expect(record.durablePath).toContain('UNVERIFIED requirement:');
      }
    }
  });
});

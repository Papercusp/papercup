import { describe, expect, it } from 'vitest';
import {
  censusSources, inScope, validateClassifications,
  type NotifyCensus, type NotifyClassification,
} from '../../../scripts/check-fire-and-forget-classification.mjs';

const scan = (source: string) => censusSources({ 'src/app.ts': source });
const classify = (c: NotifyCensus): NotifyClassification[] => c.sites.map(s => ({
  id: s.id, path: s.path, classification: 'durable',
  reason: 'Owner notice must survive the producer exiting.', durablePath: 'src/delivery.ts#outbox',
}));

describe('fire-and-forget notification census and classification', () => {
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

  it('terminates on cyclic barrel exports', () => {
    const c = censusSources({
      'src/a.ts': 'export * from "./b"; export const relay = notifyOwner;',
      'src/b.ts': 'export * from "./a";',
      'src/app.ts': 'import {relay} from "./b"; relay();',
    });
    expect(c.sites.some(s => s.expression === 'relay ( )')).toBe(true);
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

  it('does not treat comments, strings or type declarations as calls', () => {
    expect(scan('// notifyOwner()\nconst text="void send()"; type T = {notify(): void};').sites).toEqual([]);
  });

  it('keeps IDs stable across unrelated line movement and comments', () => {
    const a = scan('function run(){notifyOwner("x");}');
    const b = scan('\n// a line\nfunction run(){ /* comment */ notifyOwner( "x" );}');
    expect(b.sites.map(s => s.id)).toEqual(a.sites.map(s => s.id));
    expect(b.files[0].sha256).not.toBe(a.files[0].sha256);
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

  it('includes maintained submodule sources and excludes test/generated sources explicitly', () => {
    expect(inScope('libs/papercusp/src/notify.ts')).toBe(true);
    for (const path of ['src/a.test.ts', 'src/a.d.ts', 'src/__tests__/a.ts', 'apps/operator/dist-host/a.mjs', 'src/fixtures/a.ts', 'papercusp-desktop/src-tauri/env-sidecars/staging/serve.mjs', 'libs/ui/storybook-static/manager.js']) expect(inScope(path)).toBe(false);
    const c = censusSources({ 'libs/example/src/a.ts': 'notify();', 'src/a.test.ts': 'notify();' });
    expect(c.files.map(f => f.path)).toEqual(['libs/example/src/a.ts']);
  });
});

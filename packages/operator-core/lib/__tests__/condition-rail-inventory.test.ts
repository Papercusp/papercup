/**
 * Plan degradation-signals-on-condition-rail-2026-10-11, P-001 (BAR R-4): the measuring
 * inventory of failure/degradation signals that bypass the condition rail.
 *
 * Each of the five classes has a POSITIVE control (a site the scanner must report) and a
 * NEGATIVE control (the same shape on the rail, or only quoted in a comment/string, which it
 * must not report). The negative controls are what keep a positive control honest: a scanner
 * that reported every file would pass the positives alone.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSES,
  dispositionFor,
  dispositionProblem,
  inventory,
  isScannable,
  scanSource,
} from '../../../../scripts/lib/condition-rail-inventory.mjs';

const classesOf = (src: string, file: string) => scanSource(src, file).map((r) => r.class);

describe('condition-rail inventory — class 1: owner-only alarms', () => {
  it('reports a notifyAttention / escalateAlarm call with no rail call beside it', () => {
    const src = `export async function check() {\n  await notifyAttention({ kind: 'x', title: 't', body: 'b' });\n}\n`;
    expect(classesOf(src, 'packages/x/lib/disk.ts')).toEqual(['owner-only-alarm']);
    const esc = `async function f() { await escalateAlarm({ title: 'a', body: 'b', cooldownMs: 1, source: 's' }); }\n`;
    expect(classesOf(esc, 'packages/x/lib/esc.ts')).toEqual(['owner-only-alarm']);
  });

  it('does not report a call that also raises a keyed condition, the declaration, or a quoted mention', () => {
    const onRail = `async function f() {\n  await notifyAttention({ kind: 'x', title: 't', body: 'b' });\n  broadcastSevereEvent({ conditionKey: 'degraded:x:y', title: 't' });\n}\n`;
    expect(classesOf(onRail, 'packages/x/lib/on-rail.ts')).toEqual([]);
    const decl = `export async function notifyAttention(input) { return input; }\n`;
    expect(classesOf(decl, 'packages/x/lib/attention-notify.ts')).toEqual([]);
    const quoted = `// call notifyAttention( here\nconst s = 'escalateAlarm(';\n`;
    expect(classesOf(quoted, 'packages/x/lib/quoted.ts')).toEqual([]);
  });

  it('treats a rail injected as a dependency as on the rail, but not a rail named only in a comment', () => {
    const injected = `async function guard(deps) {\n  const broadcast = deps.broadcast ?? broadcastSevereEvent;\n  await notifyAttention(input);\n  await broadcast(ev);\n}\n`;
    expect(classesOf(injected, 'packages/x/lib/injected.ts')).toEqual([]);
    const commentOnly = `async function guard() {\n  // TODO: broadcastSevereEvent here\n  await notifyAttention(input);\n}\n`;
    expect(classesOf(commentOnly, 'packages/x/lib/comment-only.ts')).toEqual(['owner-only-alarm']);
  });
});

describe('condition-rail inventory — class 2: log-only fallback decisions', () => {
  it('reports a log line that announces a fallback or fail-open with no rail call beside it', () => {
    const src = `try { go(); } catch (e) {\n  console.warn('[gate] proofs unavailable, falling back to full suite', e);\n}\n`;
    expect(classesOf(src, 'packages/x/lib/gate.ts')).toEqual(['log-only-fallback']);
    const failOpen = `if (!ok) { logger.warn(\`admission check failed open: \${why}\`); }\n`;
    expect(classesOf(failOpen, 'packages/x/lib/admit.ts')).toEqual(['log-only-fallback']);
  });

  it('does not report a fallback that is also observed, or a log line with other wording', () => {
    const observed = `catch (e) {\n  observeFallback({ mechanism: 'gate', eligible: 1, applied: 0, reason: 'x' });\n  console.warn('falling back to full suite');\n}\n`;
    expect(classesOf(observed, 'packages/x/lib/gate.ts')).toEqual([]);
    const other = `console.warn('[gate] run finished in 3s');\n`;
    expect(classesOf(other, 'packages/x/lib/gate.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — class 3: health fields with alarm flags but no condition', () => {
  it('reports an alarm-shaped field set to a value in a health file that never raises a condition', () => {
    const src = `export function sample(n: number) {\n  return { lagMs: n, degraded: n > 5000 };\n}\n`;
    expect(classesOf(src, 'packages/x/lib/system-health/ingest-health.ts')).toEqual(['health-flag-no-condition']);
  });

  it('does not report a type member, a field in a non-health file, or a health file on the rail', () => {
    const typeOnly = `export interface IngestHealth {\n  degraded: boolean;\n  alarm?: boolean;\n}\n`;
    expect(classesOf(typeOnly, 'packages/x/lib/system-health/ingest-health.ts')).toEqual([]);
    const nonHealth = `const r = { degraded: n > 5 };\n`;
    expect(classesOf(nonHealth, 'packages/x/lib/render.ts')).toEqual([]);
    const onRail = `const r = { degraded: n > 5 };\nif (r.degraded) broadcastSevereEvent({ conditionKey: 'degraded:ingest:lag' });\n`;
    expect(classesOf(onRail, 'packages/x/lib/system-health/ingest-health.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — class 4: bespoke rate watchdogs', () => {
  it('reports a watchdog module, or a named watchdog interval, that never raises a condition', () => {
    const mod = `export function sweep() { if (rate() < 0.1) console.error('low'); }\n`;
    expect(classesOf(mod, 'packages/x/lib/reuse-rate-watchdog.ts')).toEqual(['bespoke-watchdog']);
    const interval = `managedSetInterval('reuse-rate-watchdog', 60_000, () => check(), { category: 'watchdog' });\n`;
    expect(classesOf(interval, 'packages/x/lib/boot.ts')).toEqual(['bespoke-watchdog']);
  });

  it('does not report a watchdog that raises a keyed condition', () => {
    const onRail = `export function sweep() {\n  if (rate() < 0.1) broadcastSevereEvent({ conditionKey: 'degraded:reuse:rate' });\n}\n`;
    expect(classesOf(onRail, 'packages/x/lib/reuse-rate-watchdog.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — class 5: signal-actor-registry waivers', () => {
  it('reports each waiver on a defineSignal entry, naming the signal', () => {
    const src = `defineSignal({\n  id: 'reuse-collapse',\n  waiver: { reason: 'accepted', expiresAt: '2027-01-01' },\n});\n`;
    const rows = scanSource(src, 'packages/x/lib/signal-actor-registry.ts');
    expect(rows.map((r) => [r.class, r.symbol])).toEqual([['signal-waiver', 'reuse-collapse']]);
  });

  it('does not report an actor-backed entry or a waiver outside a signal registry', () => {
    const actor = `defineSignal({ id: 'reuse-collapse', actor: { kind: 'condition-bridge' } });\n`;
    expect(classesOf(actor, 'packages/x/lib/signal-actor-registry.ts')).toEqual([]);
    const elsewhere = `const policy = { waiver: { reason: 'x' } };\n`;
    expect(classesOf(elsewhere, 'packages/x/lib/policy.ts')).toEqual([]);
  });
});

describe('condition-rail inventory — scope, dispositions and coverage', () => {
  it('scans source and skips tests, bundles, vendored assets and itself', () => {
    expect(isScannable('packages/operator-core/lib/alarm-attention.ts')).toBe(true);
    expect(isScannable('scripts/npm-install-safe.mjs')).toBe(true);
    for (const f of [
      'packages/operator-core/lib/alarm-attention.test.ts',
      'packages/operator-core/lib/__tests__/x.ts',
      'apps/operator/dist-host/hono-host.mjs',
      'apps/operator/public/docs/pagefind/pagefind.js',
      'libs/generic/papergrid/grid-core/storybook-static/sb-manager/runtime.js',
      'node_modules/x/index.js',
      'scripts/lib/condition-rail-inventory.mjs',
      'docs/readme.md',
    ]) {
      expect(isScannable(f), f).toBe(false);
    }
  });

  it('resolves the most specific disposition and flags malformed or missing ones', () => {
    const row = { class: 'owner-only-alarm', file: 'a.ts', line: 3, symbol: 'notifyAttention', key: 'owner-only-alarm|a.ts' };
    const cluster = { disposition: 'migrate', item: 'P-005' };
    const site = { disposition: 'not-applicable', reason: 'interactive CLI output read by the operator' };
    expect(dispositionFor(row, { 'owner-only-alarm|a.ts': cluster })).toBe(cluster);
    expect(dispositionFor(row, { 'owner-only-alarm|a.ts': cluster, 'owner-only-alarm|a.ts|notifyAttention': site })).toBe(site);
    expect(dispositionProblem(null)).toBe('missing');
    expect(dispositionProblem({ disposition: 'migrate' })).toMatch(/P-NNN/);
    expect(dispositionProblem({ disposition: 'not-applicable', reason: 'short' })).toMatch(/reason/);
    expect(dispositionProblem(cluster)).toBeNull();
    expect(dispositionProblem(site)).toBeNull();
  });

  it('inventories a file set into per-class counts, undispositioned sites and stale keys', () => {
    const files: Record<string, string> = {
      'packages/x/lib/disk.ts': `async function f() { await notifyAttention({ kind: 'x', title: 't', body: 'b' }); }\n`,
      'packages/x/lib/reuse-watchdog.ts': `export function sweep() {}\n`,
      'packages/x/lib/clean.ts': `export const x = 1;\n`,
    };
    const res = inventory({
      root: '/nowhere',
      files: Object.keys(files),
      dispositions: {
        'owner-only-alarm|packages/x/lib/disk.ts': { disposition: 'migrate', item: 'P-005' },
        'bespoke-watchdog|packages/x/lib/gone.ts': { disposition: 'migrate', item: 'P-005' },
      },
      readFile: (f: string) => files[f],
    });
    expect(res.scanned).toBe(3);
    expect(Object.keys(res.byClass)).toEqual([...CLASSES]);
    expect(res.byClass['owner-only-alarm']).toBe(1);
    expect(res.byClass['bespoke-watchdog']).toBe(1);
    expect(res.undispositioned).toBe(1);
    expect(res.staleDispositions).toEqual(['bespoke-watchdog|packages/x/lib/gone.ts']);
  });
});

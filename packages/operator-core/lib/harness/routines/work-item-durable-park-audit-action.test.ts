/**
 * work-item-durable-park-audit-action.test.ts — P-022 (work-queue-admission-and-bulk-dedup-2026-08-24):
 * wiring the durable-park audit onto a DAILY REPORT-FIRST cadence as the bounded backstop.
 *
 * What this pins, and why each one is load-bearing:
 *
 *  1. The scheduled backstop is REPORT-ONLY. D-018/D-022/D-023 all say the same thing:
 *     a durable park is never cleared by age, parker death, or model judgment, and any
 *     clear goes through explicit reconcile decisions on the evidence-matrix/CAS path.
 *     The daily row therefore must never reach `runWorkItemDurableParkReconciliation`.
 *     The danger is not a dramatic rewrite — it is someone adding one `mode` key to the
 *     seeded payload and silently converting an unattended reporter into an unattended
 *     MUTATOR of 285 live parks.
 *
 *  2. The action is declared `scheduling: 'standing'`. This is the code half of the
 *     code↔data cross-check; with it `on-demand`, a missing routine row is EXEMPT from
 *     `validateActiveRoutines`. That exemption is exactly why the audit shipped green in
 *     P-020/P-021 and then never ticked once — the row was absent and nothing was
 *     allowed to notice.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// The action module imports DBOS and the SSE notifier at top level for its production
// path. Neither is exercised here (productionRun hard-refuses under VITEST), so stub
// both rather than standing up a workflow runtime for a pure-dispatch assertion.
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { workflowID: '' } }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: async () => {} }));

import { selectDurableParkAuditMode } from './work-item-durable-park-audit-action';
import { getSystemActionEntry } from './system-actions';
import { WORK_ITEM_DURABLE_PARK_AUDIT } from '../../work-items-durable-park-audit';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';

const SEED_SCRIPT = 'seed-work-item-durable-park-audit-routine.ts';
const seedSource = readFileSync(path.join(__dirname, SEED_SCRIPT), 'utf8');

/**
 * Comments stripped. The report-only guard below asserts on what the script DOES, and
 * the seed script's own header necessarily *names* the reconcile mode in order to warn
 * against it. Matching raw source would make documenting the hazard indistinguishable
 * from shipping it — the guard would fire on the warning and stay silent on the deed.
 */
const seedCode = seedSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('selectDurableParkAuditMode — the scheduled backstop reports, it never clears', () => {
  it('defaults to the reporting branch when the payload names no mode', () => {
    // This is the shape the seeded daily row actually sends.
    expect(selectDurableParkAuditMode({})).toBe('audit');
    expect(selectDurableParkAuditMode({ reviewOverdueHours: 24 })).toBe('audit');
  });

  it('CONTROL: an explicit reconcile payload really does select the mutating branch', () => {
    // Calibration for the assertions above. Without this, a selector hard-wired to
    // return 'audit' for every input would satisfy every other test in this block —
    // the report-only property would read as proven while actually being vacuous.
    expect(selectDurableParkAuditMode({ mode: 'reconcile' })).toBe('reconcile');
  });

  it('degrades a malformed mode to reporting rather than to clearing', () => {
    // Fail-safe direction matters here: the wrong default mutates live parks.
    for (const mode of ['Reconcile', 'reconcile ', '', 'audit', 'RECONCILE', null, undefined, 1, {}]) {
      expect(selectDurableParkAuditMode({ mode })).toBe('audit');
    }
  });
});

describe('P-022 wiring — the row is expected to exist, and it is report-only', () => {
  it('declares the action standing, so a missing routine row is reported not exempted', () => {
    expect(getSystemActionEntry(WORK_ITEM_DURABLE_PARK_AUDIT)?.scheduling).toBe('standing');
  });

  it('registers the seed script in the live missing/inactive-row guard', () => {
    const entry = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === WORK_ITEM_DURABLE_PARK_AUDIT);
    expect(entry, `${WORK_ITEM_DURABLE_PARK_AUDIT} must be covered by BESPOKE_ACTIVE_SEEDS`).toBeDefined();
    expect(entry?.seedScript).toBe(SEED_SCRIPT);
  });

  it('seeds no reconcile mode — the unattended row cannot become a mutator', () => {
    expect(seedCode).not.toMatch(/mode\s*:\s*['"]reconcile['"]/);
    expect(seedCode).not.toContain('runWorkItemDurableParkReconciliation');
  });

  it('CONTROL: the stripper keeps real code, so the guard above is not vacuously green', () => {
    // If the comment-stripper were over-eager it would blank the file and every
    // not-toMatch assertion would pass no matter what the seed script did.
    expect(seedCode).toContain('INSERT INTO harness_shared.routines');
    expect(seedCode).toContain('const payload = ');
    expect(seedCode.replace(/\s/g, '')).not.toBe('');
  });

  it('seeds a DAILY cadence, not an hourly or per-minute one', () => {
    // 6-field cron: sec min hour dom mon dow. A daily backstop pins a concrete hour;
    // a `*` in the hour field would silently make the "bounded backstop" run 24x.
    const cron = /const CRON = '([^']+)'/.exec(seedSource)?.[1];
    expect(cron, 'seed script must declare its cron as a CRON constant').toBeDefined();
    const [, , hour, dom, mon, dow] = (cron as string).split(' ');
    expect(hour).toMatch(/^\d+$/);
    expect([dom, mon, dow]).toEqual(['*', '*', '*']);
  });

  it('derives the routine name from the engine constant instead of retyping it', () => {
    // A hand-typed name here would seed a row no dispatch path can find.
    expect(seedSource).toContain('const name = WORK_ITEM_DURABLE_PARK_AUDIT;');
  });
});

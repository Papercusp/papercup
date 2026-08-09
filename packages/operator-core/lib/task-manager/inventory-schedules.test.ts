import { describe, expect, it } from 'vitest';
import { projectScheduleRows } from './inventory';

/**
 * P-019 — folding `collectScheduleInventory()` rows into the task pane as the RECURRING
 * kind. These tests are the spec for the projection; the render is a thin table over it.
 *
 * Everything asserted here is a distinction that, if flattened, produces a pane that
 * looks fine and reports something false. That is the failure mode this whole plan
 * exists to prevent, so it is the one the tests are aimed at.
 */

const row = (over: Partial<Parameters<typeof projectScheduleRows>[0][number]> = {}) => ({
  source: 'managed',
  scope: 'operator',
  tier: 'ephemeral',
  category: 'global-sweep',
  name: 'a-sweep',
  cadence: 'every 30s',
  ...over,
});

describe('projectScheduleRows (P-019)', () => {
  it('preserves armed:false as DISARMED and armed:undefined as UNKNOWN', () => {
    // The load-bearing case. `armed` is `true | false | null`, where null means NOT
    // APPLICABLE OR UNREACHABLE — not "off" (WI-6447). A `|| null` here would collapse
    // a timer we positively know is DISARMED into the same value we render as
    // "unknown", which reads as "we couldn't check" for something we did check.
    const [disarmed, unknown, armed] = projectScheduleRows([
      row({ name: 'off', armed: false }),
      row({ name: 'unreachable' }),
      row({ name: 'on', armed: true }),
    ]);
    expect(disarmed.armed).toBe(false);
    expect(unknown.armed).toBeNull();
    expect(armed.armed).toBe(true);
  });

  it('derives `federated` strictly, so a missing detail bag is never trusted', () => {
    // `federated` is what licenses a reader to believe armed/lastFire — the repo
    // convention says read it BEFORE trusting fire-state. A truthy-ish coercion would
    // promote a static-manifest row into a live measurement.
    const [live, manifest, noDetail, weird] = projectScheduleRows([
      row({ name: 'live', detail: { federated: true, process: 'bg-host:3080' } }),
      row({ name: 'manifest', detail: { federated: false } }),
      row({ name: 'bare' }),
      row({ name: 'weird', detail: { federated: 'yes' } }),
    ]);
    expect(live.federated).toBe(true);
    expect(live.process).toBe('bg-host:3080');
    expect(manifest.federated).toBe(false);
    expect(noDetail.federated).toBe(false);
    expect(noDetail.process).toBeNull();
    // A non-boolean truthy value is NOT federation.
    expect(weird.federated).toBe(false);
  });

  it('ignores a non-string `process` rather than rendering an object', () => {
    const [r] = projectScheduleRows([row({ detail: { process: { host: 'bg' } } })]);
    expect(r.process).toBeNull();
  });

  it('keys on source+scope+name, so the SAME sweep from two sources does not collide', () => {
    // The real shape this guards: one sweep registered locally as `managed` and
    // reported again by a sibling as `external-process`. Keying on name alone yields a
    // duplicate React key and silently drops one row — losing precisely the federated
    // row that tells you the timer runs somewhere else.
    const rows = projectScheduleRows([
      row({ source: 'managed', name: 'dbos-executor-reaper' }),
      row({ source: 'external-process', name: 'dbos-executor-reaper' }),
      row({ source: 'managed', scope: 'harness', name: 'dbos-executor-reaper' }),
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it('normalises every optional field to an explicit null', () => {
    // JSON.stringify DROPS undefined-valued keys, so an unnormalised row would ship
    // with the key ABSENT and the client could not tell "not reported" from "missing
    // field" — the same wire-totality rule the task rows above already follow.
    const [r] = projectScheduleRows([row()]);
    for (const k of ['installSlug', 'lastFire', 'nextFire', 'lastError', 'process'] as const) {
      expect(r[k]).toBeNull();
      expect(k in r).toBe(true);
    }
  });

  it('carries the fields through unchanged', () => {
    const [r] = projectScheduleRows([
      row({
        source: 'routines',
        scope: 'harness',
        tier: 'durable',
        category: 'routine',
        name: 'green-checkpoint',
        installSlug: 'papercusp',
        cadence: '*/15 * * * *',
        lastFire: '2026-08-09T04:00:00.000Z',
        nextFire: '2026-08-09T04:15:00.000Z',
        lastError: 'boom',
      }),
    ]);
    expect(r).toMatchObject({
      name: 'green-checkpoint',
      source: 'routines',
      scope: 'harness',
      tier: 'durable',
      category: 'routine',
      installSlug: 'papercusp',
      cadence: '*/15 * * * *',
      lastFire: '2026-08-09T04:00:00.000Z',
      nextFire: '2026-08-09T04:15:00.000Z',
      lastError: 'boom',
    });
  });

  it('is total — an empty inventory projects to an empty list, not a throw', () => {
    expect(projectScheduleRows([])).toEqual([]);
  });
});

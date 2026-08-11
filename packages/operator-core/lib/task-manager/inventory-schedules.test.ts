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
  it('redacts credential-bearing schedule errors before they reach the task-manager UI', () => {
    const [projected] = projectScheduleRows([
      row({ lastError: 'request failed with API_KEY=opaque-value-123' }),
    ]);
    expect(projected!.lastError).toContain('API_KEY=[redacted]');
    expect(projected!.lastError).not.toContain('opaque-value');
  });

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

  it('separates the SAME timer reported by two different sibling PROCESSES', () => {
    // ⚠ REGRESSION TEST FOR A BUG THIS SUITE ORIGINALLY MISSED. The first key was
    // `source:scope:name`, which passed a fixture-based uniqueness test and then
    // collided on 35 keys / 138 rows against the live inventory. This is the exact
    // shape it could not see: one timer, reported by two sibling processes, identical
    // in every field the old key used and differing ONLY in `detail.process`.
    const rows = projectScheduleRows([
      row({ source: 'external-process', name: 'await-event-sweeper', detail: { process: 'operator:3170' } }),
      row({ source: 'external-process', name: 'await-event-sweeper', detail: { process: 'operator:3270' } }),
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it('separates rows differing only by installSlug or category', () => {
    // `routines` is the largest source (351 of 559 in one live sample) and repeats
    // names across installs; category separates a watchdog from a sweep of the same name.
    const rows = projectScheduleRows([
      row({ source: 'routines', name: 'loop-tick', installSlug: 'papercusp' }),
      row({ source: 'routines', name: 'loop-tick', installSlug: 'oddsmith' }),
      row({ source: 'routines', name: 'loop-tick', installSlug: 'papercusp', category: 'watchdog' }),
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it('GUARANTEES uniqueness even when every encoded discriminator is identical', () => {
    // The property that makes this durable rather than lucky. Two rows alike in every
    // field the key encodes must STILL get distinct keys — otherwise a future source
    // that repeats along an unencoded axis silently drops rows from the render, which
    // is invisible in exactly the way this pane exists to prevent. Uniqueness is bound
    // to "one key per row", not to a guess about which fields discriminate.
    const rows = projectScheduleRows([row(), row(), row()]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    // The first row keeps the clean natural key; only collisions are suffixed, so the
    // common case stays readable and stable across refreshes.
    expect(rows[0].key).not.toContain('#');
    expect(rows[1].key).toBe(`${rows[0].key}#1`);
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

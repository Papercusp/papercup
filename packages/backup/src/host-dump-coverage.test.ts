/**
 * host-dump-coverage.test.ts — the decision that lets the per-workspace
 * pre-snapshot hook stand down when the host backup already dumped the database.
 *
 * The whole point of this module is that it is FAIL-SAFE: it may only return
 * `covered: true` on positive proof, because a false positive silently disables
 * a workspace's only database dump. So the bulk of these cases assert the
 * NEGATIVE branches — each one is a way the evidence can be missing, stale,
 * malformed, or about a different server, and each must fall through to dumping.
 *
 * The single positive case is deliberately outnumbered; that ratio is the
 * safety property, not test padding.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST_PG_DUMP_DIR,
  HOST_DUMP_MAX_AGE_SEC,
  HOST_PG_DUMP_DIR_ENV,
  evaluateHostDumpCoverage,
  hostDumpStatusPath,
} from './host-dump-coverage';

const NOW = 1_788_100_000;
const SYSID = '7635091775813704249';

/** A receipt that DOES prove coverage; each test perturbs exactly one field. */
const goodStatus = () => ({
  ok: true,
  lastSuccessEpoch: NOW - 600,
  dumped: ['postgres', 'papercusp', 'restart'],
  systemIdentifier: SYSID,
});

const evaluate = (over: Partial<Parameters<typeof evaluateHostDumpCoverage>[0]> = {}) =>
  evaluateHostDumpCoverage({
    database: 'papercusp',
    targetSystemIdentifier: SYSID,
    status: goodStatus(),
    nowEpoch: NOW,
    ...over,
  });

describe('evaluateHostDumpCoverage', () => {
  it('covers a fresh successful host dump of the same database on the same cluster', () => {
    const r = evaluate();
    expect(r.covered).toBe(true);
    expect(r.reason).toContain('covered by db-backup.sh');
    expect(r.reason).toContain(SYSID);
  });

  it('covers the authoritative state tier when the host producer uses tiered dumps', () => {
    const r = evaluate({
      status: {
        ok: true,
        lastSuccessEpoch: NOW - 600,
        dumped: ['papercusp-state', 'papercusp-transcript', 'restart'],
        tiersEnabled: true,
        systemIdentifier: SYSID,
      },
    });
    expect(r.covered).toBe(true);
    expect(r.reason).toContain('artifact papercusp-state');
  });

  it('does not treat a tier name as coverage unless tier mode is advertised', () => {
    const r = evaluate({
      status: {
        ok: true,
        lastSuccessEpoch: NOW - 600,
        dumped: ['papercusp-state', 'papercusp-transcript', 'restart'],
        systemIdentifier: SYSID,
      },
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('not in host-dump receipt');
  });

  it('does not cover when there is no receipt at all (the desktop ship target)', () => {
    expect(evaluate({ status: null })).toMatchObject({ covered: false });
  });

  it('does not cover when the host run reported failure', () => {
    expect(evaluate({ status: { ...goodStatus(), ok: false } })).toMatchObject({ covered: false });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['non-string', 12345],
  ])('does not cover when the receipt cluster identity is %s', (_label, systemIdentifier) => {
    const r = evaluate({ status: { ...goodStatus(), systemIdentifier } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('cluster identity');
  });

  it('does not cover when the target cluster identity could not be probed', () => {
    // psql missing, auth failure, or timeout — an unproven target never skips.
    const r = evaluate({ targetSystemIdentifier: null });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('probe');
  });

  it('does NOT cover a same-named database on a DIFFERENT cluster', () => {
    // The load-bearing case: a workspace's embedded Postgres routinely holds a
    // database named `papercusp`. A name-only comparison would suppress its
    // only dump. Identity must differ ⇒ dump.
    const r = evaluate({ targetSystemIdentifier: '1111111111111111111' });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('different cluster');
  });

  it('does not cover a database absent from the receipt (e.g. excluded by EXCLUDE_RE)', () => {
    const r = evaluate({ database: 'papercusp_scratch' });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('not in host-dump receipt');
  });

  it('does not cover when `dumped` is malformed rather than a string array', () => {
    expect(evaluate({ status: { ...goodStatus(), dumped: 'papercusp' } })).toMatchObject({
      covered: false,
    });
  });

  it('does not cover a stale receipt, so a wedged host job cannot suppress dumps forever', () => {
    const r = evaluate({ status: { ...goodStatus(), lastSuccessEpoch: NOW - HOST_DUMP_MAX_AGE_SEC - 1 } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('stale');
  });

  it('still covers a receipt exactly at the freshness boundary', () => {
    expect(
      evaluate({ status: { ...goodStatus(), lastSuccessEpoch: NOW - HOST_DUMP_MAX_AGE_SEC } }),
    ).toMatchObject({ covered: true });
  });

  it.each([
    ['zero', 0],
    ['missing', undefined],
    ['non-numeric', 'yesterday'],
  ])('does not cover when lastSuccessEpoch is %s', (_label, lastSuccessEpoch) => {
    expect(evaluate({ status: { ...goodStatus(), lastSuccessEpoch } })).toMatchObject({
      covered: false,
    });
  });

  it('treats a future-dated receipt as a clock fault, not as coverage', () => {
    const r = evaluate({ status: { ...goodStatus(), lastSuccessEpoch: NOW + 3600 } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('future');
  });

  it('always returns a non-empty reason, on every branch', () => {
    // The reason is written verbatim into the workspace hook.log; a blank one
    // would make an operator unable to tell WHY a dump did or did not happen.
    for (const r of [
      evaluate(),
      evaluate({ status: null }),
      evaluate({ targetSystemIdentifier: null }),
      evaluate({ database: 'absent' }),
    ]) {
      expect(r.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('hostDumpStatusPath', () => {
  it('defaults to the shared host dump directory', () => {
    expect(hostDumpStatusPath({})).toBe(`${DEFAULT_HOST_PG_DUMP_DIR}/STATUS.json`);
  });

  it('honors the shared env override', () => {
    expect(hostDumpStatusPath({ [HOST_PG_DUMP_DIR_ENV]: '/srv/dumps' })).toBe(
      '/srv/dumps/STATUS.json',
    );
  });

  it('ignores a blank override rather than resolving to a bare /STATUS.json', () => {
    expect(hostDumpStatusPath({ [HOST_PG_DUMP_DIR_ENV]: '   ' })).toBe(
      `${DEFAULT_HOST_PG_DUMP_DIR}/STATUS.json`,
    );
  });
});

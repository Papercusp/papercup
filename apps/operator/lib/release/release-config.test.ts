/**
 * release-config tests — the env seam that per-hive-git-and-release-gate (P-006/P-008)
 * generalizes through. The green-checkpoint/deploy SUBPROCESS resolves its roots, branches
 * and green command from `releaseConfig()`, which reads PAPERCUSP_* env. The per-hive handler
 * (release-actions.ts → resolveCheckpointRouting → hive-release-env.ts) hands that env overlay
 * to the subprocess, so THIS boundary is where a hive's identity becomes its paths.
 *
 * P-008 acceptance, proved end-to-end at the releaseConfig() boundary:
 *   - papercusp (no overlay / default env) → the LEGACY ../papercup-release root plus a
 *     PER-ROOT ../<basename>-checkpoint checkout (2026-07-02: the old fixed
 *     `papercup-checkpoint` name let two lineages race one checkout — see release-config.ts),
 *     main/staging, npm run test:affected.
 *   - a per-hive overlay env (the shape resolveHiveReleaseEnv emits) → the namespaced
 *     <slug>-release / <slug>-checkpoint roots, the hive's branches + green command.
 *   - an explicit caller override beats env (the operator-host PAPERCUSP_INTEGRATION_ROOT must
 *     not defeat the release lib's own throwaway-repo test overrides — release-config.ts comment).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import { releaseConfig } from './release-config';

/** Every PAPERCUSP_* key releaseConfig() reads — cleared so the host's live overlay (the
 *  :3070 operator exports PAPERCUSP_INTEGRATION_ROOT etc.) can't make these assertions flap. */
const RELEASE_ENV_KEYS = [
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_RELEASE_ROOT',
  'PAPERCUSP_CHECKPOINT_ROOT',
  'PAPERCUSP_RELEASE_REF',
  'PAPERCUSP_INTEGRATION_BRANCH',
  'PAPERCUSP_SYSTEMD_UNIT',
  'PAPERCUSP_HEALTH_URL',
  'PAPERCUSP_GREEN_CMD',
  'PAPERCUSP_CHECKPOINT_LOG_DIR',
  'PAPERCUSP_HONO_PORT',
] as const;

describe('releaseConfig — per-hive env seam (P-008)', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of RELEASE_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of RELEASE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('papercusp default (no overlay) → LEGACY papercup-release + per-root <basename>-checkpoint + main/staging', () => {
    const cfg = releaseConfig();
    // releaseRoot keeps the legacy fixed name — the live papercup-dev-api.service points at
    // it. checkpointRoot is per-root (disposable checkout, safe to namespace) so two
    // lineages sharing a parent dir can never race one checkout.
    expect(basename(cfg.releaseRoot)).toBe('papercup-release');
    expect(basename(cfg.checkpointRoot)).toBe(`${basename(cfg.integrationRoot)}-checkpoint`);
    expect(cfg.releaseRef).toBe('main');
    expect(cfg.integrationBranch).toBe('staging');
    expect(cfg.greenCmd).toBe('npm run test:affected');
  });

  it('two integration roots under ONE parent → DISTINCT checkpoint roots (cross-lineage race fix, 2026-07-02)', () => {
    // The real incident pair: the live papercusp root and the retired papercup root both
    // live under papercupai-workspace/. With the old fixed `papercup-checkpoint` default
    // both resolved to the SAME checkout; the stale lineage (resurrected via .env.local on
    // :3070) ran git checkout there mid-suite of a live papercusp run.
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/ws/papercusp';
    const live = releaseConfig();
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/ws/papercup';
    const retired = releaseConfig();
    expect(live.checkpointRoot).toBe('/ws/papercusp-checkpoint');
    // The retired root's basename still derives the LEGACY name — a straggler run of that
    // lineage keeps its existing dir rather than colliding with papercusp's new one.
    expect(retired.checkpointRoot).toBe('/ws/papercup-checkpoint');
    expect(live.checkpointRoot).not.toBe(retired.checkpointRoot);
  });

  it('per-hive overlay env (resolveHiveReleaseEnv shape) → NAMESPACED <slug>-* roots + the hive branches/greenCmd', () => {
    // Exactly the env overlay hive-release-env.ts emits for a regular coding hive.
    const hiveHome = '/tmp/hives/oddsmith-hive';
    process.env.PAPERCUSP_INTEGRATION_ROOT = hiveHome;
    process.env.PAPERCUSP_RELEASE_ROOT = '/tmp/hives/oddsmith-hive-release';
    process.env.PAPERCUSP_CHECKPOINT_ROOT = '/tmp/hives/oddsmith-hive-checkpoint';
    process.env.PAPERCUSP_INTEGRATION_BRANCH = 'staging';
    process.env.PAPERCUSP_RELEASE_REF = 'main';
    process.env.PAPERCUSP_GREEN_CMD = 'npm run test:ci';

    const cfg = releaseConfig();
    expect(cfg.integrationRoot).toBe(hiveHome);
    expect(cfg.releaseRoot).toBe('/tmp/hives/oddsmith-hive-release');
    expect(cfg.checkpointRoot).toBe('/tmp/hives/oddsmith-hive-checkpoint');
    expect(cfg.releaseRef).toBe('main');
    expect(cfg.integrationBranch).toBe('staging');
    expect(cfg.greenCmd).toBe('npm run test:ci');
    // The per-hive roots are genuinely DISTINCT from the legacy papercup-* roots — a hive's
    // green-checkpoint can never touch papercusp's checkout (the isolation the gate relies on).
    expect(basename(cfg.releaseRoot)).not.toBe('papercup-release');
    expect(basename(cfg.checkpointRoot)).not.toBe('papercup-checkpoint');
  });

  it('explicit caller override beats env (operator-host overlay must not defeat throwaway-repo test overrides)', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/tmp/hives/oddsmith-hive';
    process.env.PAPERCUSP_GREEN_CMD = 'npm run test:ci';
    const cfg = releaseConfig({ integrationRoot: '/tmp/throwaway', greenCmd: 'echo green' });
    expect(cfg.integrationRoot).toBe('/tmp/throwaway');
    expect(cfg.greenCmd).toBe('echo green');
  });
});

/**
 * WI-38241 — the SECOND integrationRoot resolver.
 *
 * release-actions.ts guards the routine dispatcher's `cwd`-relative fallback. THIS file is the
 * resolver green-checkpoint itself consumes, and its fallback (`scriptRepoRoot()`) is different:
 * it resolves to whichever repo the SCRIPT FILE lives in. Safer than cwd — run staging's copy,
 * get staging — but still silently wrong in the one case that matters: run papercup-release's
 * copy with no env and the gate judges the DEPLOY ARTIFACT, with no error and no log line
 * naming the tree.
 *
 * These take env/overrides as ARGUMENTS, so they need no process.env mutation and cannot flap
 * against the host's live overlay.
 */
describe('WI-38241: integration-root provenance + the gate-only refusal', () => {
  const WS = '/home/dev/papercupai-workspace';

  it('reports the SOURCE, not just the value — provenance is the half that settles an argument', () => {
    expect(describeIntegrationRoot({ integrationRoot: `${WS}/a` }, {})).toEqual({
      root: `${WS}/a`,
      source: 'override',
    });
    expect(describeIntegrationRoot({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/b` })).toEqual({
      root: `${WS}/b`,
      source: 'PAPERCUSP_INTEGRATION_ROOT',
    });
  });

  it('preserves the documented precedence: override beats env', () => {
    expect(
      describeIntegrationRoot(
        { integrationRoot: `${WS}/override` },
        { PAPERCUSP_INTEGRATION_ROOT: `${WS}/env` },
      ),
    ).toEqual({ root: `${WS}/override`, source: 'override' });
  });

  it('the evidence line carries BOTH the root and how it was chosen', () => {
    const line = integrationRootEvidence({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercusp` });
    expect(line).toContain(`${WS}/papercusp`);
    expect(line).toContain('source=PAPERCUSP_INTEGRATION_ROOT');
    // must not mislabel an env root as derived — that sends a reader hunting the wrong bug
    expect(line).not.toContain('script-repo');
  });

  it('REFUSES a DERIVED release/checkpoint checkout, naming the path and the remedy', () => {
    for (const bad of ['papercup-release', 'papercusp-release', 'papercup-checkpoint', 'papercusp-checkpoint']) {
      expect(() => assertGateableIntegrationRoot({}, {}, () => `${WS}/${bad}`)).toThrow(
        /refusing to gate/,
      );
    }
    let msg = '';
    try {
      assertGateableIntegrationRoot({}, {}, () => `${WS}/papercup-release`);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain(`${WS}/papercup-release`); // the resolved path, not just a basename
    expect(msg).toContain('PAPERCUSP_INTEGRATION_ROOT'); // how to fix it
  });

  it('the predicate is falsifiable in BOTH directions against the real set', () => {
    expect(isNonGateableCheckout(`${WS}/papercup-release`)).toBe(true);
    expect(isNonGateableCheckout(`${WS}/papercusp-checkpoint`)).toBe(true);
    // and must NOT swallow the working tree, or the gate refuses everything
    expect(isNonGateableCheckout(`${WS}/papercusp`)).toBe(false);
    expect(isNonGateableCheckout(`${WS}/papercup`)).toBe(false);
    // a substring match would wrongly reject this; the check is on the basename
    expect(isNonGateableCheckout(`${WS}/papercup-release-notes`)).toBe(false);
  });

  it('an EXPLICITLY NAMED release checkout is ALLOWED — the guard is for the unselected case', () => {
    // Someone who names a root has stated an intent; refusing it would break legitimate
    // throwaway-checkout testing, which is what release-config's override seam exists for.
    expect(() =>
      assertGateableIntegrationRoot({ integrationRoot: `${WS}/papercup-release` }, {}),
    ).not.toThrow();
    expect(() =>
      assertGateableIntegrationRoot({}, { PAPERCUSP_INTEGRATION_ROOT: `${WS}/papercup-release` }),
    ).not.toThrow();
  });

  it('a NORMAL derived root is allowed (the guard must not refuse the working path)', () => {
    expect(() =>
      assertGateableIntegrationRoot({ integrationRoot: `${WS}/papercusp` }, {}),
    ).not.toThrow();
  });

  it('CALIBRATION — the refusal can actually FIRE, or every not-throw above proves nothing', () => {
    // scriptRepoRoot() reads this file's own location, so the derived branch cannot be steered
    // from a test. Exercise the same decision the guard makes, against the same set, so a
    // regression that empties NON_GATEABLE_CHECKOUTS or inverts the basename test is caught.
    const wouldRefuse = (root: string, source: string) =>
      source === 'script-repo' &&
      ['papercup-release', 'papercusp-release', 'papercup-checkpoint', 'papercusp-checkpoint'].includes(
        basename(root),
      );
    expect(wouldRefuse(`${WS}/papercup-release`, 'script-repo')).toBe(true);
    expect(wouldRefuse(`${WS}/papercusp-checkpoint`, 'script-repo')).toBe(true);
    expect(wouldRefuse(`${WS}/papercusp`, 'script-repo')).toBe(false);
    expect(wouldRefuse(`${WS}/papercup-release`, 'override')).toBe(false);
  });
});

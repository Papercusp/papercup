/**
 * release-config tests — the env seam that per-hive-git-and-release-gate (P-006/P-008)
 * generalizes through. The green-checkpoint/deploy SUBPROCESS resolves its roots, branches
 * and green command from `releaseConfig()`, which reads PAPERCUSP_* env. The per-hive handler
 * (release-actions.ts → resolveCheckpointRouting → hive-release-env.ts) hands that env overlay
 * to the subprocess, so THIS boundary is where a hive's identity becomes its paths.
 *
 * P-008 acceptance, proved end-to-end at the releaseConfig() boundary:
 *   - papercusp (no overlay / default env) → the LEGACY ../papercup-release + ../papercup-checkpoint
 *     roots, main/staging, npm run test:affected — i.e. EXACT current behavior (regression-safe).
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

  it('papercusp default (no overlay) → LEGACY papercup-* roots + main/staging (regression-safe)', () => {
    const cfg = releaseConfig();
    // The legacy naming is derived from dirname(integrationRoot) regardless of where the
    // integration tree actually is, so these are path-independent (no git/CWD dependency).
    expect(basename(cfg.releaseRoot)).toBe('papercup-release');
    expect(basename(cfg.checkpointRoot)).toBe('papercup-checkpoint');
    expect(cfg.releaseRef).toBe('main');
    expect(cfg.integrationBranch).toBe('staging');
    expect(cfg.greenCmd).toBe('npm run test:affected');
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

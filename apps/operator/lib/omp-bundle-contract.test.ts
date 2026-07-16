/**
 * omp bundle contract (deterministic-context-carry P-003, ornith overflow 2026-07-13).
 *
 * Papercusp's compaction-delivery machinery (P-001 shake seeding, P-002
 * compaction.remoteEndpoint → the gateway maintenance lane) and the decision NOT to
 * patch a pre-flight context guard into the bundle both rest on capabilities of the
 * INSTALLED omp (@oh-my-pi/pi-coding-agent). omp >= 16.3.3 implements the "refuse to
 * send a doomed over-window request; fail loud, not a dead session" intent upstream:
 *   - pre-prompt context maintenance sized against the PENDING prompt, on every prompt;
 *   - provider context-overflow classification (including llama-server's `n_ctx` /
 *     "exceeds the available context size" wording, and a usage>window arm) feeding
 *     overflow-triggered compaction + model promotion — a classified, surfaced error
 *     when compaction is off, never a silent death.
 * This suite pins those capabilities as marker strings against the installed bundle so
 * an omp downgrade/regression trips HERE, in tests, instead of resurrecting the
 * 2026-07-13 incident in a live fleet. Verified against omp 16.3.3.
 *
 * The omp install is user-level (bun-managed, `~/node_modules/@oh-my-pi/...`, the
 * `omp` bin symlinks into it) — NOT a repo dependency — so the whole suite SKIPS
 * cleanly on a box/CI without it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PKG_DIR = join(homedir(), 'node_modules', '@oh-my-pi', 'pi-coding-agent');
const BUNDLE = join(PKG_DIR, 'dist', 'cli.js');
const SETTINGS_SCHEMA = join(PKG_DIR, 'dist', 'types', 'config', 'settings-schema.d.ts');
const PI_AI_FLAGS = join(homedir(), 'node_modules', '@oh-my-pi', 'pi-ai', 'src', 'error', 'flags.ts');

/** Minimum version whose upstream overflow handling we verified end-to-end (2026-07-14). */
const VERIFIED_MIN_VERSION = [16, 3, 3] as const;

const installed = existsSync(BUNDLE) && existsSync(join(PKG_DIR, 'package.json'));

describe.skipIf(!installed)('installed omp bundle contract (P-003)', () => {
  const bundle = () => readFileSync(BUNDLE, 'utf8');

  it(`is at least v${VERIFIED_MIN_VERSION.join('.')} (the version the overflow-handling contract was verified on)`, () => {
    const version = String(JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version ?? '');
    const parts = version.split('.').map((p) => Number.parseInt(p, 10));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const cmp = parts[0] !== VERIFIED_MIN_VERSION[0] ? parts[0] - VERIFIED_MIN_VERSION[0]
      : parts[1] !== VERIFIED_MIN_VERSION[1] ? parts[1] - VERIFIED_MIN_VERSION[1]
      : parts[2] - VERIFIED_MIN_VERSION[2];
    expect(cmp, `installed omp ${version} is older than verified ${VERIFIED_MIN_VERSION.join('.')}`).toBeGreaterThanOrEqual(0);
  });

  it('classifies provider context-overflow errors, including llama-server wordings (the incident backend)', () => {
    const src = bundle();
    // Regex sources of the overflow classifier — the exact wordings llama-server /
    // llama.cpp return for an over-window request (the 2026-07-13 HTTP 400).
    expect(src).toContain('exceeds the available context size');
    expect(src).toContain('n_ctx');
    // The classified error label surfaced on the message (fail-loud, inspectable).
    expect(src).toContain('context-overflow');
  });

  it('runs pre-prompt context maintenance sized against the pending prompt (upstream pre-flight guard)', () => {
    expect(bundle()).toContain('Pre-prompt context maintenance triggered by pending prompt size');
  });

  it('ships the remote-compaction client + settings keys the P-001/P-002 delivery writes', () => {
    const src = bundle();
    // P-002: compaction.remoteEndpoint → gateway /maintenance/summarize rides this client.
    expect(src).toContain('requestRemoteCompaction');
    expect(src).toContain('remoteEndpoint');
    const schema = readFileSync(SETTINGS_SCHEMA, 'utf8');
    expect(schema).toContain('remoteEndpoint');
    // P-001: the seeded strategy/threshold keys.
    expect(schema).toContain('thresholdPercent');
    expect(schema).toContain('strategy');
  });

  it('classifies generic local-server 500/internal errors as retriable and exposes the local retry kill-switch (WI-5047)', () => {
    // A llama-server cudaMalloc startup failure reaches OMP as a generic HTTP 500 /
    // internal error. The installed classifier marks that broad class transient, so
    // Papercusp must use the supported per-session retry.enabled seam to fail loud
    // instead of replaying the same impossible allocation ten times.
    const flags = readFileSync(PI_AI_FLAGS, 'utf8');
    expect(flags).toContain('RETRIABLE_KINDS');
    expect(flags).toContain('Flag.Transient');
    expect(flags).toContain('500|502|503|504');
    expect(flags).toContain('internal.?error');
    const schema = readFileSync(SETTINGS_SCHEMA, 'utf8');
    expect(schema).toContain('"retry.enabled"');
    expect(schema).toContain('"retry.maxRetries"');
  });
});

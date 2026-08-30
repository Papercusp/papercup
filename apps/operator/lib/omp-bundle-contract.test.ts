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
 * 2026-07-13 incident in a live fleet. Verified against omp 16.3.3; re-verified
 * against 17.0.7 (which minifies the remote-compaction client fn name — see the
 * remote-compaction test's note; markers re-pinned to minification-stable config keys).
 *
 * The omp install is user-level (bun-managed, `~/node_modules/@oh-my-pi/...`, the
 * `omp` bin symlinks into it) — NOT a repo dependency — so the whole suite SKIPS
 * cleanly on a box/CI without it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Candidate roots for the user-level omp install, newest layout first.
 *
 * This USED to be a single hardcoded `~/node_modules` path. Bun's global install
 * lives at `~/.bun/install/global/node_modules`, so once omp moved there the
 * `existsSync` probe below went false and `describe.skipIf` silently disabled this
 * ENTIRE suite — on a box with omp very much installed and in active use. A guard
 * written to stop a live-fleet overflow incident (2026-07-13) recurring then
 * protected nothing, and reported green while doing it (EI-18607938218532714).
 *
 * Resolve across candidates rather than assuming one, and see the resolution
 * describe() below, which fails loudly if this list ever goes stale again.
 */
const OMP_ROOTS = [
  join(homedir(), '.bun', 'install', 'global', 'node_modules'),
  join(homedir(), 'node_modules'),
] as const;

/** The package dir of the first candidate root carrying a real bundle, else null. */
function resolveOmpDir(): string | null {
  for (const root of OMP_ROOTS) {
    const dir = join(root, '@oh-my-pi', 'pi-coding-agent');
    if (existsSync(join(dir, 'dist', 'cli.js')) && existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

/**
 * Where an omp install might live, for DETECTION — deliberately broader than, and
 * maintained separately from, the OMP_ROOTS used for RESOLUTION.
 *
 * The two lists must not be the same list. If detection reused OMP_ROOTS, then the
 * one failure that actually occurred — omp moving to a location OMP_ROOTS does not
 * name — would make detection come up empty too, and the dead-guard check below
 * would pass by measuring nothing. That is the same vacuity trap this file's own
 * contract tests guard against, one level up.
 */
const OMP_DISCOVERY_ROOTS = [
  join(homedir(), 'node_modules'),
  join(homedir(), '.bun', 'install', 'global', 'node_modules'),
  join(homedir(), '.local', 'share', 'bun', 'install', 'global', 'node_modules'),
  join(homedir(), '.npm-global', 'lib', 'node_modules'),
  join(homedir(), '.local', 'lib', 'node_modules'),
] as const;

/**
 * Package dirs that EXIST anywhere we know to look, whether or not they carry a
 * usable bundle and whether or not OMP_ROOTS names them.
 *
 * RESIDUAL LIMIT, stated rather than papered over: this is still a list, so an
 * install under a root named by NEITHER list is invisible to it and the dead-guard
 * check stays silent. Widening detection shrinks that blind spot; it does not close
 * it. Closing it entirely needs a walk of $HOME, which is too costly for a unit test.
 */
function ompPackageDirsPresent(): string[] {
  return [...new Set([...OMP_ROOTS, ...OMP_DISCOVERY_ROOTS])]
    .map((root) => join(root, '@oh-my-pi', 'pi-coding-agent'))
    .filter((d) => existsSync(d));
}

const OMP_DIR = resolveOmpDir();
const installed = OMP_DIR !== null;

// Fallback keeps these path constants well-formed when omp is absent; nothing reads
// them in that case, because every test below is inside the skipped describe.
const PKG_DIR = OMP_DIR ?? join(homedir(), 'node_modules', '@oh-my-pi', 'pi-coding-agent');
const BUNDLE = join(PKG_DIR, 'dist', 'cli.js');
const SETTINGS_SCHEMA = join(PKG_DIR, 'dist', 'types', 'config', 'settings-schema.d.ts');
const PI_AI_FLAGS = join(PKG_DIR, '..', 'pi-ai', 'src', 'error', 'flags.ts');

/** Minimum version whose upstream overflow handling we verified end-to-end (2026-07-14). */
const VERIFIED_MIN_VERSION = [16, 3, 3] as const;

// NOT skipped: a silently-skipping guard is the failure this suite already suffered
// once, and by construction it cannot be caught by any test inside the skipped block.
describe('omp bundle contract — resolution', () => {
  it('does not skip while an omp install is actually present (dead-guard guard)', () => {
    const present = ompPackageDirsPresent();
    if (present.length === 0) return; // genuinely no omp on this box — the legitimate skip

    expect(
      OMP_DIR,
      `@oh-my-pi/pi-coding-agent EXISTS at ${present.join(', ')} but no candidate root ` +
        `yielded dist/cli.js + package.json, so the contract suite below would skip and ` +
        `guard nothing. OMP_ROOTS is stale — add the current install layout.`,
    ).not.toBeNull();
  });

  it('reads the files the contract asserts against, rather than throwing ENOENT mid-suite', () => {
    if (!installed) return;
    // `installed` only probes cli.js + package.json, but the tests below also read the
    // settings schema and pi-ai's flags source. Without this, a packaging change makes
    // the suite die on an opaque ENOENT stack instead of naming what moved.
    for (const [label, path] of [
      ['settings schema', SETTINGS_SCHEMA],
      ['pi-ai error flags', PI_AI_FLAGS],
    ] as const) {
      expect(existsSync(path), `${label} not found at ${path} — omp packaging changed`).toBe(true);
    }
  });
});

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
    // Pin the remote-compaction capability via the CONFIG keys that survive minification:
    // `remoteEndpoint` (the settings seam Papercusp's delivery actually rides) and the
    // `remoteCompaction` model-config key. omp <=16.3.3 also exposed the client as a named
    // `requestRemoteCompaction` fn, but 17.x minifies that fn to a local — the fn name is no
    // longer a stable marker (its rename is not a regression; the capability still ships),
    // so we pin the config keys instead. Re-verified against omp 17.0.7.
    expect(src).toContain('remoteCompaction');
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

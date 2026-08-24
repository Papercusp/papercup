/**
 * WI-6643 — cross-scanner parity: the WRITE-time hook must catch everything the
 * PUBLISH-time guard catches.
 *
 * ## Why this test exists
 * There are two independent secret scanners:
 *   1. write-time  — apps/operator/scripts/hooks/cc/pretooluse-secrets-guard.mjs
 *                    (Claude Code PreToolUse; DENIES the write)
 *   2. publish-time — ./secrets-guard.ts (refuses the own-head publish)
 *
 * (2) is unforgiving in a way (1) is not: its baseline never advances past a refused
 * range (own-head-publish.ts keeps `guardBaseline = priorSha ?? genesisBaselineSha`,
 * and `priorSha` only moves on an ADMITTED publish), so a single offending blob is
 * rescanned and re-refused on EVERY later tick. Editing the file does not help — the
 * blob is already in history. The whole hive's publish plane stays frozen until a path
 * exemption lands.
 *
 * So the two sets diverging is not a tidiness problem, it is the bug: on 2026-07-28 the
 * generic `secret-assignment` rule existed ONLY in the publish guard, a redactor test's
 * `api_key:`-shaped fixtures sailed past the write-time hook, and the plane froze ~8h
 * with no signal to the author who caused it (WI-6641).
 *
 * ## The invariant
 * hook ⊇ guard. Anything the publish guard would refuse must be refused at write time,
 * while the file is still editable and nothing is committed. The reverse is explicitly
 * ALLOWED — the hook is stricter today (`sk-…`, `github_pat_…` have no publish-side
 * equivalent) and that costs nothing, because over-refusing a WRITE is recoverable in
 * seconds whereas over-refusing a PUBLISH freezes the fleet.
 *
 * ## Why it shells out
 * The hook is COPIED out of the repo by install-standalone-mcp.sh, so it is deliberately
 * import-free and cannot share a module with this package. It exposes `--dump-patterns`
 * for inventory and is driven end-to-end via stdin for behaviour. Comparing regex SOURCE
 * text would be brittle and would not catch a gate (entropy/placeholder) drifting; this
 * compares VERDICTS on a shared corpus instead.
 *
 * ⚠ Every sample below is BUILT BY CONCATENATION, never written as a literal. This file
 * is scanned by the very guard it tests — a literal credential shape here would wedge the
 * publish plane exactly as described above, which is the trap this whole work item is
 * about. Keep it that way.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanTextForSecrets } from './secrets-guard';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const HOOK = path.join(REPO_ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-secrets-guard.mjs');

/** A tree path the hook considers in-scope, so its shared-tree filter does not short it out. */
const IN_TREE_FILE = path.join(REPO_ROOT, 'packages/operator-core/lib/sync/pot-git/parity-probe.ts');

/** Run the hook exactly as Claude Code does: JSON on stdin, JSON decision on stdout. */
function hookDenies(content: string): boolean {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: IN_TREE_FILE, content },
  });
  const out = execFileSync('node', [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, PAPERCUSP_SECRETS_GUARD_TREES: `${REPO_ROOT}/`, PAPERCUSP_SECRETS_GUARD_ALLOW: '' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (!out.trim()) return false;
  try {
    return JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

const guardFlags = (content: string): boolean => scanTextForSecrets('probe.ts', content).length > 0;

// ── Corpus. Assembled from parts so no credential shape is ever a literal here. ──
const A16 = 'QH8DHBQWERTYUIOP'; // 16 uppercase alnum, no EXAMPLE suffix
const HEX36 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00918';
const HI_ENTROPY = 'aF3kZ9qL2xR7bN4tW8yE'; // 20 chars, entropy > 3.2

const SAMPLES: Array<{ what: string; content: string }> = [
  { what: 'AWS long-lived access key id', content: `const k = "${'AKIA'}${A16}";` },
  { what: 'AWS temporary (session) access key id', content: `const k = "${'ASIA'}${A16}";` },
  { what: 'GitHub classic PAT', content: `const t = "${'ghp' + '_'}${HEX36}";` },
  { what: 'GitHub server token', content: `const t = "${'ghs' + '_'}${HEX36}";` },
  { what: 'Slack bot token', content: `const t = "${'xoxb' + '-'}${'123456789012'}${'-abcdefghijkl'}";` },
  { what: 'Stripe live secret key', content: `const t = "${'sk' + '_live_'}${HI_ENTROPY}${'A1b2'}";` },
  // Exactly 35 chars after the AIza prefix — the guard's rule is a fixed {35}, so a
  // 36th alphanumeric breaks the trailing \b and the sample silently stops matching.
  { what: 'Google API key', content: `const t = "${'AIza'}${'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'}";` },
  { what: 'PEM private key header', content: `${'-----BEGIN '}${'RSA '}${'PRIVATE KEY-----'}` },
  // The rule whose ABSENCE from the hook caused WI-6641's 8h freeze.
  { what: 'secret-named assignment, high-entropy value (api_key:)', content: `${'api' + '_key'}: "${HI_ENTROPY}"` },
  { what: 'secret-named assignment, high-entropy value (ACCESS_TOKEN=)', content: `${'access' + '_token'}="${HI_ENTROPY}"` },
];

describe('write-time hook ⊇ publish-time guard (WI-6643)', () => {
  it('the hook script is present at the path the installers copy from', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it.each(SAMPLES)('the publish guard flags $what — so the write-time hook must too', ({ content }) => {
    // Guard the premise: if this stops being a publish-guard hit the sample has rotted
    // and the parity assertion below would pass vacuously.
    expect(guardFlags(content), 'sample no longer trips the publish guard — fix the sample').toBe(true);
    expect(
      hookDenies(content),
      'the publish guard refuses this but the write-time hook allows it — an author will be ' +
        'green-lit at write time and the publish plane will freeze later with no signal. Add the ' +
        'missing rule to pretooluse-secrets-guard.mjs.',
    ).toBe(true);
  });

  it('neither scanner flags ordinary code (no false-positive floor)', () => {
    const benign = 'const greeting = "hello world";\nexport const RETRIES = 3;\n';
    expect(guardFlags(benign)).toBe(false);
    expect(hookDenies(benign)).toBe(false);
  });

  it('both scanners suppress an obvious placeholder assignment (gates agree, not just shapes)', () => {
    // Same SHAPE as the api_key sample above, but a placeholder value: the guard suppresses
    // it via PLACEHOLDER_RE/entropy, and the hook must suppress it too — otherwise the hook
    // blocks writes the publish plane would have accepted.
    const placeholder = `${'api' + '_key'}: "${'your-api-key-goes-here'}"`;
    expect(guardFlags(placeholder)).toBe(false);
    expect(hookDenies(placeholder)).toBe(false);
  });

  it('exposes a machine-readable rule inventory for drift review', () => {
    const out = execFileSync('node', [HOOK, '--dump-patterns'], {
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    const dumped = JSON.parse(out) as {
      patterns: Array<{ name: string; source: string }>;
      minEntropy: number;
    };
    expect(dumped.patterns.length).toBeGreaterThanOrEqual(8);
    // The entropy gate must match the publish guard's SECRET_ASSIGNMENT_MIN_ENTROPY, or the
    // two disagree on the exact rule that caused this bug.
    expect(dumped.minEntropy).toBe(3.2);
  });
});

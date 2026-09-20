/**
 * WI-10002028. CLAUDE.md tells a toolless agent that an `Identity capability
 * (unresolved): stale-artifact` denial is opened by `coord:orient`, NOT by
 * scripts/mcp-call.mjs. That is a claim about CODE, so it is pinned here rather
 * than left as prose: if someone re-seals the recovery door, the doc would go on
 * confidently routing bricked sessions through a verb that no longer works, and
 * a bricked session is the one state that cannot report the discrepancy.
 *
 * The rule enforced on the port is single-source: exactly ONE literal
 * `denial('stale-artifact'` may exist, the one inside the staleArtifact() helper
 * that implements the exemption. A second occurrence means some call site
 * bypassed the helper and re-sealed that path — which is precisely how this bug
 * existed in the first place (six sites, each denying independently).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once
 * the live assertion goes green it stops being evidence that the detector works
 * at all. Each fixture reproduces a shape that MUST be caught.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PORT = join(ROOT, 'packages/operator-core/lib/capability-envelope/identity-grants-port.ts');
const CLAUDE_MD = join(ROOT, 'CLAUDE.md');

const RECOVERY_TOOL = 'coord:orient';

interface Verdict { ok: boolean; violations: string[]; rawDenialSites: number }

/** The port must exempt the resync verb from every stale-artifact denial. */
export function judgeIdentityRecoveryDoor(portSource: string): Verdict {
  const violations: string[] = [];
  const rawDenialSites = portSource.split("denial('stale-artifact'").length - 1;

  if (!portSource.includes(`IDENTITY_RECOVERY_TOOL = '${RECOVERY_TOOL}'`)) {
    violations.push(
      `the port no longer names ${RECOVERY_TOOL} as IDENTITY_RECOVERY_TOOL, so the door CLAUDE.md sends bricked sessions to is gone`,
    );
  }
  if (rawDenialSites !== 1) {
    violations.push(
      `expected exactly 1 literal denial('stale-artifact' (inside staleArtifact()), found ${rawDenialSites} — a site that denies directly re-seals the recovery door for that path`,
    );
  }
  return { ok: violations.length === 0, violations, rawDenialSites };
}

describe('CLAUDE.md identity-recovery-door claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a call site that denies stale-artifact directly, bypassing the helper', () => {
      const verdict = judgeIdentityRecoveryDoor(`
        const IDENTITY_RECOVERY_TOOL = '${RECOVERY_TOOL}';
        function staleArtifact(request) { return denial('stale-artifact', null, request.toolName); }
        function check() { return denial('stale-artifact', null, request.toolName); }
      `);
      expect(verdict.ok).toBe(false);
      expect(verdict.rawDenialSites).toBe(2);
      expect(verdict.violations.join('\n')).toMatch(/re-seals the recovery door/);
    });

    it('catches the door being removed outright — the pre-WI-10002028 state', () => {
      const verdict = judgeIdentityRecoveryDoor(`
        function check() { return denial('stale-artifact', null, request.toolName); }
      `);
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no longer names coord:orient/);
    });

    it('passes a port that routes every site through the helper', () => {
      expect(judgeIdentityRecoveryDoor(`
        const IDENTITY_RECOVERY_TOOL = '${RECOVERY_TOOL}';
        function staleArtifact(request) { return denial('stale-artifact', null, request.toolName); }
        function check() { return staleArtifact(request); }
      `)).toMatchObject({ ok: true, rawDenialSites: 1 });
    });
  });

  it('holds against the live identity-grants-port source', () => {
    const verdict = judgeIdentityRecoveryDoor(readFileSync(PORT, 'utf8'));
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('keeps the projected doc pointing at the door that actually opens', () => {
    const doc = readFileSync(CLAUDE_MD, 'utf8');
    // The identity class must name the resync verb...
    expect(doc).toContain(`${RECOVERY_TOOL} { afterCompaction: true }`);
    // ...and must explicitly refuse the transport fallback for this class, so an
    // agent cannot read mcp-call.mjs as the remedy the way WI-10002028 reported.
    expect(doc).toMatch(/mcp-call\.mjs` CANNOT open this one/);
  });
});

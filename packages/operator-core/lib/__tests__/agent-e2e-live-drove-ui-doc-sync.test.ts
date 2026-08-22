/**
 * agent-e2e-live-drove-ui-doc-sync.test.ts — keeps `/internal/docs/testing/agent-e2e`
 * in sync with the completion gate it has to teach (EI-19425652963178450).
 *
 * THE FAILURE THIS PREVENTS is a pure documentation-drift bug with an expensive,
 * DELAYED symptom. An agent plans a UI drive from §1.3, but `work_items:complete`
 * only applies `isBackedLiveDroveUiClaim` at CLOSE time — by which point an isolated
 * Tauri instance has been torn down. So a doc that teaches a command the gate does not
 * accept is not discovered when it is read; it is discovered ~an hour later, and
 * recovering costs a second full shell boot (~4 min) purely to re-run assertions that
 * already passed. That is exactly what was filed.
 *
 * The originally-filed remedy was "add a warning line to §1.3", but the guidance
 * already existed — in §15, ~1,950 lines below the recipe agents actually copy. So the
 * real defect was PLACEMENT, and the fix is a cross-reference. A cross-reference is
 * precisely the kind of thing that rots silently, which is why it is asserted here.
 *
 * Scoped deliberately: this pins the CONTRACT (which subcommands are accepted, and that
 * the §1.3 recipe warns about the gate at all) — not prose wording, which must stay free
 * to be edited.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS, citesScreenshotArtifact } from '../completion-audit';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * Overridable so falsifiability can be proven by COPY-OUT (CLAUDE.md § "Proving a guard
 * is falsifiable", tier 2): `scripts/mutation-probe.sh` mutates a copy outside the tree
 * and points this at it, so the tracked doc is never dirty for even an instant — no
 * sweep race, no lock, no restore to get wrong. Defaults to the real path.
 */
const DOC = process.env.PROBE_AGENT_E2E_DOC || resolve(REPO_ROOT, 'apps/operator-docs/src/content/docs/testing/agent-e2e.mdx');

const doc = readFileSync(DOC, 'utf8');

/** The §1.3 drive recipe — where an agent copies its commands from — ending at §2. */
function sectionOneThree(): string {
  const start = doc.indexOf('### 1.3');
  const end = doc.indexOf('## 2. Reporting format');
  expect(start, 'agent-e2e.mdx must still have a §1.3 heading').toBeGreaterThan(-1);
  expect(end, 'agent-e2e.mdx must still have a §2 heading').toBeGreaterThan(start);
  return doc.slice(start, end);
}

describe('agent-e2e doc stays in sync with the live-drove-ui completion gate', () => {
  it('warns about the completion gate INSIDE §1.3, where the drive is planned', () => {
    // Not wording-sensitive: it asserts the two load-bearing tokens are present in the
    // section an agent reads BEFORE booting, rather than only in §15 after the fact.
    const s = sectionOneThree();
    expect(s).toContain('live-drove-ui');
    expect(s).toContain('work_items:complete');
  });

  it('names every subcommand the gate actually accepts', () => {
    const s = sectionOneThree();
    for (const sub of LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS) {
      expect(s, `§1.3 must name the accepted subcommand '${sub}'`).toContain(sub);
    }
  });

  it("§1.3's own `eval` examples genuinely would NOT satisfy the gate — the reason the warning must be there", () => {
    // Ties the doc's examples to the real predicate instead of pinning prose (wording
    // must stay free to edit). `eval` is the command §1.3 reaches for first, and these
    // lines are what an agent copies — so if the gate ever DID accept them the warning
    // would be actively misleading and this fails, and if `eval` is ever added to the
    // accepted set this fails too.
    expect(LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS as readonly string[]).not.toContain('eval');
    const evalOnly = sectionOneThree()
      .split('\n')
      .filter((l) => /\btauri-agent-tools\s+eval\b/.test(l))
      .filter((l) => !LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS.some((s) => l.includes(s)));
    expect(evalOnly.length, '§1.3 should still demonstrate `eval` for exploration').toBeGreaterThan(0);
    for (const line of evalOnly) {
      expect(citesScreenshotArtifact(line), `gate unexpectedly ACCEPTS an eval-only line: ${line}`).toBe(false);
    }
  });

  it('the command §1.3 recommends would REALLY satisfy the gate — checked against the gate itself', () => {
    // The decisive assertion: run the doc's own recommended invocation through the real
    // predicate. A doc example that merely LOOKS compliant is the whole failure mode, so
    // this cannot be satisfied by prose — only by an example the gate genuinely accepts.
    const recommended = sectionOneThree()
      .split('\n')
      // Restrict this to actual shell command lines. Prose such as "--json belongs
      // to check, not eval" names both the tool and an accepted subcommand but is
      // not itself evidence-bearing output.
      .filter((l) => /^\s*tauri-agent-tools\s+\S/.test(l))
      .filter((l) => LIVE_DROVE_UI_EVIDENCE_SUBCOMMANDS.some((s) => l.includes(s)));
    expect(recommended.length, '§1.3 must show at least one gate-satisfying command').toBeGreaterThan(0);
    for (const line of recommended) {
      expect(citesScreenshotArtifact(line), `§1.3 shows a command the gate would REJECT: ${line}`).toBe(true);
    }
  });

  it('CONTROL — the predicate rejects the eval-only form, so the assertions above are not vacuous', () => {
    // Calibration: if citesScreenshotArtifact accepted everything, every assertion above
    // would pass while proving nothing. A bare eval transcript must be refused.
    expect(citesScreenshotArtifact('tauri-agent-tools eval "document.title"')).toBe(false);
    expect(citesScreenshotArtifact('ran a thorough eval transcript and it all looked right')).toBe(false);
    // ...and it must still accept the real thing, or the test would pass by over-refusing.
    expect(citesScreenshotArtifact('tauri-agent-tools check --pid 123 --eval "x" --json')).toBe(true);
  });

  it('does not teach the non-existent `capture --out` flag (it is -o/--output <dir>)', () => {
    // Verified against `tauri-agent-tools help capture`: `-o, --output <dir>`. `--out`
    // is the natural guess and silently wrong.
    expect(doc).not.toMatch(/tauri-agent-tools\s+capture[^\n]*--out\b(?!put)/);
  });
});

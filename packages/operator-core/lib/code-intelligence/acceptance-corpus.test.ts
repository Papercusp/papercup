/**
 * Fixture-staleness guard for the frozen code-intelligence acceptance corpus
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-002).
 *
 * A frozen corpus rots: files move, lines drift, symbols get renamed. A rotted
 * corpus is WORSE than no corpus, because it fails backends for its own
 * staleness and the failure looks exactly like a backend defect. This suite is
 * the recurrence guard for that whole class — it re-derives every pinned
 * fixture from the CURRENT tree and reports drift as a FIXTURE problem, in
 * language that tells the reader to re-measure and re-pin rather than to relax
 * the expectation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTANCE_CORPUS,
  CORPUS_BASELINE_COMMIT,
  EXCLUDED_ACCEPTANCE_SIGNALS,
  coveredPlanCases,
  corpusCase,
  type PinnedSite,
} from './acceptance-corpus.ts';
import {
  DEFAULT_RESOURCE_BUDGET,
  LINE_INDEX_BASE,
  isMutatingToolName,
  isTrustworthyEmpty,
  toOneIndexed,
  type CodeIntelAnswer,
} from './contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/operator-core/lib/code-intelligence → repo root */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function readLine(path: string, line1: number): string | null {
  const abs = join(REPO_ROOT, path);
  if (!existsSync(abs)) return null;
  const lines = readFileSync(abs, 'utf8').split('\n');
  // line1 is ONE-indexed by construction.
  return lines[line1 - 1] ?? null;
}

/**
 * The drift check, factored out so the real fixtures and the falsifiability
 * control below run the EXACT SAME code path. If the control tested a copy of
 * this logic it would prove nothing about the guard that actually runs.
 * Throws on stale/drifted; returns silently when the pin holds.
 */
function verifyPin(caseId: string, site: PinnedSite): void {
  const actual = readLine(site.path, site.line1);

  expect(
    actual,
    `FIXTURE STALE (not a backend failure): corpus case "${caseId}" pins ` +
      `${site.path}:${site.line1}, but that file/line no longer exists. ` +
      `Re-measure the symbol, update the pin, and re-pin CORPUS_BASELINE_COMMIT ` +
      `(currently ${CORPUS_BASELINE_COMMIT.slice(0, 10)}).`,
  ).not.toBeNull();

  expect(
    actual ?? '',
    `FIXTURE DRIFT (not a backend failure): corpus case "${caseId}" expects ` +
      `${site.path}:${site.line1} to contain "${site.symbolOnLine}", but that ` +
      `line now reads "${(actual ?? '').trim()}". The symbol moved. ` +
      `Re-measure and re-pin — do NOT relax this expectation to make it green.`,
  ).toContain(site.symbolOnLine);
}

describe('corpus instrument', () => {
  // POSITIVE CONTROL. Every "the fixture is missing" verdict below is produced
  // by readLine(). If readLine() is broken — wrong repo root, wrong indexing —
  // every fixture reads as missing and the whole suite fails for a reason that
  // has nothing to do with the fixtures. This control fails FIRST and says so.
  it('can resolve the repo root and read a known line (control)', () => {
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'CLAUDE.md'))).toBe(true);
    const known = readLine('packages/operator-core/lib/code-intelligence/contracts.ts', 1);
    expect(known, 'readLine() returned null for a file that certainly exists').not.toBeNull();
    expect(known).toContain('/**');
  });
});

describe('acceptance corpus fixtures still resolve at current HEAD', () => {
  const pinned: Array<{ caseId: string; site: PinnedSite }> = ACCEPTANCE_CORPUS.flatMap((c) =>
    c.expectedSites.map((site) => ({ caseId: c.id, site })),
  );

  it('has pinned fixtures to check (guards against a vacuous pass)', () => {
    // A corpus that accidentally became all-property cases would make every
    // per-fixture test below disappear and this file would pass having
    // verified nothing.
    expect(pinned.length).toBeGreaterThanOrEqual(8);
  });

  it.each(pinned)('$caseId → $site.path:$site.line1', ({ caseId, site }) => {
    verifyPin(caseId, site);
  });
});

describe('fixture guard falsifiability (permanent control)', () => {
  // A guard that has never failed is a guard nobody has tested. These controls
  // are deliberately-wrong pins kept PERMANENTLY in the test file — the
  // repo-sanctioned tier-1 pattern. They mutate nothing, so there is no
  // restore step to skip and no window for the git-sync sweep to commit a
  // mutant. If any control stops throwing, the guard above has gone blind and
  // every fixture is passing vacuously.

  it('CONTROL: a pin at a line that does not exist is caught as STALE', () => {
    expect(() =>
      verifyPin('control-line-past-eof', {
        path: 'packages/operator-core/lib/code-intelligence/contracts.ts',
        line1: 9_999_999,
        symbolOnLine: 'anything',
      }),
    ).toThrow(/FIXTURE STALE/);
  });

  it('CONTROL: a pin at a file that does not exist is caught as STALE', () => {
    expect(() =>
      verifyPin('control-missing-file', {
        path: 'packages/operator-core/lib/code-intelligence/no-such-file.ts',
        line1: 1,
        symbolOnLine: 'anything',
      }),
    ).toThrow(/FIXTURE STALE/);
  });

  it('CONTROL: a pin whose symbol moved off the line is caught as DRIFT', () => {
    // The real declaration of pinModuleState is at line 106. Pinning 105 — the
    // exact zero-indexed number GitNexus reports — must be caught. This control
    // doubles as a regression test for the off-by-one that motivated
    // toOneIndexed(): if someone "simplifies" the corpus by trusting raw
    // GitNexus line numbers, this fails.
    expect(() =>
      verifyPin('control-off-by-one', {
        path: 'libs/generic/module-singleton/src/index.ts',
        line1: 105,
        symbolOnLine: 'export function pinModuleState',
      }),
    ).toThrow(/FIXTURE DRIFT/);
  });

  it('CALIBRATION: the correct pin does NOT throw', () => {
    // Without this, all three controls above would still pass if verifyPin()
    // simply threw unconditionally — which would make the guard useless in the
    // opposite direction (every fixture red, for no reason).
    expect(() =>
      verifyPin('calibration', {
        path: 'libs/generic/module-singleton/src/index.ts',
        line1: 106,
        symbolOnLine: 'export function pinModuleState',
      }),
    ).not.toThrow();
  });
});

describe('corpus shape', () => {
  it('has unique case ids', () => {
    const ids = ACCEPTANCE_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the plan falsification cases it claims to', () => {
    const covered = coveredPlanCases();
    // The plan enumerates 14 cases; the corpus must reach into the high-numbered
    // property cases, not only the easy symbol-lookup ones.
    expect(covered).toContain(6);
    expect(covered).toContain(8);
    expect(covered).toContain(14);
    expect(Math.max(...covered)).toBeLessThanOrEqual(14);
  });

  it('every case names the defect it falsifies', () => {
    for (const c of ACCEPTANCE_CORPUS) {
      expect(c.falsifies.length, `case ${c.id} has no falsifies rationale`).toBeGreaterThan(40);
    }
  });

  it('exact-set cases carry ground truth; property cases do not', () => {
    for (const c of ACCEPTANCE_CORPUS) {
      if (c.gradeMode === 'property') {
        expect(c.expectedSites, `property case ${c.id} should not pin sites`).toHaveLength(0);
      } else {
        expect(
          c.expectedSites.length,
          `graded case ${c.id} must pin at least one site`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('records the measured GitNexus zero-index defect against the cases it affects', () => {
    // This is the finding P-002 exists to freeze. If someone "fixes" the corpus
    // by deleting the knownFailures, this test says why they must not.
    const shadow = corpusCase('shadowed-symbol-no-cross-contamination');
    expect(shadow?.knownFailures?.gitnexus).toMatch(/zero-indexed|285/);
    const def = corpusCase('definition-cross-package-bare-specifier');
    expect(def?.knownFailures?.gitnexus).toMatch(/105|zero-indexed/);
  });
});

describe('line-index normalization (the off-by-one contract)', () => {
  it('converts GitNexus zero-indexed lines to one-indexed', () => {
    // The three measured cases, verified 2026-08-21 against gitnexus 1.6.9.
    expect(toOneIndexed('gitnexus', 285)).toBe(286); // managedSetInterval
    expect(toOneIndexed('gitnexus', 105)).toBe(106); // pinModuleState
    expect(toOneIndexed('gitnexus', 39)).toBe(40); // vi.mock factory property
  });

  it('leaves one-indexed backends alone', () => {
    expect(toOneIndexed('ripgrep', 286)).toBe(286);
  });

  it('returns null for an absent line rather than inventing line 1', () => {
    // GitNexus's status:"found" shape omits `line`. Coercing that to 1 would
    // send an agent to the top of the file with full confidence.
    expect(toOneIndexed('gitnexus', undefined)).toBeNull();
    expect(toOneIndexed('gitnexus', null)).toBeNull();
    expect(toOneIndexed('gitnexus', Number.NaN)).toBeNull();
  });

  it('treats a nonsensical normalized line as absent', () => {
    expect(toOneIndexed('ripgrep', 0)).toBeNull();
    expect(toOneIndexed('ripgrep', -5)).toBeNull();
  });

  it('declares a base for every backend', () => {
    for (const [backend, base] of Object.entries(LINE_INDEX_BASE)) {
      expect([0, 1], `${backend} has an implausible index base`).toContain(base);
    }
  });
});

describe('false-empty detection (the disqualifying failure)', () => {
  const base: CodeIntelAnswer = {
    backend: 'gitnexus',
    intent: 'references',
    query: 'x',
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: 10,
    error: null,
  };

  it('accepts an empty answer from an affirmatively healthy backend', () => {
    expect(isTrustworthyEmpty(base)).toBe(true);
  });

  it('rejects a confident empty from an unhealthy backend', () => {
    const unhealthy = { ...base, freshness: { ...base.freshness, health: 'unhealthy' as const } };
    expect(isTrustworthyEmpty(unhealthy)).toBe(false);
  });

  it("rejects a confident empty when health is 'unknown'", () => {
    // 'unknown' is in-band and branchable — never read it as healthy.
    const unknown = { ...base, freshness: { ...base.freshness, health: 'unknown' as const } };
    expect(isTrustworthyEmpty(unknown)).toBe(false);
  });

  it('accepts a LOUD failure — an error is honest', () => {
    const failed = {
      ...base,
      freshness: { ...base.freshness, health: 'unhealthy' as const },
      error: 'child exited with SIGKILL',
    };
    expect(isTrustworthyEmpty(failed)).toBe(true);
  });

  it('accepts any non-empty answer', () => {
    const found = {
      ...base,
      freshness: { ...base.freshness, health: 'degraded' as const },
      sites: [{ path: 'a.ts', line1: 1, kind: 'function' }],
    };
    expect(isTrustworthyEmpty(found)).toBe(true);
  });
});

describe('read-only invariants', () => {
  it('flags mutating tool names', () => {
    expect(isMutatingToolName('applyEdit')).toBe(true);
    expect(isMutatingToolName('workspace_edit')).toBe(true);
    expect(isMutatingToolName('write_file')).toBe(true);
    expect(isMutatingToolName('deleteSymbol')).toBe(true);
    expect(isMutatingToolName('formatDocument')).toBe(true);
  });

  it('permits read tools', () => {
    expect(isMutatingToolName('query')).toBe(false);
    expect(isMutatingToolName('context')).toBe(false);
    expect(isMutatingToolName('impact')).toBe(false);
    expect(isMutatingToolName('route_map')).toBe(false);
  });

  it('permits allowlisted preview-only tools that carry a mutating name', () => {
    // GitNexus `rename` returns a plan, never writes. The allowlist entry is a
    // promise verified by the no-mutation corpus case, not by the name.
    expect(isMutatingToolName('rename')).toBe(false);
  });
});

describe('resource budgets', () => {
  it('names only runtime-observable resource metrics in acceptance case 13 (WI-2143024)', () => {
    const resourceCase = corpusCase('resource-budget-measured-from-runtime');
    expect(resourceCase?.title).toBe('Cold start, warm latency, RSS, child count, and index disk');
    expect(EXCLUDED_ACCEPTANCE_SIGNALS.map((signal) => signal.name)).toEqual([
      'tool failures',
      'packer selection',
      'downstream reads',
      'result tokens',
    ]);
    expect(EXCLUDED_ACCEPTANCE_SIGNALS.every((signal) => signal.reason.length > 40)).toBe(true);
  });

  it('bounds child processes so fleet load cannot multiply them', () => {
    expect(DEFAULT_RESOURCE_BUDGET.childProcMax).toBeLessThanOrEqual(2);
  });

  it('keeps a single tool result inside the agent result cap', () => {
    // Tool results are capped at ~1,500 tokens; a budget above that guarantees
    // truncation-by-transport, which is exactly the silent-cut failure mode.
    expect(DEFAULT_RESOURCE_BUDGET.resultTokensMax).toBeLessThanOrEqual(1_500);
  });
});

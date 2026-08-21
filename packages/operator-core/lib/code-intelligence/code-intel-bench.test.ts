/**
 * Unit tests for the P-010 bakeoff runner.
 *
 * These deliberately need NO language server. What they guard is the
 * measuring instrument itself: that a probe still points at the symbol it
 * claims, that grading can actually FAIL, and that the read-plane audit
 * catches a real backend's real disk-writing tools.
 *
 * The last one exists because the pre-existing mutation test asserted only
 * over INVENTED names (`applyEdit`, `write_file`, …) and therefore passed
 * while both of `mcp-language-server`'s disk-writing tools slipped through
 * undetected. A guard tested only against names you made up measures your
 * imagination, not your defence.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectRoot } from './lsp-adapter.ts';

import {
  BENCH_PROBES,
  CORPUS_GROUND_TRUTH_INTENTS,
  KNOWN_DIVERGENCES,
  MCP_LANGUAGE_SERVER_SERVED_INTENTS,
  MCP_LANGUAGE_SERVER_TOOL_SURFACE,
  auditToolSurface,
  classifyDivergence,
  gradeSites,
  median,
  resolveProbeCursor,
  type BenchMeasurement,
} from './code-intel-bench.ts';
import { corpusCase } from './acceptance-corpus.ts';
import { isMutatingToolName, type SymbolSite } from './contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const site = (path: string, line1: number | null): SymbolSite => ({
  path,
  line1,
  kind: null,
});

describe('bench probes point at real code', () => {
  it('every probe names a gradeable ground-truth corpus case', () => {
    for (const probe of BENCH_PROBES) {
      const kase = corpusCase(probe.caseId);
      expect(kase, `probe references unknown corpus case '${probe.caseId}'`).toBeDefined();
      // A property case has no site set to grade against, so a cursor probe
      // for one would produce a number that means nothing.
      expect(kase!.gradeMode, `probe '${probe.caseId}' is a property case`).not.toBe('property');
      expect(kase!.expectedSites.length).toBeGreaterThan(0);
    }
  });

  it('resolves each probe against the working tree, cursor inside the symbol', () => {
    for (const probe of BENCH_PROBES) {
      const cursor = resolveProbeCursor(probe, REPO_ROOT);
      const at = cursor.lineText.indexOf(probe.symbol);
      expect(at, `${probe.file}:${probe.line1} lost '${probe.symbol}'`).toBeGreaterThanOrEqual(0);
      // Strictly inside the token — a boundary cursor is ambiguous to some servers.
      expect(cursor.character).toBeGreaterThanOrEqual(at);
      expect(cursor.character).toBeLessThan(at + probe.symbol.length);
      expect(cursor.line1).toBe(probe.line1);
    }
  });

  it('THROWS on probe drift rather than scoring the backend wrong', () => {
    const drifted = { ...BENCH_PROBES[0], symbol: 'aSymbolThatIsNotOnThatLine' };
    expect(() => resolveProbeCursor(drifted, REPO_ROOT)).toThrow(/probe drift/);

    const offEnd = { ...BENCH_PROBES[0], line1: 10_000_000 };
    expect(() => resolveProbeCursor(offEnd, REPO_ROOT)).toThrow(/probe drift/);
  });
});

describe('grading can fail (falsifiability controls)', () => {
  const mustContain = corpusCase('definition-cross-package-bare-specifier')!;
  const exactSet = corpusCase('shadowed-symbol-no-cross-contamination')!;

  it('passes the true site set', () => {
    const truth = mustContain.expectedSites.map((s) => site(s.path, s.line1));
    expect(gradeSites(mustContain, truth).correct).toBe(true);
  });

  it('fails an empty answer', () => {
    const g = gradeSites(mustContain, []);
    expect(g.correct).toBe(false);
    expect(g.missing.length).toBeGreaterThan(0);
  });

  it('fails an off-by-one line — the whole point of the one-indexing guard', () => {
    const off = mustContain.expectedSites.map((s) => site(s.path, (s.line1 ?? 1) - 1));
    expect(gradeSites(mustContain, off).correct).toBe(false);
  });

  it('fails a right-line/wrong-file answer', () => {
    const wrong = mustContain.expectedSites.map((s) => site('some/other/file.ts', s.line1));
    expect(gradeSites(mustContain, wrong).correct).toBe(false);
  });

  it('must-contain TOLERATES an extra site; exact-set REJECTS it', () => {
    const withExtra = [
      ...mustContain.expectedSites.map((s) => site(s.path, s.line1)),
      site('libs/generic/other/src/index.ts', 12),
    ];
    expect(gradeSites(mustContain, withExtra).correct).toBe(true);

    const exactWithExtra = [
      ...exactSet.expectedSites.map((s) => site(s.path, s.line1)),
      // The shadowing vi.mock factory: returning it is the failure this case exists to catch.
      site('packages/operator-core/lib/predicate-watch.integration.test.ts', 40),
    ];
    const g = gradeSites(exactSet, exactWithExtra);
    expect(g.correct).toBe(false);
    expect(g.extra.length).toBe(1);
  });

  it('refuses to grade a property case rather than reporting a misleading pass', () => {
    const property = corpusCase('read-only-no-mutation');
    if (!property) return; // corpus renamed the case; the other guards still hold
    const g = gradeSites(property, []);
    expect(g.correct).toBe(false);
    expect(g.reason).toMatch(/property/);
  });
});

describe('project rooting — the false-empty class (P-010 defect 1)', () => {
  it('roots a Rust file at its own crate, NOT the repo root', () => {
    // MEASURED: this repo has no Cargo.toml at its root, so rooting
    // rust-analyzer there gave it no crate graph — it answered EMPTY for every
    // query while reporting itself healthy, and isTrustworthyEmpty blessed it.
    const rustFile = resolve(REPO_ROOT, 'papercusp-desktop/src-tauri/src/endpoint_ipc.rs');
    const { root, error } = resolveProjectRoot('rust', rustFile, REPO_ROOT);
    expect(error).toBeNull();
    expect(root).toBe(resolve(REPO_ROOT, 'papercusp-desktop/src-tauri'));
    expect(existsSync(join(root, 'Cargo.toml'))).toBe(true);
    // The precise regression: the repo root must NOT be chosen, and the reason
    // is checkable rather than asserted.
    expect(root).not.toBe(REPO_ROOT);
    expect(existsSync(join(REPO_ROOT, 'Cargo.toml'))).toBe(false);
  });

  it('REFUSES rather than returning a false-empty when no crate root exists', () => {
    // A .rs file with no Cargo.toml above it: the honest answer is a loud
    // error, because a healthy-looking empty reads as "nothing implements it".
    const orphan = resolve(REPO_ROOT, 'libs/generic/search/src/not-a-real-crate.rs');
    const { error } = resolveProjectRoot('rust', orphan, REPO_ROOT);
    expect(error).toMatch(/no Cargo\.toml/);
    expect(error).toMatch(/false-empty|EMPTY/);
  });

  it('leaves TypeScript rooted at the monorepo root, which is correct for it', () => {
    const tsFile = resolve(REPO_ROOT, 'libs/generic/search/src/leg-health.ts');
    const { root, error } = resolveProjectRoot('typescript', tsFile, REPO_ROOT);
    expect(error).toBeNull();
    expect(root).toBe(REPO_ROOT);
  });

  it('every Rust bench probe resolves to a real crate root', () => {
    for (const probe of BENCH_PROBES.filter((p) => p.file.endsWith('.rs'))) {
      const { root, error } = resolveProjectRoot(
        'rust',
        resolve(REPO_ROOT, probe.file),
        REPO_ROOT,
      );
      expect(error, `${probe.caseId} has no crate root`).toBeNull();
      expect(existsSync(join(root, 'Cargo.toml'))).toBe(true);
    }
  });
});

describe('read-plane audit of the mcp-language-server comparator', () => {
  const audit = auditToolSurface(
    MCP_LANGUAGE_SERVER_TOOL_SURFACE,
    MCP_LANGUAGE_SERVER_SERVED_INTENTS,
  );

  it('finds the two tools that write to disk', () => {
    expect(audit.mutatingTools).toEqual(['edit_file', 'rename_symbol']);
    expect(audit.readPlaneSafe).toBe(false);
  });

  it('REGRESSION: our name guard flags every one of them', () => {
    // This is the assertion that fails if the FORBIDDEN_MUTATING_TOOL_PATTERNS
    // widening is reverted. Before it, both slipped through silently.
    expect(audit.mutatingButUnflagged).toEqual([]);
    expect(isMutatingToolName('edit_file')).toBe(true);
    expect(isMutatingToolName('rename_symbol')).toBe(true);
  });

  it('CONTROL: the pre-fix pattern set really did miss both', () => {
    // A deliberately-wrong implementation kept permanently beside the real one,
    // so the assertion above is provably discriminating rather than vacuous.
    // (The repo's mutation-probe discipline for an imported MODULE — no tree
    // mutation, so no sweep race and no restore to forget.)
    const PRE_FIX_PATTERNS = [
      /^rename$/i,
      /^apply[_-]?edit$/i,
      /^workspace[_-]?edit$/i,
      /write/i,
      /delete/i,
      /^format/i,
      /^fix/i,
    ];
    const preFixFlags = (n: string): boolean => PRE_FIX_PATTERNS.some((re) => re.test(n));

    // The bug, reproduced: both disk-writers waved through.
    expect(preFixFlags('edit_file')).toBe(false);
    expect(preFixFlags('rename_symbol')).toBe(false);

    // Calibration — the old set was not simply broken, so a test that merely
    // asserts "the old thing fails" would pass even if the property itself
    // were meaningless. These it always caught, and so must the new set.
    for (const n of ['applyEdit', 'workspace_edit', 'write_file', 'formatDocument']) {
      expect(preFixFlags(n), `control miscalibrated on ${n}`).toBe(true);
      expect(isMutatingToolName(n)).toBe(true);
    }
  });

  it('keeps the read-only tools — and our own facade ops — unflagged', () => {
    for (const t of MCP_LANGUAGE_SERVER_TOOL_SURFACE.filter((t) => !t.writesToDisk)) {
      expect(isMutatingToolName(t.name), `${t.name} wrongly flagged`).toBe(false);
    }
    for (const op of [
      'symbol',
      'references',
      'implementations',
      'diagnostics',
      'workspace_symbols',
      'refactor_preview',
      'health',
      'query',
      'context',
      'impact',
      'route_map',
      'rename', // gitnexus preview — allowlisted, verified by the no-mutation case
    ]) {
      expect(isMutatingToolName(op), `${op} wrongly flagged`).toBe(false);
    }
  });

  it('cannot express the implementations intent the Rust case needs', () => {
    expect(CORPUS_GROUND_TRUTH_INTENTS).toContain('implementations');
    expect(audit.unservableIntents).toContain('implementations');
  });

  it('records the disk-write mechanism, not merely the name', () => {
    for (const t of MCP_LANGUAGE_SERVER_TOOL_SURFACE.filter((t) => t.writesToDisk)) {
      expect(t.evidence).toMatch(/ApplyWorkspaceEdit/);
    }
  });
});

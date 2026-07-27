/**
 * build:typecheck — registration + the two pure helpers behind its refusal path
 * (plan `bash-to-tool-substitution-2026-07-26`, P-024).
 *
 * The compile itself is covered by live verification against the real compiler
 * (a spawn per case would make this suite minutes long for no extra signal);
 * what is asserted here is everything that decides WHETHER a compile happens and
 * what the caller is told when it does not — which is where this tool's whole
 * correctness argument lives.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../index';
import { lookupByMcpName } from '@papercusp/tooldef';
import buildTypecheck, { resolveProjectPath, suggestProjects } from './typecheck';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  MCP_TRANSPORT_CAP_MS,
  clampForegroundTimeoutMs,
} from '../capability/inspect';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('registration', () => {
  it('is reachable through the projection registry (the index import is not optional)', () => {
    // A tool file that exists but is never imported from agent-tools/index.ts is
    // invisible to every surface — the failure is silent and looks like a
    // missing tool at dispatch time, hours later.
    expect(lookupByMcpName('build:typecheck'), 'build:typecheck missing from the registry').toBeTruthy();
  });

  it('declares the argument surface the substitution audit models', () => {
    expect(Object.keys((buildTypecheck as unknown as { args: { shape: Record<string, unknown> } }).args.shape).sort())
      .toEqual(['files', 'incremental', 'maxErrors', 'project', 'timeoutMs']);
  });
});

describe('resolveProjectPath — tsc\'s own project resolution', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-resolve-'));
    mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
    writeFileSync(join(root, 'packages', 'alpha', 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'packages', 'alpha', 'tsconfig.build.json'), '{}');
    mkdirSync(join(root, 'packages', 'beta'), { recursive: true });
    // beta deliberately has NO tsconfig.json.
    writeFileSync(join(root, 'tsconfig.base.json'), '{}');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('resolves a DIRECTORY to its tsconfig.json', () => {
    expect(resolveProjectPath(root, 'packages/alpha')).toBe(join(root, 'packages', 'alpha', 'tsconfig.json'));
  });

  it('resolves an explicit config FILE to itself (tsconfig.build.json is a real operand in the corpus)', () => {
    expect(resolveProjectPath(root, 'packages/alpha/tsconfig.build.json')).toBe(join(root, 'packages', 'alpha', 'tsconfig.build.json'));
  });

  it('resolves an ABSOLUTE path', () => {
    expect(resolveProjectPath(root, join(root, 'packages/alpha'))).toBe(join(root, 'packages', 'alpha', 'tsconfig.json'));
  });

  it('returns null for a directory with no tsconfig — NOT a silent zero-file check', () => {
    expect(resolveProjectPath(root, 'packages/beta')).toBeNull();
  });

  it('returns null for `.` and `tsconfig.json` at a root that has only tsconfig.base.json', () => {
    // This is the exact live behaviour that motivates the tool: TS5057 / TS5058,
    // zero files checked, and the two most common operands in the whole corpus.
    expect(resolveProjectPath(root, '.')).toBeNull();
    expect(resolveProjectPath(root, 'tsconfig.json')).toBeNull();
  });

  it('returns null for a path that does not exist at all', () => {
    expect(resolveProjectPath(root, 'packages/does-not-exist')).toBeNull();
  });
});

describe('suggestProjects — a refusal has to be actionable', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'p024-suggest-'));
    // packages/ alone holds more than the cap, which is what broke the first
    // implementation: it filled all 12 slots before reaching apps/ or libs/.
    for (let i = 0; i < 20; i += 1) {
      mkdirSync(join(root, 'packages', `pkg${String(i).padStart(2, '0')}`), { recursive: true });
      writeFileSync(join(root, 'packages', `pkg${String(i).padStart(2, '0')}`, 'tsconfig.json'), '{}');
    }
    mkdirSync(join(root, 'apps', 'operator'), { recursive: true });
    writeFileSync(join(root, 'apps', 'operator', 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'libs', 'flags'), { recursive: true });
    writeFileSync(join(root, 'libs', 'flags', 'tsconfig.json'), '{}');
    // A directory with no tsconfig must never be suggested.
    mkdirSync(join(root, 'apps', 'no-config'), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('INTERLEAVES the buckets so a crowded packages/ cannot crowd out apps/ and libs/', () => {
    // Live verification caught the opposite: 12 suggestions, every one from
    // packages/, handed to an agent who meant apps/operator-vite.
    const suggestions = suggestProjects(root);
    expect(suggestions.some((s) => s.startsWith('apps/')), `no apps/ suggestion in: ${suggestions.join(', ')}`).toBe(true);
    expect(suggestions.some((s) => s.startsWith('libs/')), `no libs/ suggestion in: ${suggestions.join(', ')}`).toBe(true);
    expect(suggestions.some((s) => s.startsWith('packages/'))).toBe(true);
  });

  it('caps the list so a refusal stays readable', () => {
    expect(suggestProjects(root).length).toBeLessThanOrEqual(12);
  });

  it('suggests only directories that really contain a tsconfig.json', () => {
    expect(suggestProjects(root)).not.toContain('apps/no-config/tsconfig.json');
    for (const s of suggestProjects(root)) expect(s.endsWith('tsconfig.json')).toBe(true);
  });

  it('returns an empty list rather than throwing when no bucket exists', () => {
    const bare = mkdtempSync(join(tmpdir(), 'p024-bare-'));
    try {
      expect(suggestProjects(bare)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * EI-18776865728050036 — the CLASS guard, not a per-tool patch.
 *
 * A tool dispatched FOREGROUND over the papercusp-su MCP transport gets ~55s (EI-6073). A tool
 * that declares a longer budget cannot honour it: the transport kills the call first and the
 * agent sees `MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432` — an error naming the
 * DATABASE, which sends them off debugging PG. Measured: build:typecheck on packages/operator-core
 * (104.4s) failed 3/3 while libs/flags (2.1s) passed on the identical path.
 *
 * This has now happened THREE times — capability:inspect (EI-6073, fixed), then build:typecheck
 * and testing:run (both found together and fixed here) — so a per-tool fix demonstrably does not
 * stop the next one. These assertions fail if a foreground subprocess tool stops clamping.
 */
describe('EI-18776865728050036 — no FOREGROUND subprocess tool may declare a budget the transport cannot honour', () => {
  // Tools that spawn a child process and return its result INLINE. Add a row here when you add
  // another; that is the point of the list.
  const FOREGROUND_SUBPROCESS_TOOLS = ['build/typecheck.ts', 'testing/run.ts'];

  it('the shared foreground ceiling sits below the transport cap', () => {
    expect(FOREGROUND_TIMEOUT_CEILING_MS).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  it('clamping a budget far above the cap still lands below it', () => {
    // 900_000 is MAX_TIMEOUT_MS on both tools — the worst case a caller can ask for.
    expect(clampForegroundTimeoutMs(900_000)).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  it.each(FOREGROUND_SUBPROCESS_TOOLS)(
    '%s routes its foreground budget through clampForegroundTimeoutMs',
    (rel) => {
      const src = readFileSync(join(__dirname, '..', rel), 'utf8');
      expect(src, `${rel} must import the shared clamp rather than re-declaring the ceiling`)
        .toMatch(/clampForegroundTimeoutMs/);
      // The teeth: the un-clamped form is what shipped and what a revert would restore.
      expect(src, `${rel} passes its raw default straight to the spawn — the transport will kill it`)
        .not.toMatch(/timeoutMs\s*=\s*args\.timeoutMs\s*\?\?\s*DEFAULT_TIMEOUT_MS\s*;/);
    },
  );

  it.each(FOREGROUND_SUBPROCESS_TOOLS)(
    '%s hands back an actionable next step on timeout, not a bare error',
    (rel) => {
      const src = readFileSync(join(__dirname, '..', rel), 'utf8');
      // A timeout that names no escape route is how an agent ends up hand-rolling `npx tsc -p .`
      // — which checks ZERO files here and reads as clean.
      expect(src, `${rel} timeout branch must point at the detached run`).toMatch(
        /run_in_background/,
      );
    },
  );
});

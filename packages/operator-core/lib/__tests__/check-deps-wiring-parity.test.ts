/**
 * WI-1728261 — the two-entrypoint seam-drift trap.
 *
 * Pins the FOURTH live instance (`ScoutCycleDeps.hiveRunnerGate`, wired in the
 * `blender:cycle` blueprint op since 2026-06-19 and never present in the
 * `system:scout-cycle` routine action) as a regression fixture: the guard must flag the
 * pre-fix shape and stay silent on the post-fix shape.
 *
 * FALSIFIABILITY (repo rule: a guard that has never failed is a guard you have not
 * tested). The subject here is an imported MODULE, so the tier-1 method applies —
 * a deliberately-wrong detector lives PERMANENTLY in this file as a control, and the
 * same assertions that pass against the real detector must FAIL against it. No
 * production file is ever mutated to prove this, which is what keeps the git-sync
 * sweep from committing a mutant.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the executable .mjs guard intentionally has no declaration file.
import * as wiringParity from '../../../../scripts/check-deps-wiring-parity.mjs';
import * as ts from 'typescript';

const { buildSeamConsumptionIndex, findWiringParityGaps, objectLiteralPropertyNames } = wiringParity;

/**
 * The shared orchestrator's deps interface, in the shape the real one takes — plus the
 * CONSUMER that names it. WI-1745363: a literal is attributed to an interface only via
 * an anchor (a type annotation, or the declared parameter type of the callee it is
 * passed to), never by its shape, so a fixture without a consumer is not a deps site at
 * all. This mirrors the real Scout pair, where both entry points hand their literal to
 * `buildScoutCycleDeps(...)`.
 */
const DEPS_IFACE = `
  export interface CycleDeps {
    runCycle: CycleRunner;
    potGate?: (i: { workspaceId: string }) => Promise<{ enabled: boolean }>;
    ceilingGate?: typeof realCeilingGate;
    hiveRunnerGate?: (i: { workspaceId: string }) => Promise<{ run: boolean }>;
  }
  export function startCycle(deps: CycleDeps) { return deps; }
`;

/** The entry point that wires everything (the blueprint op's role). */
const FULLY_WIRED = `
  const deps: CycleDeps = {
    runCycle: productionRunner,
    potGate: realPotGate,
    ceilingGate: realCeilingGate,
    hiveRunnerGate: ({ workspaceId }) => checkHiveSingleRunner(workspaceId),
  };
`;

/** The entry point that threads seams through params (the routine action's role). */
const THREADED_MISSING_ONE = `
  startCycle({
    runCycle,
    ...(potGate ? { potGate } : {}),
    ...(ceilingGate ? { ceilingGate } : {}),
  });
`;

const THREADED_COMPLETE = `
  startCycle({
    runCycle,
    ...(potGate ? { potGate } : {}),
    ...(ceilingGate ? { ceilingGate } : {}),
    ...(hiveRunnerGate ? { hiveRunnerGate } : {}),
  });
`;

const sources = (...files: string[]) =>
  files.map((text, i) => ({ fileName: i === 0 ? 'run.ts' : `entry-${i}.ts`, text }));

describe('findWiringParityGaps', () => {
  it('flags a seam wired at one production site and omitted at another (the WI-1728261 shape)', () => {
    const findings = findWiringParityGaps(sources(DEPS_IFACE, FULLY_WIRED, THREADED_MISSING_ONE));
    expect(findings).toHaveLength(1);
    expect(findings[0].interface).toBe('CycleDeps');
    expect(findings[0].file).toBe('entry-2.ts');
    expect(findings[0].missing).toEqual(['hiveRunnerGate']);
    // and it names WHERE the seam is wired, so the reader can diff the two sites
    expect(findings[0].wiredElsewhereAt.hiveRunnerGate).toBe('entry-1.ts:2');
  });

  it('is SILENT once the omitted seam is threaded — the post-fix shape', () => {
    expect(findWiringParityGaps(sources(DEPS_IFACE, FULLY_WIRED, THREADED_COMPLETE))).toHaveLength(0);
  });

  /**
   * THE LOAD-BEARING CASE. A factory that threads seams through parameters builds its
   * deps with `...(x ? { x } : {})`. A detector blind to that idiom sees the threaded
   * site as wiring NOTHING, and reports every seam as missing — turning the guard into
   * noise that gets switched off. The wrong-implementation control below is exactly
   * this blindness.
   */
  it('sees through the conditional-spread idiom a seam-threading factory uses', () => {
    const names = objectLiteralPropertyNames(firstObjectLiteral(THREADED_COMPLETE));
    expect([...names].sort()).toEqual(['ceilingGate', 'hiveRunnerGate', 'potGate', 'runCycle']);
  });

  it('also understands the `...(x && { x })` spread form', () => {
    const names = objectLiteralPropertyNames(firstObjectLiteral(`const d = { runCycle, ...(potGate && { potGate }) };`));
    expect([...names].sort()).toEqual(['potGate', 'runCycle']);
  });

  it('refuses to guess through an OPAQUE spread rather than inventing a finding', () => {
    // `...base` could contribute any keys; claiming the shape is known would produce
    // findings about seams that may in fact be wired.
    expect(objectLiteralPropertyNames(firstObjectLiteral(`const d = { runCycle, ...base };`))).toBeNull();
  });

  it('does not flag a single construction site — one site cannot diverge from itself', () => {
    expect(findWiringParityGaps(sources(DEPS_IFACE, THREADED_MISSING_ONE))).toHaveLength(0);
  });

  it('ignores on<Event> OBSERVER callbacks by default, and reports them under --include-observers', () => {
    const iface = `
      export interface WatchDeps {
        run: Runner;
        loadRoster?: (i: { id: string }) => Promise<string[]>;
        gate?: typeof realGate;
        onProgress?: (p: number) => void;
      }
      export function watch(d: WatchDeps) { return d; }
    `;
    const a = `watch({ run: r, loadRoster: lr, gate: g, onProgress: (p) => log(p) });`;
    const b = `watch({ run: r, loadRoster: lr, gate: g });`;
    // An optional observer left unwired is the INTENDED semantics of a callback.
    expect(findWiringParityGaps(sources(iface, a, b))).toHaveLength(0);
    // ...but the wider population stays measurable, so the narrowing is a stated bound.
    const wide = findWiringParityGaps(sources(iface, a, b), { includeObservers: true });
    expect(wide).toHaveLength(1);
    expect(wide[0].missing).toEqual(['onProgress']);
  });

  it('classifies differently named observers by consumption, while retaining gate semantics', () => {
    const iface = `
      export interface EngineCtx {
        run: Runner;
        metadata?: (data: Record<string, unknown>) => void;
        progress?: (pct: number, msg: string) => void;
        gate?: typeof realGate;
      }
      export function runEngine(ctx: EngineCtx) {
        ctx.metadata?.({});
        ctx.progress?.(10, 'searching');
        if (ctx.gate) return realGate();
        return null;
      }
    `;
    const full = `runEngine({ run, metadata, progress, gate });`;
    const partial = `runEngine({ run, metadata });`;
    const fixtureSources = sources(iface, full, partial);

    // Consumption, not the member name, excludes the progress notifier while
    // preserving a conditionally-consumed gate.
    const consumption = buildSeamConsumptionIndex(fixtureSources);
    expect(consumption.get('EngineCtx|progress')).toEqual({ observer: true, gate: false });
    expect(consumption.get('EngineCtx|gate')).toEqual({ observer: false, gate: true });
    const findings = findWiringParityGaps(fixtureSources);
    expect(findings).toHaveLength(1);
    expect(findings[0].missing).toEqual(['gate']);

    // The wider diagnostic population still exposes observers on request,
    // aggregated with the gate omission at the same partial site.
    const wide = findWiringParityGaps(fixtureSources, { includeObservers: true });
    expect(wide).toHaveLength(1);
    expect(wide[0].missing).toEqual(['gate', 'progress']);
  });

  it('ignores an option-bag with fewer than two injectable seams', () => {
    const iface = `
      export interface Opts {
        id: string;
        label?: string;
        retries?: number;
        hook?: (x: number) => void;
      }
      export function build(o: Opts) { return o; }
    `;
    const a = `build({ id: 'a', label: 'x', hook: (n) => n });`;
    const b = `build({ id: 'b', label: 'y' });`;
    expect(findWiringParityGaps(sources(iface, a, b))).toHaveLength(0);
  });

  it('drops an UNANCHORED literal rather than attributing it by shape', () => {
    // Nothing in the syntax says this bare literal is a CycleDeps. Before WI-1745363 it
    // was attributed anyway, because its keys happened to fit.
    const bare = `const partial = { runCycle, potGate: realPotGate, ceilingGate: realCeilingGate };`;
    expect(findWiringParityGaps(sources(DEPS_IFACE, FULLY_WIRED, bare))).toHaveLength(0);
  });

  it('does not attribute a narrow helper argument to a WIDE all-optional interface (WI-1745363)', () => {
    // The measured git-sync shape: RunGitSyncOpts declares repoPath/runGit/log/readText/
    // writeText/loadRoster and has ZERO required members, so it was a structural magnet —
    // every `{ runGit, repoPath, log }` helper arg in the package was reported as a
    // diverging RunGitSyncOpts construction against the tree's ONE real one. A guard on a
    // --fail path must not invent that: a false positive reds the whole fleet.
    const iface = `
      export interface WideOpts {
        repoPath?: string;
        runGit?: RunGit;
        log?: (m: string) => void;
        readText?: (p: string) => Promise<string | null>;
        writeText?: (p: string, t: string) => Promise<void>;
        loadRoster?: () => Promise<string[]>;
      }
      export function runWide(slug: string, opts: WideOpts) { return opts; }
      export function detectDeletions(o: DeletionOpts) { return o; }
      export function regenerate(o: DeletionOpts) { return o; }
    `;
    const real = `runWide('s', { runGit, repoPath, log, loadRoster: () => roster() });`;
    const helperA = `detectDeletions({ runGit, repoPath, log });`;
    const helperB = `regenerate({ runGit, repoPath, log });`;
    expect(findWiringParityGaps(sources(iface, real, helperA, helperB))).toHaveLength(0);
  });
});

/**
 * ── PERMANENT NEGATIVE CONTROL ────────────────────────────────────────────────
 * A deliberately-wrong detector that collects property names but does NOT see through
 * conditional spreads — the single most plausible way to get this guard subtly wrong.
 * It stays here forever: if the assertions above ever stop being sensitive to that
 * property, THIS block starts passing and says so.
 */
function naiveObjectLiteralPropertyNames(objLiteral: ts.ObjectLiteralExpression): Set<string> {
  const names = new Set<string>();
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name && ts.isIdentifier(prop.name)) names.add(prop.name.text);
    }
    // ...and silently drops every SpreadAssignment — the bug being controlled for.
  }
  return names;
}

describe('negative control — a detector blind to conditional spreads', () => {
  it('reports the fully-threaded site as wiring almost nothing, which the real one does not', () => {
    const naive = naiveObjectLiteralPropertyNames(firstObjectLiteral(THREADED_COMPLETE));
    // The wrong implementation sees only the shorthand `runCycle`...
    expect([...naive]).toEqual(['runCycle']);
    // ...while the real one recovers all four. Same input, opposite verdicts: the
    // assertion in 'sees through the conditional-spread idiom' is genuinely falsifiable.
    const real = objectLiteralPropertyNames(firstObjectLiteral(THREADED_COMPLETE));
    expect(real.size).toBe(4);
    expect(real.size).toBeGreaterThan(naive.size);
  });

  /**
   * CALIBRATION. Without this, the control above would also "pass" if the real detector
   * were broken in some third way — it only compares the two. This pins that the real
   * detector gets the substantive answer RIGHT, not merely different.
   */
  it('calibration: the real detector agrees with the naive one where no spread is involved', () => {
    const plain = `const d = { runCycle: r, potGate: p };`;
    const real = objectLiteralPropertyNames(firstObjectLiteral(plain));
    const naive = naiveObjectLiteralPropertyNames(firstObjectLiteral(plain));
    expect([...real].sort()).toEqual([...naive].sort());
    expect([...real].sort()).toEqual(['potGate', 'runCycle']);
  });
});

/** First object literal in a snippet — the fixtures each contain exactly one. */
function firstObjectLiteral(src: string): ts.ObjectLiteralExpression {
  const sf = ts.createSourceFile('fixture.ts', src, ts.ScriptTarget.Latest, true);
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isObjectLiteralExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error('fixture contains no object literal');
  return found;
}

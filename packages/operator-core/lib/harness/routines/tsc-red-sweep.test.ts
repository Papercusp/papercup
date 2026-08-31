/**
 * tsc-red-sweep.test.ts — EI-19342686127995790, unit 2 (the sweeper).
 *
 * WHAT IS ACTUALLY AT RISK HERE. The dwell DECISION is already covered by
 * `__tests__/tsc-red-observations.test.ts` (it is pure, and lives in the .mjs). What this
 * file protects is the part that can only fail in production: the sweep either files
 * NOTHING when it should (re-creating the silent-log problem it exists to close) or files
 * REPEATEDLY for one red (the backlog noise that would train agents to ignore the lane).
 *
 * NOTE ON CONTROLS. Most assertions below are negatives — "capture was not called" — and a
 * negative passes just as happily against a sweep that files nothing at all, or one that
 * threw before reaching the call. So every rejection case is PAIRED with a positive that
 * differs in exactly ONE dimension: same fixture, one seam flipped. A file-nothing
 * implementation fails the paired positive; a file-everything one fails the rejection.
 * Neither can pass this file.
 */
import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  tscRedSweep,
  buildRedCapture,
  ownershipTestLines,
  readDeclaredSubmodulePaths,
  debounceKeyFor,
  MAX_FILES_PER_TICK,
  DEBOUNCE_HOURS,
  type DwelledRed,
  type TscRedSweepDeps,
} from './tsc-red-sweep';

/** Repo root, resolved from this file rather than cwd (which differs per vitest project). */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const NOW = 1_800_000_000_000;
const nowSec = Math.floor(NOW / 1000);

function red(over: Partial<DwelledRed> = {}): DwelledRed {
  return {
    file: 'packages/operator-core/lib/some-new-file.ts',
    firstSeen: nowSec - 3600,
    lastSeen: nowSec - 60,
    sightings: 9,
    spanSec: 3540,
    latestCount: 3,
    ...over,
  };
}

/**
 * All seams stubbed to the "would file" configuration; each test flips exactly one.
 *
 * The return is deliberately NOT cast to `never`/`any`. An escape hatch there types every
 * `d.captureFn` access as `never`, which compiles locally and then lands 18 type errors on
 * the shared gate — and worse, it would let a seam RENAME pass this file silently while the
 * sweep quietly fell back to its real implementation. The single cast below is confined to
 * reconciling the mock signatures with the real ones.
 */
function deps(over: Partial<TscRedSweepDeps> = {}) {
  const base = {
    nowMs: NOW,
    captureFn: vi.fn(async (_input: unknown) => ({ id: 'EI-1' })),
    claimFireFn: vi.fn(async (_opts: unknown) => true),
    recentFiresFn: vi.fn(async (_ws: string, _slug: string, _h?: number, _s?: unknown) => 0),
    pruneObservationsFn: vi.fn(() => ({ ok: true, kept: 0 })),
    readObservationsFn: vi.fn(() => [{ ts: nowSec - 60, file: 'x', count: 1, project: '' }]),
    selectDwelledRedsFn: vi.fn((): DwelledRed[] => [red()]),
    workspaceIdFn: () => 'ws-test',
    // The fixtures here are synthetic paths that do not exist on disk, and the sweep's filing
    // precondition (EI-21985631427355996) rightly refuses to file for a path absent from the
    // tree. Stubbing existence TRUE keeps every case below testing what it was written to test
    // — debounce, cap, capture shape — instead of silently collapsing into that one guard.
    // The guard has its own paired controls in `the filing precondition` describe below.
    fileExistsFn: vi.fn((_f: string) => true),
  };
  const merged = { ...base, ...over };
  return merged as typeof base & TscRedSweepDeps;
}

describe('buildRedCapture', () => {
  it('names the file, the dwell in minutes and the error count in the title', () => {
    const c = buildRedCapture(red({ spanSec: 3600, latestCount: 4 }));
    expect(c.title).toContain('packages/operator-core/lib/some-new-file.ts');
    expect(c.title).toContain('60min');
    expect(c.title).toContain('4 errors');
  });

  it('reports an unknown error count as "unknown" rather than "null"', () => {
    // The store records `count: null` when the gate could not parse one. Rendering that
    // as the string "null" reads as a real value and is how a diagnostic quietly lies.
    expect(buildRedCapture(red({ latestCount: null })).title).toContain('unknown errors');
    // CONTROL: the same field populated must NOT say unknown.
    expect(buildRedCapture(red({ latestCount: 2 })).title).not.toContain('unknown');
  });

  it('derives evidenceAt from lastSeen, not from now', () => {
    // evidenceAt gates capture-core's stale-evidence check: a resolved duplicate re-files
    // only when the evidence POST-DATES the resolution. Stamping `now` would make every
    // filing look maximally fresh and defeat that guard entirely.
    const c = buildRedCapture(red({ lastSeen: nowSec - 600 }));
    expect(c.evidenceAt).toBe(new Date((nowSec - 600) * 1000).toISOString());
    expect(c.evidenceAt).not.toBe(new Date(NOW).toISOString());
  });

  it('keys dedup on the path so two different files never collide', () => {
    const a = buildRedCapture(red({ file: 'a/one.ts' }));
    const b = buildRedCapture(red({ file: 'b/two.ts' }));
    expect(a.watchdogKey).toBe(debounceKeyFor('a/one.ts'));
    expect(a.watchdogKey).not.toBe(b.watchdogKey);
    // Same path => same key across ticks, which is what makes the debounce work at all.
    expect(buildRedCapture(red({ file: 'a/one.ts', sightings: 99 })).watchdogKey).toBe(a.watchdogKey);
  });

  it('carries the path in paths[] for the protected-path gate', () => {
    expect(buildRedCapture(red({ file: 'a/one.ts' })).paths).toEqual(['a/one.ts']);
  });

  it('tells the reader to re-run the ownership test before claiming', () => {
    // The measured base rate is self-healing, so a filed red may already be fixed by the
    // time a human or agent reads it. A filing that does not say so invites wasted work.
    const body = buildRedCapture(red()).body;
    expect(body).toContain('git status --porcelain');
    expect(body).toContain('lint:tsc');
  });
});

/**
 * EI-19468589610261889 — the ownership test must be spelled for the repo that actually holds
 * the file.
 *
 * WHY THIS IS A REAL GUARD AND NOT A WORDING TEST. Measured live 2026-08-31 against the
 * superproject root: for `libs/generic/tooldef/src/standard-schema.ts` (a real entry in the
 * live tsc baseline) `git status --porcelain | grep <f>` and `git log -1 --format=%cI -- <f>`
 * BOTH print nothing, while the same questions asked inside the submodule report the file was
 * committed 2026-08-30T20:03:00Z. A non-submodule control answers correctly from the root.
 *
 * Both empties read as "nobody is on it", so the old spelling failed toward CLAIMING a file a
 * peer holds — the precise collision the test exists to prevent. The direction is the
 * severity, which is why the assertions below pin the `-C` form rather than merely asserting
 * "some git command is mentioned".
 */
describe('buildRedCapture — ownership test is spelled for the owning repo', () => {
  const SUBS = ['libs/generic/tooldef', 'libs/papercusp', 'libs/generic/sync'];

  it('asks the SUBMODULE, not the superproject, for a file inside one', () => {
    const body = buildRedCapture(
      red({ file: 'libs/generic/tooldef/src/standard-schema.ts' }),
      SUBS,
    ).body;
    expect(body).toContain('git -C libs/generic/tooldef status --porcelain src/standard-schema.ts');
    expect(body).toContain(
      'git -C libs/generic/tooldef log -1 --format=%cI -- src/standard-schema.ts',
    );
    // The false-empty superproject spelling must be GONE, not merely supplemented — leaving it
    // beside the correct one still invites the empty answer that reads as reassurance.
    expect(body).not.toContain(
      'git status --porcelain | grep libs/generic/tooldef/src/standard-schema.ts',
    );
    expect(body).not.toContain(
      'git log -1 --format=%cI -- libs/generic/tooldef/src/standard-schema.ts',
    );
  });

  it('says WHY, so a reader who runs the old command does not trust its empty output', () => {
    const body = buildRedCapture(red({ file: 'libs/papercusp/packages/orchestrator/src/x.ts' }), SUBS)
      .body;
    expect(body).toContain("inside submodule 'libs/papercusp'");
    expect(body).toMatch(/return EMPTY/);
  });

  it('leaves a superproject path exactly as it was', () => {
    const body = buildRedCapture(red({ file: 'packages/operator-core/lib/x.ts' }), SUBS).body;
    expect(body).toContain('git status --porcelain | grep packages/operator-core/lib/x.ts');
    expect(body).toContain('git log -1 --format=%cI -- packages/operator-core/lib/x.ts');
    expect(body).not.toContain('git -C');
  });

  it('keeps the superproject spelling when the mount list is empty (fail-soft default)', () => {
    // Discovery failing must degrade to today's behaviour, never to a half-rewritten command.
    const body = buildRedCapture(red({ file: 'libs/generic/tooldef/src/standard-schema.ts' })).body;
    expect(body).toContain('git status --porcelain | grep libs/generic/tooldef/src/standard-schema.ts');
    expect(body).not.toContain('git -C');
  });

  it('does NOT rewrite the lint:tsc line — the gate auto-routes a submodule path', () => {
    // Measured live 2026-08-31: `lint:tsc --files=libs/generic/tooldef/src/standard-schema.ts`
    // returns status=routed exit=0 (routed to the owning workspace's sibling gate), NOT a
    // refusal. Rewriting it would break a command that already works.
    const body = buildRedCapture(
      red({ file: 'libs/generic/tooldef/src/standard-schema.ts' }),
      SUBS,
    ).body;
    expect(body).toContain('npm run lint:tsc -- --files=libs/generic/tooldef/src/standard-schema.ts');
  });

  it('picks the LONGEST matching mount when one submodule nests inside another', () => {
    const nested = ['libs/generic', 'libs/generic/tooldef'];
    expect(ownershipTestLines('libs/generic/tooldef/src/a.ts', nested).join('\n')).toContain(
      'git -C libs/generic/tooldef status --porcelain src/a.ts',
    );
  });

  it('treats a path EQUAL to a gitlink as not inside it', () => {
    // Such a path already resolves in the superproject (it IS the gitlink entry), so it needs
    // no attribution — rewriting it would point at a repo where the path does not exist.
    expect(ownershipTestLines('libs/generic/tooldef', ['libs/generic/tooldef']).join('\n')).not.toContain(
      'git -C',
    );
  });
});

describe('readDeclaredSubmodulePaths', () => {
  it('fails soft to [] when .gitmodules is absent, so the sweep never throws', () => {
    expect(readDeclaredSubmodulePaths('/nonexistent-root-for-tsc-red-sweep-test')).toEqual([]);
  });

  it('reads the real repository .gitmodules and finds the mounts this fix depends on', () => {
    const found = readDeclaredSubmodulePaths(REPO_ROOT);
    // Calibration: if this ever returns [] the guard above would pass vacuously.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('libs/generic/tooldef');
  });
});

describe('tscRedSweep — files a dwelled red', () => {
  it('files exactly one improvement for a dwelled red', async () => {
    const d = deps();
    const out = await tscRedSweep(d);
    expect(d.captureFn).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('filed');
  });

  it('files it as a major bug, unassigned, with open-scoped dedup', async () => {
    const d = deps();
    await tscRedSweep(d);
    const arg = d.captureFn.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.kind).toBe('bug');
    // A committed non-baselined red reds the SHARED gate — it blocks everyone, not just
    // the author. Downgrading this to 'minor' is how it gets ignored.
    expect(arg.severity).toBe('major');
    // The premise of the filing is that the red is OWNERLESS; auto-claiming would put a
    // machine's name on work no machine is doing.
    expect(arg.assignee).toBeUndefined();
    // A RESOLVED duplicate means the red came back — a regression worth re-filing.
    expect(arg.dedupScope).toBe('open');
    expect(arg.watchdogKey).toBe(debounceKeyFor(red().file));
  });

  it('does not file when nothing has dwelled — and does not even look up the workspace', async () => {
    const workspaceIdFn = vi.fn(() => 'ws-test');
    const d = deps({ selectDwelledRedsFn: () => [], workspaceIdFn });
    const out = await tscRedSweep(d);
    expect(out).toEqual([]);
    expect(d.captureFn).not.toHaveBeenCalled();
    expect(workspaceIdFn).not.toHaveBeenCalled();
    // CONTROL: the identical sweep WITH a dwelled red does file, so the negative above
    // cannot be satisfied by a sweep that is simply broken.
    const d2 = deps();
    await tscRedSweep(d2);
    expect(d2.captureFn).toHaveBeenCalledTimes(1);
  });
});

describe('tscRedSweep — debounce', () => {
  it('does NOT re-file a red already filed inside the window', async () => {
    const d = deps({ recentFiresFn: vi.fn(async () => 1) });
    const out = await tscRedSweep(d);
    expect(d.captureFn).not.toHaveBeenCalled();
    expect(out[0].outcome).toBe('debounced');
    // CONTROL: same fixture, prior-fire count back to 0 => it files.
    const d2 = deps({ recentFiresFn: vi.fn(async () => 0) });
    await tscRedSweep(d2);
    expect(d2.captureFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT file when the single-flight claim is lost to a racing tick', async () => {
    // Two overlapping ticks both pass the recentFires read; only the one that wins the
    // atomic claim may file. Without this, a slow capture duplicates the item.
    const d = deps({ claimFireFn: vi.fn(async () => false) });
    const out = await tscRedSweep(d);
    expect(d.captureFn).not.toHaveBeenCalled();
    expect(out[0].reason).toContain('raced');
    // CONTROL: winning the claim files.
    const d2 = deps({ claimFireFn: vi.fn(async () => true) });
    await tscRedSweep(d2);
    expect(d2.captureFn).toHaveBeenCalledTimes(1);
  });

  it('claims the debounce slot with the path embedded verbatim in the reason', async () => {
    // claimWatchdogFire matches its scope key with `reason LIKE '%key%'`, so a reason that
    // omits the key silently debounces ALL paths against each other — one red would then
    // suppress every other red for 24h.
    const d = deps();
    await tscRedSweep(d);
    const claim = d.claimFireFn.mock.calls[0][0] as Record<string, unknown>;
    expect(claim.reason).toContain(red().file);
    expect(claim.source).toBe('tsc-new-file-red');
    expect(claim.windowHours).toBe(DEBOUNCE_HOURS);
  });

  it('scopes the debounce per path, so one red does not suppress another', async () => {
    const seen: string[] = [];
    const d = deps({
      selectDwelledRedsFn: () => [red({ file: 'a/one.ts' }), red({ file: 'b/two.ts' })],
      recentFiresFn: vi.fn(async (_ws: string, installSlug: string) => {
        seen.push(installSlug);
        return 0;
      }),
    });
    await tscRedSweep(d);
    expect(seen).toEqual([debounceKeyFor('a/one.ts'), debounceKeyFor('b/two.ts')]);
    expect(d.captureFn).toHaveBeenCalledTimes(2);
  });
});

describe('tscRedSweep — blast radius', () => {
  it('caps how many it files in one tick, taking the longest-standing first', async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      red({ file: `f${i}.ts`, spanSec: 7000 - i * 100 }),
    );
    const d = deps({ selectDwelledRedsFn: () => many, maxFiles: 2 });
    const out = await tscRedSweep(d);
    expect(d.captureFn).toHaveBeenCalledTimes(2);
    expect((d.captureFn.mock.calls[0][0] as Record<string, unknown>).title).toContain('f0.ts');
    expect(out.filter((r) => r.outcome === 'capped')).toHaveLength(5);
    // CONTROL: the identical fixture with the cap raised files all 7, so the assertion
    // above is measuring the CAP and not some unrelated failure to file.
    const d2 = deps({ selectDwelledRedsFn: () => many, maxFiles: 7 });
    await tscRedSweep(d2);
    expect(d2.captureFn).toHaveBeenCalledTimes(7);
  });

  it('defaults the cap to MAX_FILES_PER_TICK', async () => {
    const many = Array.from({ length: MAX_FILES_PER_TICK + 3 }, (_, i) => red({ file: `f${i}.ts` }));
    const d = deps({ selectDwelledRedsFn: () => many });
    await tscRedSweep(d);
    expect(d.captureFn).toHaveBeenCalledTimes(MAX_FILES_PER_TICK);
  });
});

describe('tscRedSweep — fail-soft', () => {
  it('never throws when the store cannot be read, and still prunes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const d = deps({
      readObservationsFn: () => {
        throw new Error('EACCES');
      },
    });
    await expect(tscRedSweep(d)).resolves.toEqual([]);
    expect(d.captureFn).not.toHaveBeenCalled();
    // The swallow must still be OBSERVABLE — a fail-soft path that logs nothing is
    // indistinguishable from a sweep that silently stopped running.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EACCES');
    // Retention still runs: the store is bounded even on a tick that read nothing.
    expect(d.pruneObservationsFn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('records a per-file error and keeps going rather than abandoning the tick', async () => {
    // One unfileable red must not blind the sweep to the others — that would make the
    // sweep's coverage depend on alphabetical luck.
    const captureFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: 'EI-2' });
    const d = deps({
      selectDwelledRedsFn: () => [red({ file: 'a/one.ts' }), red({ file: 'b/two.ts' })],
      captureFn,
    });
    const out = await tscRedSweep(d);
    expect(out[0].outcome).toBe('error');
    expect(out[0].reason).toContain('db down');
    expect(out[1].outcome).toBe('filed');
  });

  it('prunes even on a tick where filing failed', async () => {
    // Retention is what BOUNDS the store; skipping the prune on the error path turns a
    // transient DB outage into an unbounded file in the runtime dir.
    const d = deps({
      captureFn: vi.fn().mockRejectedValue(new Error('db down')),
    });
    await tscRedSweep(d);
    expect(d.pruneObservationsFn).toHaveBeenCalledTimes(1);
  });

  it('prunes on the happy path too', async () => {
    const d = deps();
    await tscRedSweep(d);
    expect(d.pruneObservationsFn).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing prune mask a successful filing', async () => {
    const d = deps({
      pruneObservationsFn: vi.fn(() => {
        throw new Error('read-only fs');
      }),
    });
    const out = await tscRedSweep(d);
    expect(out[0].outcome).toBe('filed');
  });
});

/**
 * THE FILING PRECONDITION — EI-21985631427355996.
 *
 * tsc cannot report an error for a file that is not in the tree, so a dwelled path that does
 * not exist here is not a red this tree can have: it is an observation of some OTHER tree
 * that reached the process-global store. Filing it manufactures a work-item nobody can act
 * on, and — because `decideTscRedCleared` deliberately refuses to resolve on a vanished file
 * ("ambiguous: deleted or renamed") — one that can never auto-close either.
 *
 * Measured 2026-08-31: `lib/old-peer.ts`, a fixture path written by `lint-tsc.test.ts` into a
 * `mkdtempSync` root, was observed 10 times across 172 minutes and filed as a major bug.
 *
 * CONTROLS. `fileExistsFn` is the ONLY dimension separating the two cases below, so an
 * implementation that files nothing fails the positive and one that files everything fails
 * the negative. The cap case pins the ORDERING claim specifically — that a phantom is removed
 * before MAX_FILES_PER_TICK is applied — which a guard placed inside the loop would fail.
 */
describe('the filing precondition — a path absent from the tree is not fileable', () => {
  it('skips a dwelled red whose file is not in the tree, and files nothing for it', async () => {
    const d = deps({
      selectDwelledRedsFn: () => [red({ file: 'lib/old-peer.ts' })],
      fileExistsFn: () => false,
    });
    const out = await tscRedSweep(d);
    expect(d.captureFn).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 'lib/old-peer.ts', outcome: 'skipped' });
    expect(out[0].reason).toContain('absent from this tree');
  });

  it('files the SAME red when the file does exist — the paired positive', async () => {
    const d = deps({
      selectDwelledRedsFn: () => [red({ file: 'lib/old-peer.ts' })],
      fileExistsFn: () => true,
    });
    const out = await tscRedSweep(d);
    expect(d.captureFn).toHaveBeenCalledTimes(1);
    expect(out[0].outcome).toBe('filed');
  });

  it('never lets a phantom consume a cap slot that a real red needed', async () => {
    // Two phantoms sort ahead of the real red by dwell. With maxFiles=1 and the guard placed
    // AFTER the cap, both would be 'capped'/'skipped' and `real.ts` would be deferred another
    // tick — the exact starvation that let a fixture path crowd out live reds for hours.
    const d = deps({
      maxFiles: 1,
      selectDwelledRedsFn: () => [
        red({ file: 'lib/phantom-a.ts', spanSec: 9000 }),
        red({ file: 'lib/phantom-b.ts', spanSec: 8000 }),
        red({ file: 'lib/real.ts', spanSec: 3600 }),
      ],
      fileExistsFn: (f: string) => f === 'lib/real.ts',
    });
    const out = await tscRedSweep(d);
    expect(d.captureFn).toHaveBeenCalledTimes(1);
    expect((d.captureFn.mock.calls[0][0] as Record<string, unknown>).title).toContain('lib/real.ts');
    expect(out.filter((r) => r.outcome === 'skipped').map((r) => r.file)).toEqual([
      'lib/phantom-a.ts',
      'lib/phantom-b.ts',
    ]);
    expect(out.some((r) => r.outcome === 'capped')).toBe(false);
  });

  it('scopes its observation read to repoRoot, so a foreign-root record cannot reach the sweep', async () => {
    const readObservationsFn = vi.fn(() => [{ ts: nowSec - 60, file: 'x', count: 1, project: '' }]);
    const d = deps({ readObservationsFn, repoRoot: '/repo' });
    await tscRedSweep(d);
    expect(readObservationsFn).toHaveBeenCalledWith(expect.objectContaining({ root: '/repo' }));
  });
});

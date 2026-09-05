/**
 * `stampDeclaredDeps` — the WRITE half of the freshness axis (EI-19470389781357111).
 *
 * ## Why these particular cases
 *
 * This logic was inline in `work-item-checkpoint.ts` until the loop carry-note needed
 * the same contract. Every invariant here fails SILENTLY when it breaks — a wrong
 * stamp produces a stored payload that looks exactly like a right one, and the damage
 * shows up later as a freshness verdict that is confidently wrong. So each case is
 * paired with a CONTROL: `stampNaively`, a deliberately-wrong implementation kept
 * permanently in this file, which the same assertion must CATCH. That is what makes
 * these tests falsifiable without mutating the shared tree (CLAUDE.md's mutation-probe
 * rule: a guard that has never failed is a guard you have not tested).
 *
 * Uses `file:` deps throughout: that resolver is filesystem-only, so the whole write
 * contract is exercised with no database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECLARED_DEPS_VERSION, type DeclaredDeps } from './index';

const h = vi.hoisted(() => ({
  loadHarnessRegistry: vi.fn(),
}));

vi.mock('../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness-registry')>();
  return { ...actual, loadHarnessRegistry: h.loadHarnessRegistry };
});

const { stampDeclaredDeps } = await import('./stamp');
const { resolveCurrentTokens } = await import('./resolvers');

let root: string | undefined;
const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;

/** A repo-shaped temp root the `file:` resolver will accept. */
async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'freshness-stamp-root-'));
  await mkdir(join(root, 'apps', 'operator'), { recursive: true });
  await mkdir(join(root, 'libs', 'papercusp'), { recursive: true });
  await writeFile(join(root, 'apps', 'operator', 'package.json'), '{}');
  await writeFile(join(root, 'libs', 'papercusp', 'package.json'), '{}');
  process.env.PAPERCUSP_INTEGRATION_ROOT = root;
  return root;
}

async function writeDep(name: string, body: string): Promise<string> {
  await writeFile(join(root!, name), body);
  return `file:${name}`;
}

afterEach(async () => {
  h.loadHarnessRegistry.mockReset();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
});

const CTX = { workspaceId: 'papercusp-workspace', harness: 'papercusp' as string | null };

/**
 * THE CONTROL — a deliberately-wrong stamper, kept permanently.
 *
 * It makes exactly the two mistakes the real implementation is written to avoid:
 * it stamps an unresolvable dep (with a placeholder token) instead of dropping it,
 * and it preserves the prior declaration when nothing new could be stamped. Both
 * are the natural, obvious implementations — which is precisely why they need a
 * standing counterexample rather than a comment.
 */
async function stampNaively(input: {
  declared: readonly string[];
  priorDeps: DeclaredDeps | null;
}): Promise<{ payload: DeclaredDeps | null }> {
  const tokens = await resolveCurrentTokens([...input.declared], CTX);
  const stamps = input.declared.map((dep) => ({ dep, token: tokens.get(dep) ?? 'unresolved', at: Date.now() }));
  if (stamps.length === 0) return { payload: input.priorDeps };
  return { payload: { v: DECLARED_DEPS_VERSION, stamps } };
}

describe('stampDeclaredDeps', () => {
  it('CALIBRATION: stamps a resolvable dep with a real content token', async () => {
    await makeRoot();
    const dep = await writeDep('real.txt', 'hello');

    const out = await stampDeclaredDeps({ declared: [dep], priorDeps: null, ...CTX });

    // If this fails, the instrument itself is broken and every other case below is
    // meaningless — a stamper that stamps nothing trivially "passes" the drop tests.
    expect(out.payload?.stamps).toHaveLength(1);
    expect(out.payload?.stamps[0]?.dep).toBe(dep);
    expect(out.payload?.stamps[0]?.token).toMatch(/^sha256:/);
    expect(out.warnings).toEqual([]);
  });

  it('DROPS an unresolvable dep instead of stamping it, and says why', async () => {
    await makeRoot();
    const good = await writeDep('present.txt', 'x');
    const missing = 'file:definitely-absent.txt';

    const out = await stampDeclaredDeps({ declared: [good, missing], priorDeps: null, ...CTX });

    // Stamping an unresolvable dep would make it read as CHANGED the moment it first
    // resolves — a manufactured false stale, permanently baked into the stored note.
    expect(out.payload?.stamps.map((s) => s.dep)).toEqual([good]);
    expect(out.warnings.join(' ')).toContain('definitely-absent.txt');

    // CONTROL: the obvious implementation stamps it anyway. The assertion above must
    // catch that; if this ever passes, the assertion has stopped discriminating.
    const naive = await stampNaively({ declared: [good, missing], priorDeps: null });
    expect(naive.payload?.stamps.map((s) => s.dep)).toContain(missing);
  });

  it('CLEARS rather than preserving prior stamps when nothing is stampable', async () => {
    await makeRoot();
    const prior: DeclaredDeps = {
      v: DECLARED_DEPS_VERSION,
      stamps: [{ dep: 'file:old.txt', token: 'sha256:deadbeef', at: 1 }],
    };

    const out = await stampDeclaredDeps({ declared: ['file:nope.txt'], priorDeps: prior, ...CTX });

    // Preserving `prior` here would judge THIS note by the PREVIOUS note's dependency
    // set — a note whose own declaration wholly failed would read `fresh`. `null` means
    // `undeclared`, which routes readers to the age heuristics: an honest "we don't
    // know" instead of a confident wrong answer.
    expect(out.payload).toBeNull();
    expect(out.recomputed).toBe(false);
    expect(out.warnings).not.toEqual([]);

    // CONTROL: preserving the prior declaration is the natural thing to write.
    const naive = await stampNaively({ declared: [], priorDeps: prior });
    expect(naive.payload).toBe(prior);
  });

  it('treats an explicit [] as a clear WITHOUT reading the prior deps', async () => {
    await makeRoot();
    const priorDeps = vi.fn(async () => null);

    const out = await stampDeclaredDeps({ declared: [], priorDeps, ...CTX });

    expect(out.payload).toBeNull();
    // The thunk exists so a clear costs no database round-trip on a write path. A
    // plain eager value would still be CORRECT here, so only this call-count assertion
    // can tell the two apart.
    expect(priorDeps).not.toHaveBeenCalled();
  });

  it('marks `recomputed` when the note being replaced was ALREADY stale', async () => {
    await makeRoot();
    const dep = await writeDep('moving.txt', 'v1');
    const first = await stampDeclaredDeps({ declared: [dep], priorDeps: null, ...CTX });
    expect(first.recomputed).toBe(false);

    // A peer edits the dependency, then this note is rewritten against the new world.
    await writeFile(join(root!, 'moving.txt'), 'v2');
    const second = await stampDeclaredDeps({ declared: [dep], priorDeps: first.payload, ...CTX });

    // `recomputed` is not derivable at READ time — it must be stamped here or the
    // warning is lost forever: the note is currently valid, but was rewritten after
    // its world moved, so its narrative may only be partially updated.
    expect(second.recomputed).toBe(true);
    expect(second.payload?.recomputed).toBe(true);
    expect(second.payload?.stamps[0]?.token).not.toBe(first.payload?.stamps[0]?.token);
  });

  it('decides `recomputed` against the UNION when the dep set itself changed', async () => {
    await makeRoot();
    const dropped = await writeDep('dropped.txt', 'v1');
    const kept = await writeDep('kept.txt', 'stable');
    const first = await stampDeclaredDeps({ declared: [dropped, kept], priorDeps: null, ...CTX });

    // The dep that moved is the one the new declaration no longer mentions. Resolving
    // only the NEW set would miss it and under-report `recomputed` — the prior note's
    // verdict has to be computed against the union of old and new.
    await writeFile(join(root!, 'dropped.txt'), 'v2');
    const second = await stampDeclaredDeps({ declared: [kept], priorDeps: first.payload, ...CTX });

    expect(second.recomputed).toBe(true);
    expect(second.payload?.stamps.map((s) => s.dep)).toEqual([kept]);
  });

  it('normalizes a bare work-item id so the edge is recorded, not silently dropped', async () => {
    await makeRoot();
    // Agents routinely pass `WI-123` instead of the typed `work-item:WI-123`. The
    // normalization has to happen before validation or the dep is rejected as
    // malformed and the note stores no edge at all.
    const out = await stampDeclaredDeps({ declared: ['WI-6198'], priorDeps: null, ...CTX });

    // No database here, so it cannot RESOLVE — but it must have been understood as a
    // work-item ref (reported unresolvable) rather than rejected as an invalid tag.
    expect(out.warnings.join(' ')).toContain('work-item:WI-6198');
  });
});

/**
 * unresolved-refs-writer-census.test.ts — the recurrence guard for EI-19908952124502298.
 *
 * ## What this guards, and why the helper's own tests cannot
 *
 * `unresolved-refs.ts` is thoroughly unit-tested: 27 cases pin what it reports,
 * what it stays silent about, and the fact that it never accuses on a store
 * fault. Every one of those tests calls the helper DIRECTLY. So all of them keep
 * passing if a writer stops calling it — the behaviour is correct and simply
 * never runs. That is exactly how the gap this item names came to exist: the
 * advisory shipped on comment/complete/update and was never extended to the two
 * remaining prose writers, with nothing failing to say so.
 *
 * A phantom `EI-####`/`WI-####` ref is indistinguishable from a real one to
 * every later reader, and it lands in the surfaces successors trust WITHOUT
 * re-checking. The checkpoint writer is the worst case: a cold successor's
 * entire inherited state is that note.
 *
 * ## Why an ADVISORY and not the proposed blocking hook
 *
 * The original proposal was a PreToolUse hook that REJECTS a write citing an
 * unresolvable ref. It was deliberately not built, and this guard encodes the
 * advisory contract instead:
 *
 *  - A PreToolUse hook sits on ONE client's edit path. ptool, MCP and the HTTP
 *    API write straight past it, so the guarantee would be false wherever it
 *    was most trusted.
 *  - Ref resolution here is workspace-scoped and fail-soft. A federated ref, or
 *    one from another harness, does not resolve locally and is not phantom —
 *    blocking would refuse legitimate writes, and `unresolvedRefsWarning` says
 *    "does not resolve in this workspace" precisely because that is the only
 *    claim the resolution supports.
 *
 * ## The predicate: a CALL, not a mention
 *
 * Awareness is not wiring. A file that imports the helper, or names it in a
 * comment explaining why it is absent, is NOT wired — matching on vocabulary
 * would let a removed call pass on its own leftover import. The census asserts
 * both halves of the contract: the writer CALLS the probe, and it EXPOSES the
 * result so a caller can actually see it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The probe actually being invoked — `(` is what separates a call from an import. */
export const HELPER_CALL = /unresolvedRefsInBody\s*\(/;

/** The advisory reaching the caller, as a result key. */
export const RESULT_KEY = /unresolvedRefsWarning:/;

/**
 * Exposed so the guard's teeth are provable against SYNTHETIC sources — never by
 * briefly mutating a file in a tree the whole fleet shares (git-sync sweeps every
 * few minutes and would commit the mutant even though nothing went wrong).
 */
export function wiresUnresolvedRefsAdvisory(src: string): boolean {
  return HELPER_CALL.test(src) && RESULT_KEY.test(src);
}

/**
 * Every surface that stores agent-authored PROSE under a work-item-shaped id and
 * hands a result back to the writer. Each entry names what a phantom ref costs
 * there — an entry is a claim about consequence, not a checklist tick.
 */
const REQUIRED_WRITERS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: join(here, 'comment.ts'),
    why: 'a comment is the durable hand-off surface a fresh spawn reads off the item',
  },
  {
    file: join(here, 'complete.ts'),
    why: 'completion evidence is what a leader audits; a phantom ref there survives as settled record',
  },
  {
    file: join(here, 'update.ts'),
    why: 'title/body edits rewrite the item every later reader resolves against',
  },
  {
    file: join(here, 'checkpoint.ts'),
    why: 'EI-19908952124502298: a cold successor inherits the checkpoint as its whole state, unchecked',
  },
  {
    file: resolve(here, '../improvements/capture.ts'),
    why: 'EI-19908952124502298: a capture enters the knowledge substrate and is mined by later triage',
  },
];

describe('unresolved-ref advisory — writer census (EI-19908952124502298)', () => {
  for (const { file, why } of REQUIRED_WRITERS) {
    it(`wires the advisory: ${file.split('/').slice(-2).join('/')} — ${why}`, () => {
      const src = readFileSync(file, 'utf8');
      expect(HELPER_CALL.test(src), `${file} must CALL unresolvedRefsInBody(...), not merely import it`).toBe(true);
      expect(RESULT_KEY.test(src), `${file} must expose an unresolvedRefsWarning result key`).toBe(true);
    });
  }

  it('covers both surfaces this item added, not only the three that already had it', () => {
    const added = REQUIRED_WRITERS.filter((w) => /checkpoint\.ts$|capture\.ts$/.test(w.file));
    expect(added).toHaveLength(2);
    for (const { file } of added) {
      expect(wiresUnresolvedRefsAdvisory(readFileSync(file, 'utf8'))).toBe(true);
    }
  });
});

describe('the predicate is falsifiable', () => {
  it('rejects a writer that only IMPORTS the helper — a removed call must not pass on its leftover import', () => {
    const importOnly = `
      import { unresolvedRefsInBody, unresolvedRefsWarning } from './unresolved-refs';
      export async function handler() { return { ok: true }; }
    `;
    expect(wiresUnresolvedRefsAdvisory(importOnly)).toBe(false);
  });

  it('rejects a writer that only MENTIONS the helper in prose explaining its absence', () => {
    const mentionOnly = `
      // We deliberately do not call unresolvedRefsInBody here: this surface stores
      // no agent prose, so unresolvedRefsWarning would have nothing to report.
      export async function handler() { return { ok: true }; }
    `;
    expect(wiresUnresolvedRefsAdvisory(mentionOnly)).toBe(false);
  });

  it('rejects a writer that probes but SWALLOWS the result — the advisory must reach the caller', () => {
    const probedButDropped = `
      import { unresolvedRefsInBody } from './unresolved-refs';
      export async function handler(body: string, id: string) {
        await unresolvedRefsInBody(body, { known: [id] });
        return { ok: true };
      }
    `;
    expect(wiresUnresolvedRefsAdvisory(probedButDropped)).toBe(false);
  });

  it('accepts a writer that both probes and returns the advisory', () => {
    const wired = `
      import { unresolvedRefsInBody, unresolvedRefsWarning } from './unresolved-refs';
      export async function handler(body: string, id: string) {
        const unresolved = await unresolvedRefsInBody(body, { known: [id] });
        const warning = unresolved ? unresolvedRefsWarning(id, unresolved.missing) : undefined;
        return { ok: true, ...(warning ? { unresolvedRefsWarning: warning } : {}) };
      }
    `;
    expect(wiresUnresolvedRefsAdvisory(wired)).toBe(true);
  });
});

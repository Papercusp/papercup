/**
 * The per-turn journal must find psu-launched transcripts, not only the ones
 * a client writes to its shared home.
 *
 * Plan: omp-context-injection-and-behavior-2026-08-12, P-004.
 *
 * MEASURED FAILURE: `journal:record-turn` was called 286 times in one OMP
 * session and wrote ZERO rows. Over the surrounding 40h,
 * `harness_shared.session_turn_journal` held 906 rows across 416 sessions —
 * every one `source_kind='claude'`, not a single `omp` row ever.
 *
 * THE PLAN'S HYPOTHESIS WAS WRONG, and it is worth recording why, because the
 * wrong fix was cheap to reach for. The suspicion was the
 * `(session_id, COALESCE(turn_ts, 'epoch'))` unique index collapsing every
 * write into one row for a client that sends no `turn_ts`. Two facts killed
 * it: that hypothesis predicts ONE row per session, and we measured ZERO; and
 * of the 906 rows in the window, `turn_ts IS NULL` on none of them. Nothing
 * was ever colliding.
 *
 * The real cause is upstream of the INSERT: `resolveTranscriptPath` could not
 * find the transcript at all, so the tool returned
 * `{ ok: false, reason: 'transcript_not_found' }` and never reached the store.
 * A psu-launched OMP agent gets a PER-SESSION omp home under
 * `~/.papercusp/su-omp-homes/session-<adv>/agent/sessions/<munged-cwd>/` and
 * never writes to `~/.omp`, which was the only root the adapter declared.
 *
 * That is the SAME missing root as P-005 (EI-20212281439039808), reached
 * through a different door: `turn-journal.ts` imports `FILE_ADAPTERS` from
 * `search/session-ingest.ts`, so both the search index and the journal read
 * one roots declaration. That coupling is what these tests pin. It is
 * implicit — nothing in either file names the other as a dependency — so the
 * next person to touch the roots array has no local signal that the journal
 * rides on it. The behavioural assertions below fail if it is broken again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTranscriptPath } from './turn-journal';
import { FILE_ADAPTERS } from './search/session-ingest';

/** The real shape of a psu OMP rollout, verified against a live path:
 *  <root>/session-<adv>/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl */
const PSU_OMP_DEPTH = 4;
const SESSION_UUID = '019ff24e-f2fd-7000-a2ff-36c02fc83c32';

describe('journal transcript resolution reaches psu isolation homes', () => {
  let root: string;
  let rollout: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'psu-omp-root-')));
    const dir = join(
      root,
      'session-14830',
      'agent',
      'sessions',
      '-papercupai-workspace-papercusp',
    );
    await fs.mkdir(dir, { recursive: true });
    rollout = join(dir, `2026-08-11T19-31-28-125Z_${SESSION_UUID}.jsonl`);
    await fs.writeFile(rollout, '{"type":"message"}\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds a rollout nested at the psu depth', async () => {
    const found = await resolveTranscriptPath('omp', SESSION_UUID, undefined, [
      { root, dirDepth: PSU_OMP_DEPTH },
    ]);
    expect(found).toBe(rollout);
  });

  it('CONTROL: the shared-home depth does NOT find it — so the root/depth is the differentiator', async () => {
    // ~/.omp/agent/sessions/<munged-cwd>/<file> is depth 1. If a depth-1 walk
    // also found the file, the assertion above would pass for the wrong
    // reason and this suite would not be evidence of anything.
    const found = await resolveTranscriptPath('omp', SESSION_UUID, undefined, [
      { root, dirDepth: 1 },
    ]);
    expect(found).toBeNull();
  });

  it('the omp adapter DECLARES the psu root, so the journal inherits it in production', () => {
    // The two tests above prove the resolver CAN walk a psu-shaped tree; this
    // proves the journal is actually pointed at one. Both halves are needed —
    // the bug was a correct walker aimed at the wrong roots.
    const omp = FILE_ADAPTERS.find((a) => a.sourceKind === 'omp');
    expect(omp, 'the omp adapter must exist').toBeTruthy();
    const psuRoots = omp!
      .roots()
      .filter((r) => r.root.includes('.papercusp') && r.root.includes('su-omp-homes'));
    expect(
      psuRoots,
      'omp must declare its psu isolation home, or every psu OMP session journals nothing',
    ).toHaveLength(1);
    // Pinned to the measured path shape rather than a magic number: a layout
    // move should fail loudly here instead of silently resolving nothing.
    expect(psuRoots[0]!.dirDepth).toBe(PSU_OMP_DEPTH);
  });

  it('every client with a psu isolation home declares it — no client may silently drop out', () => {
    // The parity statement. claude and codex already carried psu roots while
    // omp did not, and nothing failed; the asymmetry is exactly what hid this
    // for as long as it lasted.
    for (const kind of ['claude', 'omp', 'codex'] as const) {
      const adapter = FILE_ADAPTERS.find((a) => a.sourceKind === kind);
      expect(adapter, `${kind} adapter must exist`).toBeTruthy();
      const hasPsuRoot = adapter!.roots().some((r) => r.root.includes('.papercusp'));
      expect(
        hasPsuRoot,
        `${kind} must declare a psu isolation root — without one, every psu-launched ` +
          `${kind} session is invisible to BOTH the search index and the turn journal`,
      ).toBe(true);
    }
  });
});

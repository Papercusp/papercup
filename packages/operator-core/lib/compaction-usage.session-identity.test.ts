/**
 * WI-10001513 — identity-keyed transcript anchors.
 *
 * `:3070` runs a 16-worker `node:cluster`, and each worker holds its OWN in-process
 * anchor Map. A carry-respawn's invalidation (`clearContextAnchor`) fires from ONE
 * HTTP POST, so it reaches exactly one worker; the other 15 keep an anchor pointing at
 * the dead predecessor's transcript. Because a dead transcript STOPS GROWING,
 * `advanceAnchor` reads "size unchanged ⇒ ok" and those workers serve the frozen
 * pre-respawn token count — so the gauge is not lagging, it is a per-call lottery, which
 * is why agents observed non-monotonic readings between consecutive calls.
 *
 * The fix keys the anchor to the native session id its path belongs to, and that id
 * already rides on every tool call. These tests fix BOTH halves of the safety property:
 * a worker that cannot prove its anchor is live renders NOTHING (never a stale number),
 * and a worker that receives a mismatching id drops the dead anchor immediately.
 *
 * The session ids below are the real pair measured off `agent_activity` for a single
 * ownerId across one respawn boundary (predecessor last row 21:09:33Z, successor first
 * row 21:09:34Z, 2026-09-15) — the concrete instance this work item was filed from.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, findSessionTranscriptMock, newestTranscriptUnderOwnerMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  findSessionTranscriptMock: vi.fn(),
  newestTranscriptUnderOwnerMock: vi.fn(() => null as string | null),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('./claude-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claude-sessions')>();
  return {
    ...actual,
    findSessionTranscript: findSessionTranscriptMock,
    newestTranscriptUnderOwner: newestTranscriptUnderOwnerMock,
  };
});

import {
  anchorSessionIdFromPath,
  currentContextTokensSyncForOwner,
  noteLiveNativeSession,
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
} from './compaction-usage';

const PATH_REVERIFY_MS = 30_000; // mirrors the private constant in compaction-usage.ts

/** The real measured respawn pair (see file header). */
const PREDECESSOR_SID = 'a4f3f938-61b9-45c1-8e2e-f6da45d777f5';
const SUCCESSOR_SID = '9ed43f5c-9c98-40e1-9d43-1f6339d2bae3';

let dir: string;
let predecessorFile: string;
let successorFile: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ agent: 'claude', session_id: SUCCESSOR_SID }]);
  findSessionTranscriptMock.mockResolvedValue(null);
  newestTranscriptUnderOwnerMock.mockReturnValue(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-identity-test-'));
  predecessorFile = path.join(dir, `${PREDECESSOR_SID}.jsonl`);
  successorFile = path.join(dir, `${SUCCESSOR_SID}.jsonl`);
});

afterEach(() => {
  resetContextAnchorsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

/** A complete JSONL line of exactly `bytes` bytes (ASCII only). */
function line(bytes: number, fill = 'x'): string {
  const overhead = '{"t":""}\n'.length;
  return `{"t":"${fill.repeat(bytes - overhead)}"}\n`;
}

describe('anchorSessionIdFromPath — identity DERIVED from the path, never carried beside it', () => {
  it('reads a claude transcript basename as its session id', () => {
    expect(anchorSessionIdFromPath(`/x/y/${SUCCESSOR_SID}.jsonl`)).toBe(SUCCESSOR_SID);
  });

  it('reads the id embedded in a codex rollout filename', () => {
    expect(
      anchorSessionIdFromPath(`/x/y/rollout-2026-09-15T12-00-00-${PREDECESSOR_SID}.jsonl`),
    ).toBe(PREDECESSOR_SID);
  });

  it('returns null — CANNOT-PROVE, never "matches" — for an unrecognized basename', () => {
    // A test seam's temp file, a rotated name, anything not UUID-shaped.
    expect(anchorSessionIdFromPath('/x/y/1-predecessor.jsonl')).toBeNull();
    expect(anchorSessionIdFromPath('/x/y/not-a-uuid.jsonl')).toBeNull();
  });

  it('returns null for a non-transcript path', () => {
    expect(anchorSessionIdFromPath(`/x/y/${SUCCESSOR_SID}.txt`)).toBeNull();
  });

  it('is pinned identical to adv-sessions NATIVE_SESSION_ID_RE so validation cannot drift', () => {
    // A LOCAL copy exists deliberately (adv-sessions statically imports db-org, which
    // this sync hot path must not pull in), so the two are pinned by source text
    // rather than by import — derived-truth ladder rung 2.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const grab = (file: string, name: string): string | null => {
      const src = fs.readFileSync(path.join(here, file), 'utf8');
      return new RegExp(`const ${name} = (/[^\\n]*?/[a-z]*);`).exec(src)?.[1] ?? null;
    };
    const mine = grab('compaction-usage.ts', 'ANCHOR_SESSION_ID_RE');
    const theirs = grab('adv-sessions.ts', 'NATIVE_SESSION_ID_RE');
    expect(mine).not.toBeNull(); // the pin itself must not rot into a vacuous pass
    expect(theirs).not.toBeNull();
    expect(mine).toBe(theirs);
  });
});

describe('noteLiveNativeSession — the per-request authority that needs no broadcast', () => {
  it('a MATCHING id re-proves the anchor for free, with no DB hit', async () => {
    fs.writeFileSync(predecessorFile, line(1_400_000)); // 350k tokens
    seedContextAnchorForTests('owner-match', predecessorFile);

    // Age the anchor past the staleness gate: without a re-proof it would decline.
    vi.advanceTimersByTime(PATH_REVERIFY_MS + 1_000);
    noteLiveNativeSession('owner-match', PREDECESSOR_SID);

    expect(currentContextTokensSyncForOwner('owner-match')).toBe(350_000);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(findSessionTranscriptMock).not.toHaveBeenCalled();
  });

  it('a DIFFERING id drops the dead anchor immediately — no TTL wait', () => {
    fs.writeFileSync(predecessorFile, line(1_400_000)); // 350k tokens
    seedContextAnchorForTests('owner-respawned', predecessorFile);
    expect(currentContextTokensSyncForOwner('owner-respawned')).toBe(350_000);

    // The very next tool call this worker serves carries the SUCCESSOR's id.
    noteLiveNativeSession('owner-respawned', SUCCESSOR_SID);

    // Anchor gone: nothing to serve, so nothing is rendered (a reseed is kicked).
    expect(currentContextTokensSyncForOwner('owner-respawned')).toBeNull();
  });

  // NOTE: the "heals onto the successor transcript" property is deliberately NOT
  // re-tested here. compaction-usage.reverify.test.ts already asserts exactly that
  // self-correction end-to-end (its retargeted sync test ends on
  // `toBe(tokensFromFileSize(successorFile))`), and reproducing it from a DROPPED
  // anchor needs the full respawn-log reconciliation mocked rather than just
  // findSessionTranscript — machinery that would test the harness more than the fix.
  // What is unique to this file is the IDENTITY decision (match / differ / unprovable),
  // which is covered above and by the acceptance cases below.

  it('an UNPROVABLE anchor path is a no-op — it must not thrash drop/reseed', () => {
    const odd = path.join(dir, 'not-a-uuid.jsonl');
    fs.writeFileSync(odd, line(400_000)); // 100k tokens
    seedContextAnchorForTests('owner-odd', odd);

    noteLiveNativeSession('owner-odd', SUCCESSOR_SID);

    // Anchor survives (within its TTL it still serves); the staleness gate — not an
    // eager drop — is what governs a path whose identity cannot be established.
    expect(currentContextTokensSyncForOwner('owner-odd')).toBe(100_000);
  });

  it('a report carrying no session id changes nothing', () => {
    fs.writeFileSync(predecessorFile, line(400_000)); // 100k tokens
    seedContextAnchorForTests('owner-noid', predecessorFile);

    noteLiveNativeSession('owner-noid', null);
    noteLiveNativeSession('owner-noid', undefined);
    noteLiveNativeSession('owner-noid', '   ');

    expect(currentContextTokensSyncForOwner('owner-noid')).toBe(100_000);
  });

  it('is safe for an owner this worker has never seen', () => {
    expect(() => noteLiveNativeSession('owner-cold', SUCCESSOR_SID)).not.toThrow();
  });
});

describe('ACCEPTANCE: a stale sibling worker can never render a number for a respawned owner', () => {
  it('declines instead of replaying the dead predecessor’s frozen CRITICAL-band reading', () => {
    // Simulates worker #7 of 16: the respawn's invalidation POST landed on worker #3,
    // so THIS process was never told. Its anchor still points at the predecessor.
    fs.writeFileSync(predecessorFile, line(1_400_000)); // 350k tokens — CRITICAL band
    seedContextAnchorForTests('owner-sibling', predecessorFile);
    expect(currentContextTokensSyncForOwner('owner-sibling')).toBe(350_000);

    // The respawn happens. This worker receives NOTHING — no clear, no report. The
    // predecessor's transcript simply stops growing, which advanceAnchor reads as
    // "unchanged ⇒ current".
    vi.advanceTimersByTime(PATH_REVERIFY_MS + 1_000);

    // Pre-fix this returned 350_000 — a dead process's near-limit number handed to a
    // fresh successor, which is what made agents consider re-compacting with zero work
    // done. Post-fix the anchor is unproven, so the gauge goes silent instead.
    expect(currentContextTokensSyncForOwner('owner-sibling')).toBeNull();
  });

  it('never serves a stale number even when the anchor is byte-identical and readable', () => {
    fs.writeFileSync(predecessorFile, line(1_400_000));
    seedContextAnchorForTests('owner-frozen', predecessorFile);
    const sizeBefore = fs.statSync(predecessorFile).size;

    vi.advanceTimersByTime(PATH_REVERIFY_MS * 10);

    // The file is provably unchanged — the exact condition the old fast path trusted.
    expect(fs.statSync(predecessorFile).size).toBe(sizeBefore);
    expect(currentContextTokensSyncForOwner('owner-frozen')).toBeNull();
  });
});

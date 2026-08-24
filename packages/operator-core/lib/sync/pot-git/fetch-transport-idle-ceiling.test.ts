/**
 * EI-18776567787336109 — the per-fetch ceiling is an IDLE timeout, not a
 * wall-clock one.
 *
 * THE BUG (live, 2026-07-27): `DEFAULT_FETCH_TIMEOUT_MS` was applied as a
 * wall-clock ceiling measured from spawn, so it could not distinguish
 *
 *   - a STALLED transfer (no bytes moving)         -> must die fast
 *   - a LARGE but healthy transfer (bytes flowing) -> must NOT be killed
 *
 * On the tower's 6.3 GB papercusp store that made a cold join STRUCTURALLY
 * impossible: 8/8 cold-join fetches died at exactly 120 s while 101/101 warm
 * incremental fetches finished in 100-650 ms. The ladder's last-resort
 * `--unshallow` rung is unbounded in size by design, so no rung size could ever
 * have rescued it.
 *
 * These tests pin BOTH halves of the contract, because a fix that merely made
 * the timeout longer would satisfy the first and silently give up the second.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { serveUploadPack } from './fetch-transport';
import {
  noteFetchInFlight,
  isFetchInFlight,
  sweepStalePackTmpFiles,
  STALE_SHALLOW_LOCK_MAX_AGE_MS,
} from './storage';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A real repo WITH a commit. An empty one lets upload-pack exit on its own,
 * which would make every timing assertion below pass vacuously.
 *
 * `allowOutsideRoot: true` is likewise mandatory at every call site here: the
 * serve guard rejects a tmpdir path PRE-SPAWN, and a guard refusal also returns
 * `timedOut: false` — indistinguishable from "the idle ceiling correctly did
 * not fire" unless git actually ran.
 */
function repoWithCommit(): string {
  const d = mkdtempSync(join(tmpdir(), 'hg-idle-ceiling-'));
  dirs.push(d);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const work = join(d, 'work');
  execFileSync('git', ['init', '-q', work], { timeout: 30_000, killSignal: 'SIGKILL' });
  writeFileSync(join(work, 'f'), 'x');
  execFileSync('git', ['-C', work, 'add', 'f'], { env, timeout: 30_000, killSignal: 'SIGKILL' });
  execFileSync('git', ['-C', work, 'commit', '-qm', 'c'], { env, timeout: 30_000, killSignal: 'SIGKILL' });
  // A BARE repo. Handed a worktree root upload-pack exits in ~30ms with
  // "does not appear to be a git repository", which returns timedOut:false and
  // makes every timing assertion below pass or fail for the wrong reason.
  const bare = join(d, 'r.bare');
  execFileSync('git', ['clone', '--bare', '-q', work, bare], {
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return bare;
}

/**
 * Keeps `upload-pack` ALIVE while we drip bytes at it.
 *
 * The naive fixture (drip spaces) does NOT work, and fails misleadingly: v2
 * upload-pack reads a 4-byte hex pkt-line length first, so "    " is a protocol
 * error and it exits instantly — the serve then settles with timedOut:false for
 * a reason that has nothing to do with the ceiling. Announcing a 20-byte line
 * and never completing it makes upload-pack block on the read instead, so it
 * stays alive as long as we keep dripping.
 */
const PKT_HEADER = '0014';

/**
 * A peer duplex: `push()` sends bytes TO upload-pack's stdin, and whatever
 * upload-pack writes back is swallowed.
 *
 * ⚠ A single `PassThrough` is NOT usable here and fails in a way that looks
 * like an env bug: `serveUploadPack` does BOTH `duplex.pipe(child.stdin)` and
 * `child.stdout.pipe(duplex)`, so one PassThrough loops the server's own v2
 * advertisement straight back into its stdin. upload-pack then parses its own
 * `000eversion 2` banner as a request and dies with
 * `fatal: unknown capability 'version 2'` in ~20ms — timedOut:false, every
 * assertion here meaningless.
 */
function peerDuplex(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

/**
 * Like {@link peerDuplex}, but records the ORDER of two events into `log`:
 * `'end'` when `serveUploadPack` ends the duplex (which is what puts the end
 * frame on the wire) and whatever the caller pushes from `onFailure`.
 *
 * Ordering is the entire contract being tested — see the ordering tests below.
 */
function orderRecordingDuplex(log: string[]): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
    final(cb) {
      log.push('end');
      cb();
    },
  });
}

describe('serveUploadPack — idle ceiling', () => {
  /**
   * THE BUG. A peer that is actively sending bytes must not be killed merely
   * because the transfer is taking a while.
   */
  it('does NOT kill a serve that is still making progress, past several ceilings', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex();
    const settled = { done: false, timedOut: false };

    const p = serveUploadPack(repo, duplex, {
      timeoutMs: 250,
      allowOutsideRoot: true,
    }).then((r) => {
      settled.done = true;
      settled.timedOut = r.timedOut;
      return r;
    });

    duplex.push(PKT_HEADER);
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 60));
      if (settled.done) break;
      duplex.push('x');
    }

    // ~900ms elapsed against a 250ms ceiling. A wall-clock ceiling would have
    // SIGKILLed upload-pack ~650ms ago — precisely the bug.
    expect(settled.done).toBe(false);
    expect(settled.timedOut).toBe(false);

    duplex.destroy();
    await p;
  }, 20_000);

  /**
   * THE GUARANTEE THAT MUST SURVIVE. The ceiling exists so a wedged or hostile
   * peer cannot pin a stream open forever, so a serve that goes genuinely
   * silent must still be killed, exactly as fast as before.
   */
  it('still kills a serve that goes silent, at the idle ceiling', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex(); // live, but never sends anything
    const res = await serveUploadPack(repo, duplex, {
      timeoutMs: 300,
      allowOutsideRoot: true,
    });
    expect(res.timedOut).toBe(true);
    expect(res.stderr).toContain('300ms idle');
  }, 20_000);

  /** A slow-drip peer still cannot pin the stream open indefinitely. */
  it('enforces an absolute ceiling even while bytes keep dripping', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex();
    let stop = false;
    duplex.push(PKT_HEADER);
    const drip = setInterval(() => {
      if (!stop) duplex.push('x');
    }, 40);

    const res = await serveUploadPack(repo, duplex, {
      timeoutMs: 5_000,
      maxMs: 500,
      allowOutsideRoot: true,
    });
    stop = true;
    clearInterval(drip);
    duplex.destroy();

    expect(res.timedOut).toBe(true);
    expect(res.stderr).toContain('absolute ceiling');
  }, 20_000);
});

/**
 * EI-18776567787336109, SECONDARY DEFECT — the serving side must TELL the
 * requester why it failed.
 *
 * THE BUG: the server knew exactly why a serve died (`timedOut=true`, a guard
 * refusal, a nonzero exit), wrote it to its own log, and sent the peer nothing
 * but a bare end frame. The joining machine saw only "pot-git: serve channel
 * closed" — a message that cannot distinguish a server-side timeout from a
 * dropped transport. Diagnosing the 120s ceiling was therefore IMPOSSIBLE from
 * the joiner, and cost several wakes chasing the wrong half of the system.
 *
 * ⚠ WHY ORDERING IS ASSERTED, NOT JUST DELIVERY: the requester DELETES its
 * session when the end frame arrives (serve-wiring.handleEndToClient), so a
 * reason emitted after the duplex ends is silently dropped and the fix would be
 * decorative. `onFailure` firing BEFORE 'end' is the actual contract.
 */
describe('serveUploadPack — failure reason reaches the requester', () => {
  it('reports an idle-ceiling kill, BEFORE ending the duplex', async () => {
    const repo = repoWithCommit();
    const log: string[] = [];
    const duplex = orderRecordingDuplex(log); // live, but never sends anything

    const res = await serveUploadPack(repo, duplex, {
      timeoutMs: 300,
      allowOutsideRoot: true,
      onFailure: (reason) => log.push(`fail:${reason}`),
    });

    expect(res.timedOut).toBe(true);
    // Delivered at all...
    const failure = log.find((l) => l.startsWith('fail:'));
    expect(failure).toBeDefined();
    expect(failure).toContain('timed out after 300ms idle');
    // ...and delivered by the TIMEOUT path specifically, not by the generic
    // nonzero-exit fallback. Mutation testing caught this: removing the
    // timeout's own report still passed a looser assertion, because the
    // fallback message embeds stderr — which quotes the idle text. Pinning the
    // absence of the fallback prefix is what makes this test discriminate.
    expect(failure).not.toContain('upload-pack exited');
    // ...and delivered while the requester still has a session to destroy.
    expect(log.indexOf(failure as string)).toBeLessThan(log.indexOf('end'));
  }, 20_000);

  it('reports a PRE-SPAWN guard refusal, BEFORE ending the duplex', async () => {
    // No `allowOutsideRoot`, so the serve guard rejects the tmpdir path before
    // git is ever spawned. This path used to end the duplex silently too.
    const repo = repoWithCommit();
    const log: string[] = [];
    const duplex = orderRecordingDuplex(log);

    const res = await serveUploadPack(repo, duplex, {
      onFailure: (reason) => log.push(`fail:${reason}`),
    });

    expect(res.code).toBe(-1);
    const failure = log.find((l) => l.startsWith('fail:'));
    expect(failure).toBeDefined();
    expect(failure).toContain('serve refused');
    expect(log.indexOf(failure as string)).toBeLessThan(log.indexOf('end'));
  }, 20_000);

  it('reports a nonzero upload-pack exit, with git’s own stderr', async () => {
    // A real directory that is NOT a repo: upload-pack spawns, then exits
    // nonzero in ~30ms. Distinct from both cases above.
    const notARepo = mkdtempSync(join(tmpdir(), 'hg-not-a-repo-'));
    dirs.push(notARepo);
    const log: string[] = [];
    const duplex = orderRecordingDuplex(log);

    const res = await serveUploadPack(notARepo, duplex, {
      allowOutsideRoot: true,
      onFailure: (reason) => log.push(`fail:${reason}`),
    });

    expect(res.code).not.toBe(0);
    const failure = log.find((l) => l.startsWith('fail:'));
    expect(failure).toBeDefined();
    expect(failure).toContain('upload-pack exited');
    expect(log.indexOf(failure as string)).toBeLessThan(log.indexOf('end'));
  }, 20_000);

  it('stays silent on a CLEAN serve — a healthy fetch must not be told it failed', async () => {
    const repo = repoWithCommit();
    const log: string[] = [];
    const duplex = orderRecordingDuplex(log);
    // v2 flush-only request: upload-pack advertises, sees the flush, exits 0.
    duplex.push('0000');

    const res = await serveUploadPack(repo, duplex, {
      timeoutMs: 5_000,
      allowOutsideRoot: true,
      onFailure: (reason) => log.push(`fail:${reason}`),
    });

    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(log.filter((l) => l.startsWith('fail:'))).toEqual([]);
  }, 20_000);
});

describe('stale shallow.lock sweep — liveness beats age', () => {
  /**
   * The age gate rested on "we SIGKILL any fetch at timeoutMs, so no live fetch
   * can hold this lock longer than that" — an argument that held only while the
   * ceiling was wall-clock. A healthy multi-GB rung now legitimately outlives
   * it, and ticks fire every ~5-10 min, so without an explicit liveness mark the
   * NEXT tick's sweep would unlink the lock of a fetch that is still streaming
   * and corrupt the very cold join this change exists to enable.
   */
  it('does NOT sweep an ancient shallow.lock while a fetch is in flight', async () => {
    const repo = repoWithCommit();
    const lock = join(repo, 'shallow.lock');
    writeFileSync(lock, '');
    // Backdate it far past the gate — age alone would make it eligible.
    const old = (Date.now() - STALE_SHALLOW_LOCK_MAX_AGE_MS * 5) / 1000;
    utimesSync(lock, old, old);

    const release = noteFetchInFlight(repo);
    expect(isFetchInFlight(repo)).toBe(true);
    const held = await sweepStalePackTmpFiles(repo);
    expect(held.removed).not.toContain('shallow.lock');
    expect(existsSync(lock)).toBe(true);

    // Once the fetch settles the lock is genuinely stranded and must be
    // cleared, or the ladder stays wedged forever (WI-6189).
    release();
    expect(isFetchInFlight(repo)).toBe(false);
    const swept = await sweepStalePackTmpFiles(repo);
    expect(swept.removed).toContain('shallow.lock');
    expect(existsSync(lock)).toBe(false);
  });

  /** Refcounted: concurrent legs on one repo must not release each other. */
  it('holds the mark until the LAST concurrent fetch releases it', () => {
    const repo = '/tmp/hg-refcount-probe';
    const a = noteFetchInFlight(repo);
    const b = noteFetchInFlight(repo);
    a();
    expect(isFetchInFlight(repo)).toBe(true);
    b();
    expect(isFetchInFlight(repo)).toBe(false);
    // Double-release is a no-op, never an underflow.
    b();
    expect(isFetchInFlight(repo)).toBe(false);
  });
});

/**
 * EI-18802033487678337 — a serve whose REQUESTER IS GONE must die NOW.
 *
 * THE BUG (live tower, 2026-07-27): nothing killed `upload-pack` when the
 * requester went away. `duplex.on('error')` was a bare crash-guard, and a
 * destroyed duplex is exactly what a channel close produces
 * (`serve-wiring.failAllSessions` destroys every in-flight session; pot-git
 * channels churn 23-36x/min). The child kept running with nowhere to send
 * bytes — and its own stdout/stderr kept rearming the IDLE ceiling, so that
 * safety net could never fire either. Each orphan therefore ran to the
 * ABSOLUTE ceiling: 30 MINUTES of `pack-objects` on a multi-GB repo.
 *
 * Measured consequence: 3+ concurrent `pack-objects` on one 4.1G repo at
 * 1.0-1.7GB RSS and 40-126% CPU each, serves logging 120-566s against a
 * requester whose own ceiling is 120s. Self-amplifying — the orphans slowed the
 * next real serve past that ceiling, which abandoned it, which orphaned another.
 *
 * The ceilings below are set far ABOVE vitest's per-test timeout on purpose: if
 * the abandon path regresses, no ceiling can rescue these tests and they fail
 * by timing out rather than passing slowly.
 */
describe('serveUploadPack — abandoned requester (EI-18802033487678337)', () => {
  it('kills upload-pack the moment the requester duplex is DESTROYED', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex();
    const startedAt = Date.now();
    const p = serveUploadPack(repo, duplex, {
      timeoutMs: 300_000,
      maxMs: 600_000,
      allowOutsideRoot: true,
    });
    // Block upload-pack on an incomplete pkt-line read so it stays alive and
    // silent — the exact state an orphan sits in.
    duplex.push(PKT_HEADER);
    await new Promise((r) => setTimeout(r, 150));
    duplex.destroy(new Error('pot-git: serve channel closed'));

    const res = await p;
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    // The KILL is the property this test is named for, and `stderr` is what
    // actually witnesses it — killChild writes the reason there.
    expect(res.stderr).toContain('abandoned');
    // EI-18808621019872598: an abandonment is NOT a timeout. This used to assert
    // `timedOut === true` because killChild set it unconditionally, which is how
    // a 169ms serve came to be logged `timedOut=true` against a 120000ms idle
    // ceiling — a signal that sends triage after a timeout that never fired.
    expect(res.timedOut).toBe(false);
    // The underlying cause must survive into the reason, rather than being
    // flattened to a bare "requester duplex errored" that blames the peer for
    // what was OUR channel closing (serve-wiring.failAllSessions).
    expect(res.stderr).toContain('pot-git: serve channel closed');
  });

  /** The same stand-down, driven by the caller — `serve-wiring` aborts a serve
   *  a newer request for the same repo on the same channel has superseded. */
  it('kills upload-pack when the caller ABORTS the serve', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex();
    const aborter = new AbortController();
    const startedAt = Date.now();
    const p = serveUploadPack(repo, duplex, {
      timeoutMs: 300_000,
      maxMs: 600_000,
      allowOutsideRoot: true,
      signal: aborter.signal,
    });
    duplex.push(PKT_HEADER);
    await new Promise((r) => setTimeout(r, 150));
    aborter.abort('superseded by a newer request for the same repo');

    const res = await p;
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(res.stderr).toContain('superseded');
    // EI-18808621019872598: a caller-driven stand-down is an abandonment, not a
    // ceiling firing.
    expect(res.timedOut).toBe(false);
  });

  /** An already-aborted signal must not be ignored — otherwise a serve raced
   *  past its own stand-down and ran unkillable to the absolute ceiling. */
  it('honours a signal that was ALREADY aborted before the serve started', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex();
    const res = await serveUploadPack(repo, duplex, {
      timeoutMs: 300_000,
      maxMs: 600_000,
      allowOutsideRoot: true,
      signal: AbortSignal.abort('stale'),
    });
    // The stand-down must be HONOURED — witnessed by the reason killChild wrote,
    // not by `timedOut`, which this path must NOT set (EI-18808621019872598).
    expect(res.stderr).toContain('aborted: stale');
    expect(res.timedOut).toBe(false);
  });

  /**
   * THE NON-REGRESSION HALF, and the reason the `settled` guard exists: a clean
   * serve ends its own duplex, which asynchronously emits 'close'. If that
   * 'close' were treated as an abandonment, EVERY successful serve would report
   * itself failed — a fix that turns a resource bug into a correctness bug.
   */
  it('does NOT report a cleanly-completed serve as abandoned', async () => {
    const repo = repoWithCommit();
    const duplex = peerDuplex();
    const p = serveUploadPack(repo, duplex, {
      timeoutMs: 300_000,
      maxMs: 600_000,
      allowOutsideRoot: true,
    });
    // A v2 flush ends the session: upload-pack advertises, sees the flush, and
    // exits 0 of its own accord — no ceiling, no destroy.
    duplex.push('0000');
    const res = await p;
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stderr).not.toContain('abandoned');
  });
});

// vite-build-singleflight — the one seam every operator-vite bundle build goes
// through. Two properties are under test:
//
//   EI-9836  two ONE-SHOT `vite build` invocations must not race the same dist/:
//            the second BLOCKS (bounded) until the first finishes, then proceeds
//            — unlike vite-watch-singleton (EI-306), which REFUSES a second
//            watcher outright.
//   EI-10539 a build that FAILS must not destroy the bundle that is serving.
//            vite empties outDir in a renderStart hook, so a link-time failure
//            (e.g. a missing named export — measured on vite 8.0.16) dies AFTER
//            dist/ has been emptied and leaves a dead app behind a 503 telling
//            you to run the very build that just failed. The script therefore
//            builds into dist.next/ and renames it over dist/ ONLY on success.
//
// Both are exercised through the VITE_BUILD_CMD seam (a shell command stands in
// for vite; it writes into $PAPERCUSP_VITE_OUT_DIR exactly as the real vite
// config does) and VITE_BUILD_OUT_ROOT (dist/ lives in a tmp tree, never the
// app's live bundle).
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../bin/vite-build-singleflight');

let tmp: string;
const children: ChildProcess[] = [];

function launch(env: Record<string, string>): ChildProcess {
  const child = spawn(SCRIPT, [], {
    env: {
      ...process.env,
      VITE_BUILD_LOCK: join(tmp, 'build.lock'),
      // Never let a test touch the app's real dist/.
      VITE_BUILD_OUT_ROOT: tmp,
      // Retention is the DEFAULT now (dist-chunk-retention-default-2026-07-26),
      // so the STAGING path these tests exercise is reached only via the explicit
      // `=0` opt-out. Pinning it here also isolates the suite from whatever the
      // ambient environment happens to set. The tests that care about the default
      // regime override this back to '' / '1' themselves.
      PAPERCUSP_RETAIN_DIST_CHUNKS: '0',
      // Keep the shared reservation ledger out of the live host ledger. The
      // script's preflight still runs against the real temp filesystem.
      PAPERCUSP_DISK_RESERVATION_DIR: join(tmp, 'disk-reservations'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string; exited: Promise<number | null> } {
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
  return { stdout: () => out, stderr: () => err, exited };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seed a previous, WORKING bundle in dist/ — the thing a red build must not eat. */
function seedWorkingBundle(): void {
  mkdirSync(join(tmp, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(tmp, 'dist', 'index.html'), 'OLD-WORKING-BUNDLE');
  writeFileSync(join(tmp, 'dist', 'assets', 'app-old.js'), 'console.log(1)');
}

/** Stand-in for vite: writes a complete bundle into the staging dir, then exits `status`. */
function fakeVite(status: number, opts: { sleepSecs?: number } = {}): string {
  const nap = opts.sleepSecs ? `sleep ${opts.sleepSecs}; ` : '';
  return (
    `mkdir -p "$PAPERCUSP_VITE_OUT_DIR/assets"; ` +
    `echo NEW-BUNDLE > "$PAPERCUSP_VITE_OUT_DIR/index.html"; ` +
    `echo 'console.log(2)' > "$PAPERCUSP_VITE_OUT_DIR/assets/app-new.js"; ` +
    `${nap}exit ${status}`
  );
}

const distIndex = () => readFileSync(join(tmp, 'dist', 'index.html'), 'utf8').trim();

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      if (c.pid && c.exitCode === null) process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('vite-build-singleflight — build serialization (EI-9836)', () => {
  it('a second one-shot build WAITS for the first, then runs — never races or refuses', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const first = launch({ VITE_BUILD_CMD: 'sleep 1.5 && echo first-done' });
    const firstRes = collect(first);
    await sleep(200); // let it acquire the lock

    const second = launch({ VITE_BUILD_CMD: 'echo second-done' });
    const secondRes = collect(second);

    // The second invocation must not have exited (refused) immediately —
    // it should still be blocked waiting on the first's lock.
    await sleep(200);
    expect(second.exitCode).toBeNull();

    expect(await firstRes.exited).toBe(0);
    expect(firstRes.stdout()).toContain('first-done');

    expect(await secondRes.exited).toBe(0);
    expect(secondRes.stdout()).toContain('second-done');
  }, 15_000);

  it('captures a requested snapshot before releasing the lock to the next build', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const first = launch({
      VITE_BUILD_SNAPSHOT_DIR: join(tmp, 'snapshot'),
      VITE_BUILD_CMD:
        'mkdir -p "$PAPERCUSP_VITE_OUT_DIR"; echo FIRST > "$PAPERCUSP_VITE_OUT_DIR/index.html"; sleep 1; exit 0',
    });
    const firstRes = collect(first);
    await sleep(200); // let the first build acquire the lock

    const second = launch({
      VITE_BUILD_CMD: 'mkdir -p "$PAPERCUSP_VITE_OUT_DIR"; echo SECOND > "$PAPERCUSP_VITE_OUT_DIR/index.html"; exit 0',
    });
    const secondRes = collect(second);

    expect(await firstRes.exited).toBe(0);
    expect(await secondRes.exited).toBe(0);
    expect(readFileSync(join(tmp, 'snapshot', 'index.html'), 'utf8').trim()).toBe('FIRST');
    expect(distIndex()).toBe('SECOND');
  }, 15_000);

  it('a fresh lock is acquired uncontested and the command exit status propagates', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const ok = launch({ VITE_BUILD_CMD: 'true' });
    const { exited } = collect(ok);
    expect(await exited).toBe(0);
  }, 10_000);

  it('refuses before invoking Vite when the target filesystem lacks headroom', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const attempted = join(tmp, 'vite-was-invoked');
    const blocked = launch({
      PAPERCUSP_VITE_BUILD_MIN_FREE_GB: '99999999',
      VITE_BUILD_CMD: `touch "${attempted}"; exit 0`,
    });
    const io = collect(blocked);

    expect(await io.exited).toBe(28);
    expect(existsSync(attempted)).toBe(false);
    expect(io.stderr()).toContain('insufficient disk');
    expect(io.stderr()).toContain('operator-vite dist build');
    expect(io.stderr()).toContain(tmp);
  }, 10_000);

  it('propagates a failing build command status instead of masking it', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const failing = launch({ VITE_BUILD_CMD: 'exit 7' });
    const { exited } = collect(failing);
    expect(await exited).toBe(7);
  }, 10_000);

  it('a waiter that TIMES OUT reports the holder pid and does not hang', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const holder = launch({ VITE_BUILD_CMD: 'sleep 30' });
    const holderRes = collect(holder);
    await sleep(200); // let it acquire the lock

    const waiter = launch({ VITE_BUILD_CMD: 'echo unreachable', VITE_BUILD_WAIT_SECS: '1' });
    const { stderr, exited } = collect(waiter);
    expect(await exited).toBe(1);
    expect(stderr()).toContain('TIMED OUT');
    expect(stderr()).toContain('EI-9836');

    // The holder is untouched by the waiter's timeout — still running.
    expect(holder.exitCode).toBeNull();
    process.kill(holder.pid!, 'SIGKILL');
    await holderRes.exited;
  }, 15_000);
});

describe('vite-build-singleflight — a red build must not destroy the bundle (EI-10539)', () => {
  it('a FAILING build leaves the previous working dist/ completely intact', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // The real killer: vite empties outDir at renderStart, then dies at link
    // time — so it HAS written into its out dir and still exits non-zero.
    const failing = launch({ VITE_BUILD_CMD: fakeVite(1) });
    const { exited } = collect(failing);
    expect(await exited).toBe(1);

    // The app that was serving is still serving. This is the whole fix.
    expect(distIndex()).toBe('OLD-WORKING-BUNDLE');
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(true);
    // Nothing from the failed build leaked into dist/, and no staging debris is left.
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-new.js'))).toBe(false);
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
    expect(existsSync(join(tmp, 'dist.prev'))).toBe(false);
  }, 15_000);

  it('records the failure so the 503 can say "the last build FAILED" instead of "run the build"', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const failing = launch({ VITE_BUILD_CMD: `echo 'does not provide an export named tapClientResource'; ${fakeVite(1)}` });
    expect(await collect(failing).exited).toBe(1);

    const marker = JSON.parse(readFileSync(join(tmp, '.vite-build-failure.json'), 'utf8'));
    expect(marker.exitCode).toBe(1);
    expect(marker.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The log the 503 points at actually names the error.
    expect(readFileSync(marker.log, 'utf8')).toContain('tapClientResource');
  }, 15_000);

  it('a SUCCESSFUL build swaps the staged bundle over dist/ and clears a stale failure record', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();
    writeFileSync(join(tmp, '.vite-build-failure.json'), '{"failedAt":"2026-07-12T00:00:00Z","exitCode":1,"log":"/x"}');

    const ok = launch({ VITE_BUILD_CMD: fakeVite(0) });
    expect(await collect(ok).exited).toBe(0);

    expect(distIndex()).toBe('NEW-BUNDLE');
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-new.js'))).toBe(true);
    // A clean-empty build is a REPLACEMENT, not a merge — the old chunks go.
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(false);
    // Staging dirs cleaned up, and the stale failure record is gone.
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
    expect(existsSync(join(tmp, 'dist.prev'))).toBe(false);
    expect(existsSync(join(tmp, '.vite-build-failure.json'))).toBe(false);
  }, 15_000);

  it('dist/ keeps serving the OLD bundle for the whole build — never a half-written or empty dist', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // A build that takes real time: mid-flight, dist/ must still be the old
    // bundle — in-place builds spend this entire window empty (the 503 / "failed
    // to import module script" window that EI-9836 chased).
    const building = launch({ VITE_BUILD_CMD: fakeVite(0, { sleepSecs: 1.5 }) });
    const res = collect(building);
    await sleep(600);
    expect(building.exitCode).toBeNull(); // still building
    expect(distIndex()).toBe('OLD-WORKING-BUNDLE'); // …and still serving

    expect(await res.exited).toBe(0);
    expect(distIndex()).toBe('NEW-BUNDLE'); // swapped only at the end
  }, 15_000);

  it('a build that exits 0 without producing a bundle never touches dist/', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // `--help`, a no-op, or the plain `echo` seams above: nothing to swap in.
    // The one thing we must not do is mistake "no output" for "empty bundle".
    const noop = launch({ VITE_BUILD_CMD: 'echo nothing-to-build' });
    expect(await collect(noop).exited).toBe(0);

    expect(distIndex()).toBe('OLD-WORKING-BUNDLE');
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
  }, 10_000);

  it('a RETAIN-regime build is passed through unstaged — it accumulates chunks in dist/ by design', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // A retain build runs with emptyOutDir:false — it never empties dist/, so it
    // is already crash-safe, and staging it would throw away the very chunks an
    // open webview is pinned to. It must build straight into dist/, as before.
    const retain = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '1',
      VITE_BUILD_CMD: 'echo NEW-IN-PLACE > "$VITE_BUILD_OUT_ROOT/dist/index.html"; exit 0',
    });
    expect(await collect(retain).exited).toBe(0);

    expect(distIndex()).toBe('NEW-IN-PLACE');
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(true); // retained
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false); // never staged
  }, 10_000);

  // The load-bearing regression test for dist-chunk-retention-default-2026-07-26.
  // The bug that shipped: retention was opt-IN, so a bare `npm run build` on the
  // shared tree wiped every hashed chunk and 404'd the owner's open windows. A
  // bare build must now RETAIN without anyone remembering an env var — if this
  // ever goes back to staging-by-default, the whole class is armed again.
  it('a BARE build (no env at all) retains by default — chunks survive, nothing is staged', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const bare = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '', // as if never set — NOT the '0' opt-out
      VITE_BUILD_CMD: 'echo NEW-IN-PLACE > "$VITE_BUILD_OUT_ROOT/dist/index.html"; exit 0',
    });
    expect(await collect(bare).exited).toBe(0);

    expect(distIndex()).toBe('NEW-IN-PLACE');
    // The chunk an already-open window is pinned to is STILL THERE.
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(true);
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
  }, 10_000);

  it('warns loudly on the =0 opt-out, naming the consequence for open windows', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const wiping = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '0',
      VITE_BUILD_CMD: 'mkdir -p "$PAPERCUSP_VITE_OUT_DIR"; echo NEW > "$PAPERCUSP_VITE_OUT_DIR/index.html"; exit 0',
    });
    const io = collect(wiping);
    expect(await io.exited).toBe(0);
    expect(io.stderr()).toContain('PAPERCUSP_RETAIN_DIST_CHUNKS=0');
    expect(io.stderr()).toContain('Importing a module script failed');
  }, 10_000);
});

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * EI-21355065353185484 — pc-heavy's preemption grace was starved because the
 * probe PERTURBED what it measured.
 *
 * `_preempt_writer_is_held()` runs every 0.1s for the entire life of a heavy job
 * and used to test the exclusive-materialization lock by ACQUIRING it (exclusive
 * flock) on the same file the materializer was trying to acquire. The two stole
 * the lock from each other, so the "materializer is waiting" signal flapped and
 * the 30s grace clock was zeroed on every transient free poll. Measured on a real
 * run: 465 waiting-emissions against exactly ONE preemption across 34 minutes — a
 * materializer promised a 30s wait waited ~34 min.
 *
 * Two independent guards below:
 *  - SOURCE: the probe must poll the INTENT file with a SHARED lock, and the
 *    materializer must declare intent BEFORE queuing for the writer mutex.
 *  - BEHAVIOUR: the flock semantics the fix depends on, including a positive
 *    control that reproduces the OLD collision. Without that control a passing
 *    shared-lock assertion could just mean flock is not doing anything at all.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2). Mutating the real file in this shared
// checkout would let the git-sync sweep commit the mutant.
const SCRIPT = process.env.PC_HEAVY_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');
const source = readFileSync(SCRIPT, 'utf8');

/** The probe body, isolated so assertions cannot accidentally match elsewhere. */
function probeBody(): string {
  const start = source.indexOf('_preempt_writer_is_held() {');
  expect(start, 'the preempt probe function must exist').toBeGreaterThan(-1);
  const end = source.indexOf('\n  }', start);
  expect(end, 'the preempt probe function must terminate').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('pc-heavy preempt probe is inert (EI-21355065353185484)', () => {
  it('probes the INTENT file, never the writer mutex', () => {
    const body = probeBody();
    expect(body).toContain('$_intent_path');
    // Probing the mutex is the original defect: it stole the lock from the
    // materializer polling for it.
    expect(body).not.toContain('_exclusive_writer_path');
    expect(body).not.toContain('_writer_path"');
  });

  it('takes a SHARED lock, never an exclusive one', () => {
    const body = probeBody();
    expect(body).toMatch(/flock\s+-s\s+-n/);
    // A bare `flock -n` here is exclusive and reintroduces probe-vs-probe
    // collisions, which manufacture a phantom "materializer is waiting".
    expect(body).not.toMatch(/flock\s+-n\s+"\$_probe_fd"/);
  });

  it('opens the intent file append-mode so it cannot truncate a locked file', () => {
    expect(probeBody()).toMatch(/exec\s+\{_probe_fd\}>>"\$_intent_path"/);
  });

  it('declares materializer intent BEFORE queuing for the writer mutex', () => {
    const intentAt = source.indexOf('{_exclusive_intent_fd}>>"$_exclusive_intent_path"');
    const writerWaitAt = source.indexOf('flock "$_exclusive_writer_fd" &');
    expect(intentAt, 'materializer must establish the intent lock').toBeGreaterThan(-1);
    expect(writerWaitAt, 'materializer must join the kernel writer queue').toBeGreaterThan(-1);
    // Order matters: a materializer QUEUED behind another materializer holds the
    // writer lock precisely never, so intent declared after joining the queue would leave
    // it invisible to ordinary holders — exactly the case that starved.
    expect(intentAt).toBeLessThan(writerWaitAt);
  });

  it('keeps the intent and writer locks on DIFFERENT paths', () => {
    const intent = source.match(/^_exclusive_intent_path=.*$/m)?.[0] ?? '';
    const writer = source.match(/^_exclusive_writer_path=.*$/m)?.[0] ?? '';
    expect(intent).not.toBe('');
    expect(writer).not.toBe('');
    expect(intent.split('=')[1]).not.toBe(writer.split('=')[1]);
  });

  it('does not zero a running grace clock on a single free poll', () => {
    // Hysteresis is the second half of the fix: the grace bounds how long a
    // materializer waits, so it must survive an instant of noise.
    expect(source).toContain('_preempt_clear_after');
    expect(source).toContain('_preempt_free_since');
    expect(source).not.toMatch(/else\n\s+_preempt_seen_at=''\n\s+fi/);
  });

  it('preserves the WI-6140 release-gate admission exemption', () => {
    expect(source).toContain('PC_HEAVY_RELEASE_GATE:-');
    // Deliberately a dedicated key: GREEN_CHECKPOINT is double-duty and agents
    // export it by hand, so keying admission off it reopens the hole.
    expect(source).not.toContain('GREEN_CHECKPOINT:-');
  });

  it('is syntactically valid bash', () => {
    expect(() =>
      execFileSync('bash', ['-n', SCRIPT], {
        timeout: 10_000,
        killSignal: 'SIGKILL',
      }),
    ).not.toThrow();
  });
});

describe('flock semantics the fix depends on', () => {
  let dir = '';
  let intent = '';
  const activeHolders = new Set<ChildProcess>();

  /** The flock wrapper starts `sleep` via `-c`; kill its whole group so teardown cannot orphan it. */
  function killHolderTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // It exited between the liveness check and teardown.
      }
    }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-heavy-probe-'));
    intent = join(dir, 'intent');
    writeFileSync(intent, '');
  });

  afterAll(() => {
    for (const child of activeHolders) killHolderTree(child);
    activeHolders.clear();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Hold `mode` on the intent file for `ms`, resolving once the lock is held. */
  function hold(mode: '-x' | '-s', ms: number): { done: Promise<void>; ready: Promise<void> } {
    const child = spawn('flock', [mode, intent, '-c', `sleep ${ms / 1000}`], {
      stdio: 'ignore',
      detached: true,
    });
    activeHolders.add(child);
    const watchdog = setTimeout(() => killHolderTree(child), Math.max(ms + 5_000, 10_000));
    watchdog.unref();
    const done = new Promise<void>((res) => {
      const settled = () => {
        clearTimeout(watchdog);
        activeHolders.delete(child);
        res();
      };
      child.once('exit', settled);
      child.once('error', settled);
    });
    // The lock is not held at spawn time; give flock a moment to acquire it.
    const ready = new Promise<void>((res) => setTimeout(res, 400));
    return { done, ready };
  }

  function probeSucceeds(mode: '-s' | ''): boolean {
    const args = mode ? [mode, '-n', intent, '-c', 'true'] : ['-n', intent, '-c', 'true'];
    try {
      execFileSync('flock', args, { stdio: 'ignore', timeout: 5_000, killSignal: 'SIGKILL' });
      return true;
    } catch {
      return false;
    }
  }

  it('a shared probe SEES an exclusive materializer', async () => {
    const h = hold('-x', 2000);
    await h.ready;
    expect(probeSucceeds('-s')).toBe(false);
    await h.done;
  });

  it('a shared probe reports NO signal when nothing holds the lock', () => {
    expect(probeSucceeds('-s')).toBe(true);
  });

  it('two shared probes do NOT collide (the fix)', async () => {
    const h = hold('-s', 2000);
    await h.ready;
    expect(probeSucceeds('-s')).toBe(true);
    await h.done;
  });

  it('POSITIVE CONTROL: two exclusive probes DO collide (the original bug)', async () => {
    // Without this the shared-lock assertions above could pass simply because
    // flock was inert in this environment. This proves the instrument works and
    // reproduces the phantom signal that starved the grace clock.
    const h = hold('-x', 2000);
    await h.ready;
    expect(probeSucceeds('')).toBe(false);
    await h.done;
  });
});

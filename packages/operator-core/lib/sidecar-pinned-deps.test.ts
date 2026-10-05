/**
 * EI-21832562420831737, part three — a release-audited sidecar cut may not read its
 * dependencies out of a tree other agents are writing.
 *
 * Parts one and two guarded SOURCE (one repo root; refuse a tree that was dirty at the phase
 * boundary). This suite guards the other half of what the build reads: node_modules.
 *
 * The shape being refused is not hypothetical. The cut that shipped r15 overlay-mounted 86
 * dependency trees whose lower layer was the LIVE shared checkout, and r14 — the same shape,
 * with dependency generation still on to notice — died on a torn cache hit when a concurrent
 * live build rewrote that lower layer mid-comparison (D-187). D-186 then switched dependency
 * generation off for cost, so the hazard outlived its only detector.
 *
 * WHY THIS FILE CAN BE RUN AT ALL, which is the part that took the design work: the coupling
 * it exists to refuse needs root to create, so the honest options were a source grep (a guard
 * nobody can falsify) or an injectable mount table. `papercusp_assert_pinned_deps_decoupled`
 * therefore takes the mountinfo path as a POSITIONAL PARAMETER — never an environment
 * variable, which would let an ambient `=/dev/null` blind a release gate — and the producer is
 * guard-tested below to pass exactly two arguments.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/build-desktop-sidecar.sh above this test)',
  );
}

const ROOT = repoRoot();

/** Subject paths, overridable so a mutation probe can aim this suite at a COPY. */
const HELPER_PATH =
  process.env.PAPERCUSP_PINNED_DEPS_HELPER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'lib', 'pinned-deps.sh');
const PRODUCER_PATH =
  process.env.PAPERCUSP_PINNED_DEPS_PRODUCER_PATH?.trim() ||
  join(ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh');

/** Comments never count — a rule that a comment can satisfy is not a rule. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Drive the library through its script dispatcher, the way the locked snapshot path
 * re-invokes it. spawnSync rather than execFileSync because a REFUSAL is the expected
 * outcome in most cases here, and the exit code plus the operator-facing message are both
 * part of the contract.
 *
 * WI-41180: a sync spawn blocks the worker's event loop, so vitest cannot time it out, and
 * the pure lane shares one fork across thousands of files — an unbounded hang here wedges
 * all of them until the batch watchdog fires.
 */
function runLib(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('bash', [HELPER_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

const scratch: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-deps-'));
  scratch.push(dir);
  return dir;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/**
 * A synthetic /proc/self/mountinfo line. Field order is the kernel's:
 *   id parent maj:min ROOT MOUNTPOINT OPTIONS [tags...] - FSTYPE SOURCE SUPEROPTS
 * For an overlay the per-superblock `lowerdir=` lives in SUPEROPTS; for a bind mount the
 * source path is ROOT, because these filesystems are mounted at /.
 */
function overlayLine(mountpoint: string, lowerdir: string): string {
  return `900 25 0:99 / ${mountpoint} rw,relatime - overlay overlay-fixture rw,lowerdir=${lowerdir},upperdir=/tmp/u,workdir=/tmp/w`;
}
function bindLine(mountpoint: string, source: string): string {
  return `901 25 259:2 ${source} ${mountpoint} rw,relatime - ext4 /dev/fixture rw`;
}

describe('EI-21832562420831737 — a pinned cut owns its dependencies', () => {
  beforeAll(() => {
    if (!existsSync(HELPER_PATH)) {
      throw new Error(`pinned-deps helper missing at ${HELPER_PATH}`);
    }
  });

  describe('papercusp_pinned_deps_trees — what the build will actually read', () => {
    it('finds dependency trees at the depths a workspace install reaches', () => {
      const t = fixture();
      mkdirSync(join(t, 'node_modules'), { recursive: true });
      mkdirSync(join(t, 'apps', 'operator', 'node_modules'), { recursive: true });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).toContain('node_modules');
      expect(trees).toContain('apps/operator/node_modules');
    });

    it('EXCLUDES the generated sidecar output dir — D-187, which cost a release', () => {
      const t = fixture();
      mkdirSync(join(t, 'papercusp-desktop', 'src-tauri', 'sidecar', 'node_modules'), {
        recursive: true,
      });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).not.toContain('papercusp-desktop/src-tauri/sidecar/node_modules');
    });

    it('EXCLUDES nested trees under a node_modules — they are reached through the parent', () => {
      const t = fixture();
      mkdirSync(join(t, 'node_modules', 'pkg', 'node_modules'), { recursive: true });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).toEqual(['node_modules']);
    });

    it('EXCLUDES agent scratch under .papercusp — it is not build input', () => {
      const t = fixture();
      mkdirSync(join(t, '.papercusp', 'scratch', 'node_modules'), { recursive: true });
      const trees = runLib(['trees', t]).out.trim().split('\n').filter(Boolean);
      expect(trees).toEqual([]);
    });

    it('a fresh worktree with no dependencies is an ANSWER, not an error', () => {
      const r = runLib(['trees', fixture()]);
      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe('');
    });
  });

  describe('papercusp_pinned_deps_snapshot — the floor the overlay stands on', () => {
    it('survives an npm-style REPLACE of a donor package (the r14 killer)', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'left', 'index.js'), 'v1');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);

      // Exactly what npm does: unlink the directory entry, extract a new tree in its place.
      rmSync(join(t, 'donor', 'node_modules', 'left'), { recursive: true, force: true });
      write(join(t, 'donor', 'node_modules', 'left', 'index.js'), 'v2');

      expect(readFileSync(join(t, 'snap', 'node_modules', 'left', 'index.js'), 'utf8')).toBe('v1');
    });

    it('survives the donor DELETING a package outright', () => {
      const t = fixture();
      write(join(t, 'donor', 'apps', 'web', 'node_modules', 'dep', 'i.js'), 'kept');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      rmSync(join(t, 'donor', 'apps', 'web', 'node_modules', 'dep'), {
        recursive: true,
        force: true,
      });
      expect(
        readFileSync(join(t, 'snap', 'apps', 'web', 'node_modules', 'dep', 'i.js'), 'utf8'),
      ).toBe('kept');
    });

    it('is a HARDLINK farm, not a copy — the whole cost argument rests on this', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'shared');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      const a = statSync(join(t, 'donor', 'node_modules', 'p', 'i.js'));
      const b = statSync(join(t, 'snap', 'node_modules', 'p', 'i.js'));
      expect(b.ino).toBe(a.ino);
      expect(b.nlink).toBeGreaterThanOrEqual(2);
    });

    it('preserves relative symlink TEXT, so workspace packages resolve at the MOUNTPOINT', () => {
      const t = fixture();
      mkdirSync(join(t, 'donor', 'node_modules', '@papercusp'), { recursive: true });
      symlinkSync('../../libs/generic/x', join(t, 'donor', 'node_modules', '@papercusp', 'x'));
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      const r = spawnSync('readlink', [join(t, 'snap', 'node_modules', '@papercusp', 'x')], {
        encoding: 'utf8',
        // WI-41180: bounded like the helper call above — a sync spawn blocks the pure
        // lane's shared worker, which vitest cannot time out.
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(String(r.stdout).trim()).toBe('../../libs/generic/x');
    });

    it('copy mode survives in-place writes on both sides with independent inodes', () => {
      const t = fixture();
      const donor = join(t, 'donor', 'node_modules', 'p', 'i.js');
      const copied = join(t, 'snap', 'node_modules', 'p', 'i.js');
      write(donor, 'original');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap'), 'copy']).code).toBe(0);
      expect(statSync(copied).ino).not.toBe(statSync(donor).ino);
      writeFileSync(donor, 'donor changed in place');
      expect(readFileSync(copied, 'utf8')).toBe('original');
      writeFileSync(copied, 'snapshot changed in place');
      expect(readFileSync(donor, 'utf8')).toBe('donor changed in place');
      expect(readFileSync(join(t, 'snap', '.papercusp-pinned-deps'), 'utf8')).toContain('mode=copy');
    });

    it('refuses an unknown snapshot mode before producing a dependency stamp', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'original');
      const r = runLib(['snapshot', join(t, 'donor'), join(t, 'snap'), 'unknown']);
      expect(r.code).toBe(2);
      expect(r.err).toContain('snapshot mode must be hardlink or copy');
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });

    it('mirrors the donor layout rather than flattening it, so a lowerdir is prefix-checkable', () => {
      const t = fixture();
      write(join(t, 'donor', 'apps', 'operator', 'node_modules', 'p', 'i.js'), 'x');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      expect(existsSync(join(t, 'snap', 'apps', 'operator', 'node_modules', 'p', 'i.js'))).toBe(
        true,
      );
    });

    it('stamps the snapshot with its donor, tree count and time', () => {
      const t = fixture();
      write(join(t, 'donor', 'node_modules', 'p', 'i.js'), 'x');
      expect(runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]).code).toBe(0);
      const stamp = readFileSync(join(t, 'snap', '.papercusp-pinned-deps'), 'utf8');
      expect(stamp).toContain(`donor=${join(t, 'donor')}`);
      expect(stamp).toMatch(/^trees=1$/m);
      expect(stamp).toMatch(/^takenAtUtc=\d{4}-\d{2}-\d{2}T/m);
    });

    it('REFUSES to snapshot THROUGH a symlinked tree — cp -al would reproduce the link', () => {
      const t = fixture();
      mkdirSync(join(t, 'donor', 'apps', 'web'), { recursive: true });
      mkdirSync(join(t, 'elsewhere', 'node_modules'), { recursive: true });
      symlinkSync(join(t, 'elsewhere', 'node_modules'), join(t, 'donor', 'apps', 'web', 'node_modules'));
      const r = runLib(['snapshot', join(t, 'donor'), join(t, 'snap')]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/symlinked dependency tree/);
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });

    it('refuses a donor that is not a directory rather than stamping an empty snapshot', () => {
      const t = fixture();
      const r = runLib(['snapshot', join(t, 'nope'), join(t, 'snap')]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/donor is not a directory/);
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });
  });

  describe('papercusp_pinned_deps_snapshot_locked — prevention, not detection', () => {
    it('REFUSES when the donor install mutex is unreachable; never snapshots unlocked', () => {
      const t = fixture();
      mkdirSync(join(t, 'donor', 'node_modules'), { recursive: true });
      const r = runLib(['snapshot-locked', join(t, 'donor'), join(t, 'snap')]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/install mutex/);
      // The point of the refusal: no artifact is produced that a later reader could mistake
      // for a locked snapshot. A torn snapshot is indistinguishable from a good one.
      expect(existsSync(join(t, 'snap', '.papercusp-pinned-deps'))).toBe(false);
    });

    it('takes the lock through npm-install-safe --exec-under-lock, not a second implementation', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      expect(helper).toMatch(/npm-install-safe\.mjs/);
      expect(helper).toMatch(/--exec-under-lock/);
      // fs-mutex is the primitive npm-install-safe already owns. Reaching past it into the
      // mkdir-lock algorithm would be a second implementation of one contract.
      expect(helper).not.toMatch(/withFsMutex|fs-mutex/);
    });

    it('does NOT fall back to an unlocked snapshot on any path', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      const locked = helper.slice(helper.indexOf('papercusp_pinned_deps_snapshot_locked()'));
      const body = locked.slice(0, locked.indexOf('\n}'));
      expect(body).not.toMatch(/\|\|\s*papercusp_pinned_deps_snapshot\b/);
    });
  });

  describe('papercusp_assert_pinned_deps_decoupled — the gate', () => {
    it('PASSES a tree that owns its dependencies (satisfiable by construction)', () => {
      const t = fixture();
      write(join(t, 'node_modules', 'p', 'i.js'), 'x');
      const r = runLib(['assert', t, '', join(t, 'empty-mountinfo')]);
      expect(r.code).toBe(0);
    });

    it('PASSES a tree with no dependencies at all', () => {
      expect(runLib(['assert', fixture()]).code).toBe(0);
    });

    it('REFUSES an overlay whose lower layer is a foreign tree — the r14 shape', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        overlayLine(join(t, 'pinned', 'node_modules'), '/somewhere/else/node_modules') + '\n',
      );
      const r = runLib(['assert', join(t, 'pinned'), '', mi]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('/somewhere/else/node_modules');
      expect(r.err).toMatch(/OUTSIDE the pinned tree/);
    });

    it('ACCEPTS an overlay whose lower layer is the DECLARED snapshot root', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      mkdirSync(join(t, 'snap', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        overlayLine(join(t, 'pinned', 'node_modules'), join(t, 'snap', 'node_modules')) + '\n',
      );
      expect(runLib(['assert', join(t, 'pinned'), join(t, 'snap'), mi]).code).toBe(0);
    });

    it('checks EVERY lowerdir in a stacked overlay, not just the first', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      mkdirSync(join(t, 'snap', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        overlayLine(
          join(t, 'pinned', 'node_modules'),
          `${join(t, 'snap', 'node_modules')}:/live/node_modules`,
        ) + '\n',
      );
      const r = runLib(['assert', join(t, 'pinned'), join(t, 'snap'), mi]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('/live/node_modules');
    });

    it('REFUSES a bind mount from a foreign tree, caught by the same pass', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(mi, bindLine(join(t, 'pinned', 'node_modules'), '/live/node_modules') + '\n');
      const r = runLib(['assert', join(t, 'pinned'), '', mi]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('/live/node_modules');
    });

    it('IGNORES mounts outside the tree and mounts that are not dependency trees', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(
        mi,
        [
          overlayLine('/elsewhere/node_modules', '/live/node_modules'),
          overlayLine(join(t, 'pinned', 'target'), '/live/target'),
        ].join('\n') + '\n',
      );
      expect(runLib(['assert', join(t, 'pinned'), '', mi]).code).toBe(0);
    });

    it('REFUSES a node_modules that is a SYMLINK out of the tree', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned'), { recursive: true });
      mkdirSync(join(t, 'live', 'node_modules'), { recursive: true });
      symlinkSync(join(t, 'live', 'node_modules'), join(t, 'pinned', 'node_modules'));
      const r = runLib(['assert', join(t, 'pinned'), '', join(t, 'no-mountinfo')]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/SYMLINK to dependencies outside the pinned tree/);
    });

    it('ACCEPTS a symlink into the declared snapshot root', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned'), { recursive: true });
      mkdirSync(join(t, 'snap', 'node_modules'), { recursive: true });
      symlinkSync(join(t, 'snap', 'node_modules'), join(t, 'pinned', 'node_modules'));
      expect(runLib(['assert', join(t, 'pinned'), join(t, 'snap'), join(t, 'none')]).code).toBe(0);
    });

    it('says what to do about it — a refusal with no repair gets bypassed, not obeyed', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const mi = join(t, 'mountinfo');
      writeFileSync(mi, overlayLine(join(t, 'pinned', 'node_modules'), '/live/node_modules') + '\n');
      const { err } = runLib(['assert', join(t, 'pinned'), '', mi]);
      expect(err).toMatch(/papercusp_pinned_deps_snapshot_locked/);
    });

    it('reports the mount axis as skipped rather than silently passing it', () => {
      const t = fixture();
      mkdirSync(join(t, 'pinned', 'node_modules'), { recursive: true });
      const { err, code } = runLib(['assert', join(t, 'pinned'), '', join(t, 'absent')]);
      expect(code).toBe(0);
      expect(err).toMatch(/skipping the mount check/);
    });
  });

  describe('WIRING — the producer actually runs it', () => {
    let producer = '';
    beforeAll(() => {
      producer = codeOnly(readFileSync(PRODUCER_PATH, 'utf8'));
    });

    it('sources lib/pinned-deps.sh', () => {
      expect(producer).toMatch(/source\s+"\$HERE\/lib\/pinned-deps\.sh"/);
    });

    it('calls the assertion under vm-release', () => {
      expect(producer).toMatch(/papercusp_assert_pinned_deps_decoupled\s+"\$REPO_ROOT"/);
    });

    it('a refusal EXITS, rather than being logged and ignored', () => {
      const call = producer.slice(producer.indexOf('papercusp_assert_pinned_deps_decoupled'));
      expect(call.slice(0, 400)).toMatch(/exit 2/);
    });

    it('passes exactly the repo root and the declared snapshot root — never a mountinfo override', () => {
      const m = producer.match(/papercusp_assert_pinned_deps_decoupled[^\n]*/);
      expect(m).toBeTruthy();
      const call = String(m?.[0]);
      expect(call).toMatch(/PAPERCUSP_PINNED_DEPS_SNAPSHOT_ROOT/);
      // A third argument here would let a caller aim the gate at a table of its choosing.
      expect(call).not.toMatch(/mountinfo/i);
    });

    it('runs AFTER the source-clean gate — both are entry gates, before any toolchain work', () => {
      const clean = producer.indexOf('papercusp_assert_release_source_clean');
      const deps = producer.indexOf('papercusp_assert_pinned_deps_decoupled');
      const node = producer.indexOf('PAPERCUSP_REQUIRED_NODE_MAJOR');
      expect(clean).toBeGreaterThan(-1);
      expect(deps).toBeGreaterThan(clean);
      expect(node).toBeGreaterThan(deps);
    });
  });

  describe('REUSE INVARIANTS — the mistakes this design is one edit away from', () => {
    it('does not re-implement the dependency-generation fingerprint', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      expect(helper).not.toMatch(/dependency_generation_tree_fingerprint|sha256sum/);
    });

    it('builds beside the destination and swaps, never mutating a live lower layer in place', () => {
      const helper = codeOnly(readFileSync(HELPER_PATH, 'utf8'));
      expect(helper).toMatch(/pinned-deps-tmp/);
      // `rm -rf "$dest"` followed by a slow repopulate is the outage shape
      // sync_one_node_modules was rewritten to remove; it must not reappear here.
      expect(helper).not.toMatch(/rm -rf "\$_dst"/);
    });
  });
});

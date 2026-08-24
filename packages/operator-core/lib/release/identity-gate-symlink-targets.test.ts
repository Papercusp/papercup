/**
 * Recurrence guard for WI-39462 — a SYMLINK's target is identity-bearing content,
 * and the release identity gate must read it: in the working tree, in a tar's
 * `linkname` header, and (the part that actually shipped) inside a `.tar.zst`.
 *
 * WHAT WENT WRONG (measured with paired controls, not hypothesised):
 *
 *   The owner's absolute home path sat COMMITTED in this repo as two tracked
 *   symlink blobs (mode 120000) under
 *   `libs/papercusp/packages/harness/docs-viewer/src/content/docs/projects/`.
 *   A symlink's git blob content IS its target string, so the build box's layout
 *   was in git, and it shipped inside every release's `source.tar.zst`.
 *
 *   Every scan we own reported CLEAN, for three independent reasons:
 *
 *   1. `grep -r` never reads a symlink and never descends into a symlinked
 *      directory, so NO working-tree pass could see it. The gate's own coverage
 *      report even PRINTED the leaking path in a "⚠ symlinked director(ies) are
 *      NOT traversed" line and still exited 0 — a warning where a finding
 *      belonged.
 *
 *   2. In a tar, the target lives in the header's `linkname` field. The member
 *      has ZERO payload bytes and an innocuous path, so the content grep and the
 *      path pass both missed it. Paired control: the SAME literal moved into a
 *      member's CONTENT failed correctly (exit 1, attributed to the file) — which
 *      is what makes this a header blind spot rather than a weak literal set.
 *
 *   3. THE ONE THAT LET 0.0.17 SHIP. `_expand_archive` matched a `.tar.zst`
 *      suffix branch BEFORE the `tarfile.is_tarfile()` branch that routes to
 *      `_expand_tar_memberwise`, and expanded it with a shell `zstd -dc | tar -xf`
 *      — which writes NO `__member_names__.txt` manifest at all. So the single
 *      largest artifact we ship, the whole source tree, was silently exempt from
 *      linkname AND member-name AND uname/gname scanning. Routing control on
 *      identical tar bytes: `.tar` produced a manifest carrying the leak,
 *      `.tar.zst` produced none.
 *
 * The filed diagnosis for (3) was originally "the gate was overridden or
 * misrouted". It was neither: the gate ran and was blind. These guards pin the
 * distinction, because a green verdict from a blind gate is the failure mode the
 * whole file exists to prevent.
 *
 * WHY THE SENTINEL IS DERIVED, NEVER HARDCODED: see the sibling
 * identity-gate-artifact-scan.test.ts — `check-no-identity-literals` scans
 * superproject source for exactly these values, so a real one written here would
 * red the green-checkpoint the tick it landed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
/**
 * Overridable SO THAT THESE GUARDS CAN BE PROVEN FALSIFIABLE without mutating
 * the shared tree — point it at a copy of the gate with the fix backed out and
 * the assertions below must fail. See scripts/mutation-probe.sh (copy-out tier).
 */
const GATE =
  process.env.PAPERCUSP_IDENTITY_GATE_PATH ??
  path.join(REPO_ROOT, 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

function gateSource(): string {
  return readFileSync(GATE, 'utf8');
}

/** The certify path REQUIRES an asserted owner name, kept SYNTHETIC in tracked source. */
const SYNTHETIC_OWNER = 'Zzsynthetic Gateowner';
const GATE_ENV = { ...process.env, PAPERCUSP_RELEASE_OWNER_NAME: SYNTHETIC_OWNER };

/** A value the gate hunts unconditionally, read from its own denylist. */
function sentinelFromDenylist(): string {
  const block = gateSource().match(/KNOWN_SENSITIVE_IDENTITIES\s*=\s*\{([\s\S]*?)\}/)?.[1];
  if (!block) throw new Error('KNOWN_SENSITIVE_IDENTITIES not found — gate structure changed');
  const values = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  const usable = values.filter((v) => v.length >= 6);
  if (usable.length === 0) throw new Error('no high-entropy sentinel available in denylist');
  return usable[0];
}

function have(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], {
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  }).status === 0;
}

function runGate(args: string[]) {
  const r = spawnSync('python3', [GATE, ...args], { encoding: 'utf8', env: GATE_ENV, timeout: 60_000, killSignal: 'SIGKILL' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('release identity gate: .tar.zst is read MEMBER-WISE like every other tar (WI-39462)', () => {
  /**
   * BEHAVIOURAL, NOT TEXTUAL — deliberately. The first cut of this guard asserted
   * the .tar.zst branch's SOURCE TEXT did not contain `tar -xf`, and it failed
   * against the COMMENT in that branch explaining the very defect being fixed. A
   * test that greps prose measures prose. (Same trap as the sibling's `.bin`
   * assertion, WI-39458.) So: expand a real archive and check the manifest
   * actually carries EVERY header class the memberwise reader is responsible for
   * — which no shell `tar -xf` can produce, whatever the source says.
   */
  it('gives .tar.zst the full memberwise header coverage (link, uname, gname)', () => {
    if (!have('tar') || !have('zstd') || !have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: tar/zstd/python3 unavailable');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-cover-'));
    try {
      const stage = path.join(dir, 'stage');
      mkdirSync(stage, { recursive: true });
      writeFileSync(path.join(stage, 'readme.txt'), 'clean\n');
      symlinkSync('/marker-link-target/x', path.join(stage, 'link'));
      const plain = path.join(dir, 'a.tar');
      // Distinct owner/group markers so each field is independently observable.
      execFileSync(
        'tar',
        ['-c', '-f', plain, '--owner=markeruname', '--group=markergname', '-C', stage, '.'],
        { stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      execFileSync('zstd', ['-q', '-f', plain, '-o', path.join(dir, 'a.tar.zst')], {
        stdio: 'ignore',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      const probe = `
import importlib.util, os
spec = importlib.util.spec_from_file_location("aud", ${JSON.stringify(GATE)})
aud = importlib.util.module_from_spec(spec); spec.loader.exec_module(aud)
d = os.path.join(${JSON.stringify(dir)}, "dest")
aud._expand_archive(os.path.join(${JSON.stringify(dir)}, "a.tar.zst"), d)
p = os.path.join(d, "__member_names__.txt")
print("MANIFEST:", open(p).read().replace("\\n", "|") if os.path.exists(p) else "<NONE>")
`;
      const r = spawnSync('python3', ['-c', probe], { encoding: 'utf8', env: GATE_ENV, timeout: 60_000, killSignal: 'SIGKILL' });
      expect(r.status, `probe failed: ${r.stderr}`).toBe(0);
      const manifest = r.stdout;
      expect(manifest, '.tar.zst wrote NO manifest — WI-39462 regression').not.toMatch(/<NONE>/);
      expect(manifest, 'link target missing from .tar.zst manifest').toMatch(/marker-link-target/);
      expect(manifest, 'uname missing from .tar.zst manifest').toMatch(/markeruname/);
      expect(manifest, 'gname missing from .tar.zst manifest').toMatch(/markergname/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * THE INTERPRETER MUST NOT BE LOAD-BEARING. Python 3.14 added a native zstd
   * codec (`compression.zstd`), so on 3.14 `tarfile.is_tarfile()` returns True for
   * a .tar.zst and the generic tar branch would route it memberwise even if the
   * explicit .tar.zst branch were deleted. On 3.13 and earlier it returns False,
   * the file falls through to the plain `.zst` branch, and that branch writes a
   * single opaque `payload` blob with NO manifest — blind again, exactly as
   * 0.0.17 shipped.
   *
   * A mutation probe on THIS box therefore SURVIVES deleting the .tar.zst branch
   * (measured), which would have left the real regression unguarded on every
   * build host running an older python — and the build scripts just call
   * `python3`, whatever that resolves to. So this guard simulates the
   * no-native-zstd interpreter and demands the manifest anyway.
   */
  it('produces the manifest even when tarfile has NO native zstd codec (py<=3.13)', () => {
    if (!have('tar') || !have('zstd') || !have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: tar/zstd/python3 unavailable');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-nozstd-'));
    try {
      const stage = path.join(dir, 'stage');
      mkdirSync(stage, { recursive: true });
      writeFileSync(path.join(stage, 'readme.txt'), 'clean\n');
      symlinkSync('/marker-link-target/x', path.join(stage, 'link'));
      const plain = path.join(dir, 'a.tar');
      execFileSync('tar', ['-c', '-f', plain, '-C', stage, '.'], {
        stdio: 'ignore',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      execFileSync('zstd', ['-q', '-f', plain, '-o', path.join(dir, 'a.tar.zst')], {
        stdio: 'ignore',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      // Force the pre-3.14 world: no zstd codec, so is_tarfile says False and the
      // generic tar branch cannot rescue a missing .tar.zst branch.
      const probe = `
import importlib.util, os, tarfile
spec = importlib.util.spec_from_file_location("aud", ${JSON.stringify(GATE)})
aud = importlib.util.module_from_spec(spec); spec.loader.exec_module(aud)
aud.tarfile.is_tarfile = lambda *a, **k: False   # simulate py<=3.13
d = os.path.join(${JSON.stringify(dir)}, "dest")
aud._expand_archive(os.path.join(${JSON.stringify(dir)}, "a.tar.zst"), d)
p = os.path.join(d, "__member_names__.txt")
print("MANIFEST:", open(p).read().replace("\\n", "|") if os.path.exists(p) else "<NONE>")
`;
      const r = spawnSync('python3', ['-c', probe], { encoding: 'utf8', env: GATE_ENV, timeout: 60_000, killSignal: 'SIGKILL' });
      expect(r.status, `probe failed: ${r.stderr}`).toBe(0);
      expect(
        r.stdout,
        'without a native zstd codec the .tar.zst branch is the ONLY thing routing this ' +
          'memberwise — no manifest means the 0.0.17 blind spot is back',
      ).not.toMatch(/<NONE>/);
      expect(r.stdout).toMatch(/marker-link-target/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes a member manifest for .tar.zst identical in coverage to .tar', () => {
    if (!have('tar') || !have('zstd') || !have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: tar/zstd/python3 unavailable');
      return;
    }
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-zst-'));
    try {
      const stage = path.join(dir, 'stage');
      mkdirSync(stage, { recursive: true });
      // CONTENTS ARE CLEAN ON PURPOSE — the leak is in the link TARGET only, so a
      // content grep finding it would prove nothing about header coverage.
      writeFileSync(path.join(stage, 'readme.txt'), 'clean\n');
      symlinkSync(`/home/${sentinel}/proj/docs`, path.join(stage, 'link'));

      const plain = path.join(dir, 'a.tar');
      execFileSync(
        'tar',
        ['-c', '-f', plain, '--owner=0', '--group=0', '--numeric-owner', '-C', stage, '.'],
        { stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      execFileSync('zstd', ['-q', '-f', plain, '-o', path.join(dir, 'a.tar.zst')], {
        stdio: 'ignore',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });

      // Drive _expand_archive directly for BOTH routings — the whole defect was a
      // routing difference, so the guard has to compare the two routes, not just
      // assert one works.
      const probe = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("aud", ${JSON.stringify(GATE)})
aud = importlib.util.module_from_spec(spec); spec.loader.exec_module(aud)
out = {}
for name in ("a.tar", "a.tar.zst"):
    dest = os.path.join(${JSON.stringify(dir)}, "dest-" + name)
    ok = aud._expand_archive(os.path.join(${JSON.stringify(dir)}, name), dest)
    man = os.path.join(dest, "__member_names__.txt")
    body = open(man).read() if os.path.exists(man) else None
    out[name] = {"ok": ok, "manifest": body is not None,
                 "carries": (body is not None and ${JSON.stringify(`/home/${sentinel}`)} in body)}
print(json.dumps(out))
`;
      const r = spawnSync('python3', ['-c', probe], { encoding: 'utf8', env: GATE_ENV, timeout: 60_000, killSignal: 'SIGKILL' });
      expect(r.status, `probe failed: ${r.stderr}`).toBe(0);
      const got = JSON.parse(r.stdout.trim().split('\n').pop()!);

      // The .tar leg is the CALIBRATION: if it stops carrying the target, the
      // manifest itself broke and the .tar.zst assertion below would pass
      // vacuously against an equally-broken baseline.
      expect(got['a.tar'].manifest, 'baseline .tar manifest missing').toBe(true);
      expect(got['a.tar'].carries, 'baseline .tar must carry the link target').toBe(true);
      expect(got['a.tar.zst'].manifest, '.tar.zst wrote NO manifest — WI-39462 regression').toBe(
        true,
      );
      expect(got['a.tar.zst'].carries, '.tar.zst manifest must carry the link target').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('FAILS CLOSED on a .tar.zst whose zstd stream cannot be read', () => {
    if (!have('zstd') || !have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: zstd/python3 unavailable');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-corrupt-'));
    try {
      // A zstd MAGIC header followed by garbage: the old shell pipeline reported
      // only `tar`'s status, so a failing zstd feeding an empty stream to a tar
      // that exits 0 returned True having extracted NOTHING — a false CLEAN
      // manufactured by the expander. Unknown must never read as absent.
      writeFileSync(path.join(dir, 'bad.tar.zst'), Buffer.concat([
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        Buffer.alloc(256, 0x41),
      ]));
      const probe = `
import importlib.util, os
spec = importlib.util.spec_from_file_location("aud", ${JSON.stringify(GATE)})
aud = importlib.util.module_from_spec(spec); spec.loader.exec_module(aud)
print("RESULT:", aud._expand_archive(os.path.join(${JSON.stringify(dir)}, "bad.tar.zst"),
                                     os.path.join(${JSON.stringify(dir)}, "dest")))
`;
      const r = spawnSync('python3', ['-c', probe], { encoding: 'utf8', env: GATE_ENV, timeout: 60_000, killSignal: 'SIGKILL' });
      expect(r.stdout).toMatch(/RESULT: False/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('release identity gate: symlink TARGETS are scanned (WI-39462)', () => {
  it('FAILS on a bundle whose only leak is a tar member link target', () => {
    if (!have('tar') || !have('zstd') || !have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: tar/zstd/python3 unavailable');
      return;
    }
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-linkname-'));
    try {
      const stage = path.join(dir, 'stage');
      mkdirSync(stage, { recursive: true });
      writeFileSync(path.join(stage, 'readme.txt'), 'clean\n');
      symlinkSync(`/home/${sentinel}/proj/docs`, path.join(stage, 'link'));

      const bundle = path.join(dir, 'source.tar.zst');
      const plain = path.join(dir, 'source.tar');
      execFileSync(
        'tar',
        ['-c', '-f', plain, '--owner=0', '--group=0', '--numeric-owner', '-C', stage, '.'],
        { stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      execFileSync('zstd', ['-q', '-f', plain, '-o', bundle], {
        stdio: 'ignore',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      rmSync(plain, { force: true });

      // PRECONDITION: the target must really be hidden from a raw grep, or this
      // fixture would pass with the fix backed out (the trap the WI-39458 probe
      // caught: a payload small enough that the container stored it uncompressed).
      const raw = spawnSync('grep', ['-acF', `/home/${sentinel}`, bundle], {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      expect(raw.stdout.trim(), 'link target was not actually compressed away').toBe('0');

      // The DEFAULT (positional) mode — this is the leg stage-source-tree.sh runs
      // as source.tar.zst's independent audit, and the one that let 0.0.17 ship.
      const { status, out } = runGate([bundle]);
      expect(out).toMatch(/MUST NOT SHIP/);
      expect(out).toMatch(/link target/);
      expect(status, 'gate must EXIT NONZERO on an identity in a member link target').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('FAILS on a working-tree symlink whose target carries an identity', () => {
    if (!have('python3')) return;
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-wt-'));
    try {
      const tree = path.join(dir, 'tree');
      mkdirSync(tree, { recursive: true });
      writeFileSync(path.join(tree, 'readme.txt'), 'clean\n');
      // A DIRECTORY link and a FILE link: grep skips both, for the same reason.
      symlinkSync(`/home/${sentinel}/proj/docs`, path.join(tree, 'dirlink'));
      symlinkSync(`/home/${sentinel}/notes.md`, path.join(tree, 'filelink'));

      const { status, out } = runGate(['--scan-dir', dir]);
      expect(out).toMatch(/SYMLINK TARGET\(S\) CARRY SENSITIVE IDENTITY/);
      expect(out, 'a symlinked FILE is skipped by grep too — it must be read').toMatch(/filelink/);
      expect(status, 'gate must EXIT NONZERO on a leaking symlink target').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('stays CLEAN on relative symlinks (not a blanket fail on all links)', () => {
    if (!have('python3')) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-rel-'));
    try {
      const tree = path.join(dir, 'tree');
      mkdirSync(path.join(tree, 'sub'), { recursive: true });
      writeFileSync(path.join(tree, 'readme.txt'), 'clean\n');
      symlinkSync('../readme.txt', path.join(tree, 'sub', 'rel'));
      symlinkSync('./sub', path.join(tree, 'reldir'));

      const { status, out } = runGate(['--scan-dir', dir]);
      // Calibration: it really did READ the links — otherwise "clean" would just
      // mean the new pass never ran, and this test would pass while asleep.
      expect(out).toMatch(/reading 2 link target\(s\)/);
      expect(out).toMatch(/✓ CLEAN/);
      expect(status, 'relative links must not fail the gate').toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('WI-39462: the leaking symlinks are gone from the tree', () => {
  it('no tracked symlink in the superproject or its submodules has an ABSOLUTE target', () => {
    const script = `
      set -u
      sweep() {
        git -C "$1" ls-files -s 2>/dev/null | awk '$1=="120000"{print $2"\\t"$4}' |
        while IFS=$'\\t' read -r sha f; do
          tgt=$(git -C "$1" cat-file -p "$sha" 2>/dev/null)
          case "$tgt" in /*) echo "$1 :: $f -> $tgt";; esac
        done
      }
      sweep .
      for sm in $(git submodule --quiet foreach --recursive 'echo $displaypath' 2>/dev/null); do
        sweep "$sm"
      done
    `;
    const r = spawnSync('bash', ['-c', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 240_000,
    });
    expect(r.status, `sweep failed: ${r.stderr}`).toBe(0);
    const offenders = r.stdout.split('\n').filter((l) => l.trim());
    expect(offenders, `tracked symlink(s) with an absolute target:\n${offenders.join('\n')}`)
      .toEqual([]);
  }, 300_000);
});

/**
 * Recurrence guards for WI-36926 — the owner was logged out of their GNOME
 * desktop TWICE on 2026-08-08 by agent teardown code that signalled the login
 * session.
 *
 *   incident #1 (11:52:49 EDT) — an ancestor walk with `while [ "$P" != "1" ]`
 *     SIGTERM'd `systemd --user` (PPID 1). A user systemd manager that receives
 *     SIGTERM activates exit.target, i.e. logs the user out.
 *   incident #2 (20:32:15 EDT) — `fed_cleanup_scoped` ran
 *     `ps -eo pid,args | grep -F "$work" | kill -9` with $work="a" (a fuzz harness
 *     had called every fed_* function with placeholder args): 1,896 SIGKILLs in one
 *     second, including gnome-session-binary.
 *
 * These tests pin the three floors added in response. They shell out because the
 * subject IS shell — the guards run on the kill path, where node may already be
 * gone, so they must not depend on it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../../..');
// Subject paths are OVERRIDABLE so falsifiability can be proven by mutating a COPY
// outside the tree (scripts/mutation-probe.sh tier 2). Mutating these files in
// place would be unsafe here: git-sync commits the whole working tree every few
// minutes, so a probe that holds a file mutated for the length of a test run can
// have that mutation swept into a real commit (this has happened — see the
// "Proving a guard is falsifiable" section of CLAUDE.md).
const FLOOR_LIB = process.env.PROBE_SESSION_FLOOR_LIB ?? join(REPO, 'scripts/lib/session-floor.sh');
const FLOOR_CLI = process.env.PROBE_SESSION_FLOOR_CLI ?? join(REPO, 'scripts/session-floor.sh');
const FED = process.env.PROBE_FED_ASSERTS ?? join(REPO, 'papercusp-desktop/bin/lib/federation-asserts.sh');

function sh(script: string, cwd = REPO): { out: string; code: number } {
  try {
    // Merge stderr into stdout: every refusal these guards emit goes to stderr by
    // design (a teardown refusal must be visible in a rig's log), and execFileSync
    // returns only stdout when the command succeeds — so without this the tests
    // would silently assert against half the output.
    const out = execFileSync('bash', ['-c', `{ ${script}\n} 2>&1`], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

/** pid of a live process whose comm matches exactly, or null. */
function pidOf(comm: string): string | null {
  const r = sh(`pgrep -x ${comm} -u "$(id -u)" 2>/dev/null | head -1`);
  const pid = r.out.trim();
  return /^\d+$/.test(pid) ? pid : null;
}

describe('session floor — the PID set no teardown may signal (WI-36926)', () => {
  it('protects pid 1 and the user systemd manager (incident #1 victim)', () => {
    const r = sh(`bash ${FLOOR_CLI} check 1`);
    expect(r.out).toMatch(/PROTECTED 1/);
    expect(r.code).toBe(1); // check exits 1 when anything is protected

    const userMgr = pidOf('systemd');
    // A box with no user systemd manager cannot exhibit incident #1; skip rather
    // than assert something the environment cannot produce.
    if (userMgr) {
      const m = sh(`bash ${FLOOR_CLI} check ${userMgr}`);
      expect(m.out).toMatch(/PROTECTED/);
    }
  });

  it('protects gnome-session-binary — CONTROL for the 15-char comm truncation', () => {
    // The kernel clips /proc/<pid>/comm to 15 chars (TASK_COMM_LEN 16). While
    // building this floor, `pgrep -x gnome-session-binary` (20 chars) matched
    // ZERO rows and printed only a warning — so the first version of the guard
    // reported "safe to kill" for the EXACT process whose death ended the owner's
    // session in incident #2. That is a silent false negative, and this case is
    // here to make it loud if the normalisation is ever removed.
    const lib = readFileSync(FLOOR_LIB, 'utf8');
    expect(lib).toMatch(/_sf_trunc/);
    expect(lib).toMatch(/%\.15s/);

    const gsb = pidOf('gnome-session-b');
    if (gsb) {
      const r = sh(`bash ${FLOOR_CLI} check ${gsb}`);
      expect(r.out).toMatch(/PROTECTED/);
      expect(r.code).toBe(1);
    }
  });

  it('does NOT protect an ordinary process — calibration', () => {
    // Without this, every assertion above would also pass if the floor simply
    // returned "protected" for everything, which would be useless in a different way.
    const r = sh(`sleep 30 & p=$!; bash ${FLOOR_CLI} check "$p"; rc=$?; kill "$p" 2>/dev/null; exit $rc`);
    expect(r.out).toMatch(/^ok\s+\d+/m);
    expect(r.code).toBe(0);
  });

  it('fails CLOSED on garbage input', () => {
    const r = sh(`bash ${FLOOR_CLI} check "" 2>&1; echo "rc=$?"`);
    expect(r.out).toMatch(/PROTECTED|rc=1/);
  });
});

describe('fed_cleanup_scoped — validation at the kill site (WI-36926)', () => {
  // `kill` is shadowed so a regression in the subject cannot signal anything real.
  const harness = (body: string) => `
    set -uo pipefail
    KILLED=$(mktemp); export KILLED
    kill() { echo "KILL $*" >> "$KILLED"; return 0; }
    drv_psql() { :; }; drv_ssh() { :; }; drv_exec() { :; }
    source ${FED} 2>/dev/null
    ${body}
    echo "KILLCOUNT=$(wc -l < "$KILLED" | tr -d ' ')"
  `;

  it('REFUSES the exact 2026-08-08 fuzzer call and signals nothing', () => {
    const r = sh(harness(`fed_cleanup_scoped a b c d 1 e f; echo "rc=$?"`));
    expect(r.out).toMatch(/REFUSING 'a'/);
    expect(r.out).toMatch(/rc=2/);
    expect(r.out).toMatch(/KILLCOUNT=0/); // the whole point: nothing died
  });

  it('still ACCEPTS every marker a real rig actually passes', () => {
    // Guarding by the hardcoded /tmp/<rig>. prefix list would have broken
    // two-instance-content-matrix-smoke.sh, which legitimately uses
    // $HOME/.papercusp-lane-a-fed. The guard keys on specificity, not on a prefix.
    // Each entry: [shell expression evaluated by bash, a stable label to assert on].
    // $HOME must stay unexpanded in the shell arg (that is the real call shape) but
    // the label has to be something the regex can match after bash expands it.
    const markers: [string, string][] = [
      ['/tmp/p3-smoke.AbC123', 'p3'],
      ['/tmp/vm-fed.AbC123', 'vmfed'],
      ['/tmp/merge-smoke.AbC123', 'merge'],
      ['/tmp/hive-dir-smoke.AbC123', 'hivedir'],
      ['/tmp/hive-fromrepo-smoke.AbC123', 'fromrepo'],
      ['$HOME/.papercusp-lane-a-fed', 'matrixlane'],
    ];
    const r = sh(
      harness(
        markers
          .map(
            ([m, label]) =>
              `fed_is_safe_kill_marker "${m}" && echo "ACCEPT ${label}" || echo "REFUSE ${label}"`,
          )
          .join('\n'),
      ),
    );
    for (const [m, label] of markers) {
      expect(r.out, `marker ${m} must remain usable`).toMatch(new RegExp(`ACCEPT ${label}`));
    }
    expect(r.out).not.toMatch(/REFUSE/);
  });

  it('refuses non-specific markers that would sweep the box', () => {
    for (const bad of ['a', '1', '/', '/tmp', '/usr', 'relative/path']) {
      const r = sh(harness(`fed_is_safe_kill_marker "${bad}" && echo ACCEPT || echo REFUSE`));
      expect(r.out, `marker ${JSON.stringify(bad)} must be refused`).toMatch(/REFUSE/);
    }
  });

  it('caps blast radius even for a marker that passes sanity', () => {
    // Floor 2 is independent of floor 1 on purpose: it needs no notion of what a
    // valid marker looks like, so it still holds for a future rig whose naming
    // convention nobody updated the sanity check for.
    const dir = mkdtempSync(join(tmpdir(), 'sf-blast.'));
    try {
      // A marker that is specific by shape but matches everything by content.
      const r = sh(
        harness(`
        FED_CLEANUP_MAX_VICTIMS=2
        ps() { printf '%s\\n' "  101 proc-one ${dir}" "  102 proc-two ${dir}" "  103 proc-three ${dir}"; }
        fed_cleanup_scoped "${dir}"; echo "rc=$?"
      `),
      );
      expect(r.out).toMatch(/REFUSING/);
      expect(r.out).toMatch(/matched 3 processes/);
      expect(r.out).toMatch(/rc=3/);
      expect(r.out).toMatch(/KILLCOUNT=0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never signals a session-critical pid regardless of how it was selected', () => {
    // Floor 3. Even if floors 1 and 2 were both wrong, this one stands.
    const gsb = pidOf('gnome-session-b') ?? pidOf('gnome-shell');
    if (!gsb) return; // headless CI — nothing to protect
    const r = sh(harness(`fed_pid_is_session_critical ${gsb} && echo PROTECTED || echo UNPROTECTED`));
    expect(r.out).toMatch(/PROTECTED/);
  });
});

describe('the fallback floor cannot drift weaker than the canonical one', () => {
  it('lists the same session-critical comms, already comm-truncated', () => {
    // federation-asserts.sh must work in a standalone papercusp-desktop checkout,
    // where scripts/lib/session-floor.sh does not exist, so it carries an inline
    // copy. Two implementations means drift risk; this pins them together.
    const canonical = readFileSync(FLOOR_LIB, 'utf8');
    const fallback = readFileSync(FED, 'utf8');
    const canonList = /SESSION_FLOOR_COMMS="\$\{SESSION_FLOOR_COMMS:-([^}]*)\}"/.exec(canonical)?.[1];
    const fedList = /FED_SESSION_FLOOR_COMMS="\$\{FED_SESSION_FLOOR_COMMS:-([^}]*)\}"/.exec(fallback)?.[1];
    expect(canonList, 'canonical comm list must be parseable').toBeTruthy();
    expect(fedList, 'fallback comm list must be parseable').toBeTruthy();

    const trunc = (s: string) => s.trim().split(/\s+/).map((c) => c.slice(0, 15)).sort();
    // The fallback is stored pre-truncated (it has no _sf_trunc helper), so compare
    // canonical-truncated against fallback-as-written.
    expect(trunc(fedList!)).toEqual(trunc(canonList!));
  });
});

/**
 * pretooluse-bash-resource-gate.sh — the native-scheduler lockout leg
 * (native-scheduler-lockout-2026-06-09 P-010).
 *
 * The script is the shared Claude+Codex PreToolUse shell hook; this suite
 * drives it exactly as the host CLI does — JSON on stdin, decision JSON (or
 * silence = allow) on stdout — with a HERMETIC fake $HOME carrying the
 * su-token files the script gates on (so the suite passes on a box with no
 * real install). The OS-scheduler deny is a LOCAL decision (no HTTP);
 * OPERATOR_URL points at a dead port so any accidental resource-gate
 * round-trip fails open fast instead of touching a live operator.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pretooluse-bash-resource-gate.sh');

let fakeHome = '';

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'gate-home-'));
  const dir = join(fakeHome, '.papercusp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'superuser-token'), 'test-token\n');
  writeFileSync(join(dir, 'su-agent-id'), 'test-agent\n');
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function runGate(
  payload: unknown,
  env: Record<string, string> = {},
): { stdout: string; status: number | null } {
  const r = spawnSync('bash', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: fakeHome,
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // dead port — fail-open fast
      ...env,
    },
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function expectDeny(out: { stdout: string; status: number | null }) {
  expect(out.status).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
  const decision = JSON.parse(out.stdout);
  expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('pot:declare-wake');
}

function expectAllow(out: { stdout: string; status: number | null }) {
  expect(out.status).toBe(0);
  expect(out.stdout.trim()).toBe(''); // silence = allow
}

function expectGitDeny(out: { stdout: string; status: number | null }) {
  expect(out.status).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
  const decision = JSON.parse(out.stdout);
  expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('shared-tree guard');
}

const AGENT = { PAPERCUSP_AGENT_SESSION: '1' };
// A deterministic stand-in for the canonical shared staging tree. The hook
// resolves the canonical tree from PAPERCUSP_CANONICAL_TREE (or ~/papercupai-
// workspace/papercusp); we pin it via env + pass an explicit payload `cwd` so
// the tree-based git guard (EI-7872) is tested independent of where vitest runs.
const CANON = '/ws/papercupai-workspace/papercusp';
const CANON_ENV = { PAPERCUSP_CANONICAL_TREE: CANON };
const bashCmd = (
  command: string,
  opts: { tool?: string; cwd?: string } = {},
) => ({
  tool_name: opts.tool ?? 'Bash',
  tool_input: { command },
  session_id: 's-test',
  ...(opts.cwd ? { cwd: opts.cwd } : {}),
});

describe('native-scheduler lockout (agent sessions)', () => {
  it.each([
    ['plain crontab', 'crontab -e'],
    ['bare crontab (stdin form)', 'crontab'],
    ['compound &&', 'cd /tmp && crontab evil-tab'],
    ['compound ;', 'git status; crontab -l'],
    ['piped at', 'echo done | at midnight'],
    ['sudo form', 'sudo crontab -u root -e'],
    ['newline-separated', 'true\ncrontab -l'],
    ['batch', 'batch < jobs.txt'],
    ['systemd-run timer', 'systemd-run --on-calendar=daily echo hi'],
    // EI-9937: quote-stripping must NOT weaken a genuine deny — the scheduler
    // token is UNQUOTED at command position; a quoted arg elsewhere is irrelevant.
    ['&& crontab after a quoted echo', 'echo "done; ok" && crontab -e'],
    ['crontab after a quoted-pipe grep', "grep -E 'a|b' f.txt | crontab -"],
  ])('denies %s', (_label, command) => {
    expectDeny(runGate(bashCmd(command), AGENT));
  });

  it.each([
    ['prose "at"', 'echo "look at this"'],
    ['atuin (no mid-word match)', 'atuin search foo'],
    ['attach (no prefix match)', 'attach session-3'],
    ['crontab in a commit message (not command position)', 'git commit -m "fix crontab docs"'],
    ['systemctl is not systemd-run', 'systemctl --user status papercup-staging-api.service'],
    ['ordinary command', 'ls -la'],
    // ── EI-9937: `;&|` INSIDE a quoted arg are literal data, not shell
    // separators — a read-only grep/wc/sed naming these scheduler tokens in a
    // quoted regex/pattern must NOT trip the command-position anchor. ──
    ['grep -E alternation naming the scheduler tokens', 'grep -E "crontab|at|batch|systemd-run" packages/operator-core/lib/code-run-batch-nudge.ts'],
    ['double-quoted pipe-alternation "at|batch"', 'grep -nE "at|batch" code-run-batch-nudge.ts'],
    ["single-quoted pipe-alternation 'foo|batch'", "grep -rn 'foo|batch' packages/operator-core/lib/"],
    ['sed with a quoted pipe-alternation', "sed -E 's/(a|batch)/x/' code-run-batch-nudge.ts"],
    ['quoted semicolon before batch (echo only)', 'echo "run this; batch job"'],
    ['batch only as a filename substring (no command-position token)', 'wc -l packages/operator-core/lib/code-run-batch-nudge.ts'],
    ['SQL heredoc column named at (not an OS schedule)', 'cat > /tmp/health.mts <<EOF\nSELECT at, statuses FROM harness_shared.system_health_ticks WHERE at >= 0\nEOF'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  it('accepts codex shell tool names (exec_command) — same wire contract', () => {
    expectDeny(runGate(bashCmd('crontab -l', { tool: 'exec_command' }), AGENT));
  });

  it('ignores non-shell tools even in agent sessions', () => {
    expectAllow(runGate({ tool_name: 'Edit', tool_input: { file_path: '/x' } }, AGENT));
  });
});

/**
 * EI-10940 — the refusal must answer the INTENT, not the token.
 *
 * `systemd-run` is overloaded: it is BOTH the OS scheduler (`--on-calendar=…`)
 * AND the only stock way to ask for cgroup resource control (`-p CPUQuota=…`,
 * `--scope`). The lockout denied both with one hardcoded message telling you to
 * "declare your wake via pot:declare-wake" — a non-sequitur when what you were
 * actually doing was capping CPU on a heavy test run, and one that costs a real
 * detour before you work out the suggested tool cannot do the thing you wanted.
 *
 * The DENY is right either way (agent sessions cannot create transient units).
 * Only the REASON branches. These are recurrence guards: they fail against the
 * old single hardcoded message.
 */
function denyReason(out: { stdout: string; status: number | null }): string {
  expect(out.status).toBe(0);
  const decision = JSON.parse(out.stdout);
  expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  return decision.hookSpecificOutput.permissionDecisionReason as string;
}

describe('native-scheduler lockout: the refusal answers the INTENT (EI-10940)', () => {
  it.each([
    ['-p CPUQuota', 'systemd-run -p CPUQuota=200% node_modules/.bin/vitest run'],
    ['--property=CPUQuota', 'systemd-run --property=CPUQuota=800% npm run build'],
    ['-p MemoryMax', 'systemd-run -p MemoryMax=4G ./heavy.sh'],
    ['--scope (transient cgroup, no props)', 'systemd-run --scope ./heavy.sh'],
    ['-p AllowedCPUs (cpuset)', 'systemd-run -p AllowedCPUs=0-7 ./heavy.sh'],
    ['sudo form', 'sudo systemd-run -p CPUWeight=50 ./heavy.sh'],
  ])('a RESOURCE-LIMIT systemd-run (%s) is refused with the resource answer, not the wake answer', (_l, command) => {
    const reason = denyReason(runGate(bashCmd(command), AGENT));
    // Points at the tools that actually do this here…
    expect(reason).toMatch(/taskset/);
    expect(reason).toMatch(/pc-heavy\.sh/);
    // …says WHY systemd-run can't work in an agent session…
    expect(reason).toMatch(/cannot create transient systemd units/);
    // …and never asserts the false premise that you were scheduling something.
    expect(reason).not.toMatch(/must not create OS schedules/);
  });

  it.each([
    ['--on-calendar', 'systemd-run --on-calendar=daily echo hi'],
    ['--on-active', 'systemd-run --on-active=30m ./wake.sh'],
    ['crontab', 'crontab -e'],
    ['at', 'echo done | at midnight'],
    ['batch', 'batch < jobs.txt'],
    ['bare systemd-run (no props, no timer)', 'systemd-run ./thing.sh'],
  ])('a genuine SCHEDULE (%s) still gets the wake answer', (_l, command) => {
    const reason = denyReason(runGate(bashCmd(command), AGENT));
    expect(reason).toMatch(/must not create OS schedules/);
    expect(reason).toMatch(/pot:declare-wake/);
    expect(reason).not.toMatch(/taskset/);
  });

  it('a HYBRID (timer flag + resource prop) is a schedule — scheduling advice wins', () => {
    // `systemd-run --on-calendar=daily -p CPUQuota=50% x` really is creating a
    // timer; the resource prop is incidental. Misreading it as resource-only
    // would hand back advice (taskset) that ignores the persistent-unit problem
    // the lockout exists to prevent.
    const reason = denyReason(
      runGate(bashCmd('systemd-run --on-calendar=daily -p CPUQuota=50% /usr/bin/backup'), AGENT),
    );
    expect(reason).toMatch(/must not create OS schedules/);
    expect(reason).not.toMatch(/taskset/);
  });

  it('the resource branch does not weaken the deny — it is still a deny', () => {
    const out = runGate(bashCmd('systemd-run -p CPUQuota=200% ./heavy.sh'), AGENT);
    const decision = JSON.parse(out.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('quoted prose naming CPUQuota is not a systemd-run at all (no false deny)', () => {
    expectAllow(runGate(bashCmd('echo "we could use -p CPUQuota=200% here"'), AGENT));
  });
});

/**
 * EI-10939 — tauri-agent-tools target guard (SAFETY).
 *
 * `tauri-agent-tools` resolves its target by scanning /tmp for
 * `tauri-dev-bridge-<pid>.token` and taking the FIRST LIVE ONE readdir happens to
 * yield (its tokenDiscovery.js: `if (!found) found = …`). No preference, no
 * tie-break, no warning when several are alive — so a bare `… click '#btn'`
 * drives whichever app came up first, which is very often the OWNER'S LIVE
 * DESKTOP WINDOW rather than the throwaway instance the agent spawned.
 *
 * The package is third-party and global (outside our repo), so the fix lives
 * here, in the hook: refuse to let an UNAIMED command through.
 *
 * The load-bearing case is the FIRST test below: with exactly ONE live bridge
 * there is no ambiguity to detect — and on this box that one bridge was the
 * owner's own papercusp-desktop. An ambiguity-only guard sails right through it.
 * A mutating command must name its target unconditionally.
 */
describe('tauri-agent-tools target guard (EI-10939)', () => {
  let tmpBridgeDir = '';
  const LIVE_A = process.pid; // this vitest process — definitely alive
  const LIVE_B = process.ppid; // its parent — also alive
  const DEAD = 999_999; // no such process

  function writeBridge(pid: number, port: number) {
    writeFileSync(
      join(tmpBridgeDir, `tauri-dev-bridge-${pid}.token`),
      JSON.stringify({ port, token: `tok-${pid}`, pid }),
    );
  }

  /** Run the gate with the fabricated bridge set visible as the temp dir. */
  const runTat = (command: string) =>
    runGate(bashCmd(command), { ...AGENT, TMPDIR: tmpBridgeDir });

  beforeEach(() => {
    tmpBridgeDir = mkdtempSync(join(tmpdir(), 'tat-bridges-'));
  });
  afterEach(() => {
    rmSync(tmpBridgeDir, { recursive: true, force: true });
  });

  it('DENIES a mutating command with ONE live bridge — the "unambiguous" case is exactly how the owner\'s window gets driven', () => {
    writeBridge(LIVE_A, 46423);
    const reason = denyReason(runTat(`tauri-agent-tools eval 'document.title'`));
    expect(reason).toMatch(/DRIVES a webview but does not say WHICH/);
    expect(reason).toMatch(new RegExp(`--pid\\s+${LIVE_A}`)); // names the candidate
    expect(reason).toMatch(/probe/); // and the way to find the right one
  });

  it.each([
    ['click', `tauri-agent-tools click '#send-button'`],
    ['type', `tauri-agent-tools type '#input' 'hello'`],
    ['navigate', `tauri-agent-tools navigate /settings`],
    ['invoke', `tauri-agent-tools invoke some_command`],
    ['select', `tauri-agent-tools select '#dropdown' v`],
    ['focus', `tauri-agent-tools focus '#el'`],
    ['scroll', `tauri-agent-tools scroll --to 400`],
  ])('DENIES unaimed mutating `%s`', (_l, command) => {
    writeBridge(LIVE_A, 46423);
    expect(denyReason(runTat(command))).toMatch(/DRIVES a webview/);
  });

  it.each([
    ['--pid', `tauri-agent-tools eval --pid ${999} 'x'`],
    ['--pid=', `tauri-agent-tools click --pid=${999} '#b'`],
    ['--port + --token', `tauri-agent-tools eval --port 46423 --token abc 'x'`],
  ])('ALLOWS a mutating command that names its target (%s)', (_l, command) => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runTat(command));
  });

  it('ALLOWS an unaimed READ command when only one bridge is live (no ambiguity to resolve)', () => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runTat('tauri-agent-tools dom body'));
  });

  it('DENIES an unaimed READ command when TWO bridges are live — reading the wrong app is how a false green happens', () => {
    writeBridge(LIVE_A, 46423);
    writeBridge(LIVE_B, 43929);
    const reason = denyReason(runTat('tauri-agent-tools dom body'));
    expect(reason).toMatch(/2 bridges are live/);
    expect(reason).toMatch(new RegExp(`--pid\\s+${LIVE_A}`));
    expect(reason).toMatch(new RegExp(`--pid\\s+${LIVE_B}`));
  });

  it('counts only LIVE bridges — a stale token file from a dead app is not ambiguity', () => {
    writeBridge(LIVE_A, 46423);
    writeBridge(DEAD, 111); // stale: the tool itself skips + unlinks these
    expectAllow(runTat('tauri-agent-tools dom body'));
  });

  it.each([
    ['probe — the ANSWER to the deny, so it must never be blocked', 'tauri-agent-tools probe'],
    ['list-windows', 'tauri-agent-tools list-windows'],
    ['info', 'tauri-agent-tools info'],
    ['forensics (bridge-free)', 'tauri-agent-tools forensics --identifier ai.papercup'],
    ['app-paths (bridge-free)', 'tauri-agent-tools app-paths --identifier ai.papercup'],
    ['--help', 'tauri-agent-tools --help'],
    ['bare (usage)', 'tauri-agent-tools'],
  ])('never gates discovery / bridge-free commands: %s', (_l, command) => {
    writeBridge(LIVE_A, 46423);
    writeBridge(LIVE_B, 43929); // maximally ambiguous — still allowed
    expectAllow(runTat(command));
  });

  it('ALLOWS when NO bridge is live — nothing to hit; the tool prints its own error', () => {
    expectAllow(runTat(`tauri-agent-tools eval 'document.title'`));
  });

  it('guards a full-path / npx invocation too (the binary is a global install)', () => {
    writeBridge(LIVE_A, 46423);
    expect(
      denyReason(runTat(`/home/linuxbrew/.linuxbrew/bin/tauri-agent-tools click '#b'`)),
    ).toMatch(/DRIVES a webview/);
  });

  it('a quoted PROSE mention is not an invocation (no false deny)', () => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runTat(`echo "you could run tauri-agent-tools eval document.title"`));
  });
});

describe('destructive tree-wide git guard (hive-loop-supervision-2026-06-21, agent sessions) — EI-2376 recurrence guard', () => {
  it.each([
    ['bare reset --hard', 'git reset --hard'],
    ['reset --hard HEAD', 'git reset --hard HEAD'],
    ['reset --hard a remote ref', 'git reset --hard origin/staging'],
    ['clean -f', 'git clean -f'],
    ['clean -fd', 'git clean -fd'],
    ['clean -fdx', 'git clean -fdx'],
    ['checkout .', 'git checkout .'],
    ['checkout -- .', 'git checkout -- .'],
    ['checkout :/ (repo-root pathspec)', 'git checkout :/'],
    ['restore .', 'git restore .'],
    ['bare stash', 'git stash'],
    ['stash save', 'git stash save "wip"'],
    ['stash push (no explicit path)', 'git stash push'],
    ['sudo-prefixed reset --hard', 'sudo git reset --hard'],
    ['compound && reset --hard', 'cd /tmp && git reset --hard'],
    ['compound ; clean -f', 'git status ; git clean -f'],
    ['newline-separated stash', 'git status\ngit stash'],
    ['git -C <dir> reset --hard', 'git -C /some/repo reset --hard'],
    // wrapper-prefix bypass class (definetool-token-reduction-uncovered-surfaces P-014;
    // PROVEN 2026-07-06: the guard denied `git reset --hard` but ALLOWED `rtk git reset
    // --hard`). rtk = the token-killer output filter, which rewrites `git …`→`rtk git …`.
    ['rtk-wrapped reset --hard (the RTK rewrite that motivated this)', 'rtk git reset --hard HEAD'],
    ['time-wrapped reset --hard', 'time git reset --hard'],
    ['env-assignment-wrapped clean -fd', 'env FOO=bar git clean -fd'],
    ['nice -n N wrapped stash', 'nice -n 5 git stash'],
    ['command-wrapped checkout .', 'command git checkout .'],
    ['nohup-wrapped restore .', 'nohup git restore .'],
    ['sudo -u <user> value-flag checkout .', 'sudo -u marsh git checkout .'],
    ['nested wrappers (time rtk) reset --hard', 'time rtk git reset --hard'],
    // EI-18215743778965613 (self-caught 2026-07-20): `pop`/`apply` and a
    // scoped `push -- <path>` used to be exempted — but the stash is a SINGLE
    // shared LIFO stack, so a scoped push followed by `pop` popped an
    // UNRELATED entry, conflicting in files never touched by the caller.
    ['stash pop', 'git stash pop'],
    ['stash apply', 'git stash apply'],
    ['stash push with an explicit `--` path (no longer exempt — see EI-18215743778965613)', 'git stash push -- path/to/file.ts'],
  ])('denies %s', (_label, command) => {
    expectGitDeny(runGate(bashCmd(command), AGENT));
  });

  it.each([
    ['checkout of an explicit single file', 'git checkout -- path/to/file.ts'],
    ['restore of an explicit single file', 'git restore path/to/file.ts'],
    ['stash list', 'git stash list'],
    ['stash show', 'git stash show'],
    ['stash drop', 'git stash drop'],
    ['stash branch', 'git stash branch wip-x'],
    ['stash clear', 'git stash clear'],
    ['clean dry-run (no f flag)', 'git clean -n'],
    ['reset (no --hard)', 'git reset HEAD~1'],
    ['reset --soft', 'git reset --soft HEAD~1'],
    ['ordinary status', 'git status'],
    ['ordinary diff', 'git diff --stat'],
    ['"reset --hard" only in a commit message, not command position', 'git commit -m "docs: explain git reset --hard"'],
    ['"git reset --hard" inside a string arg, not command position', 'echo "git reset --hard"'],
    ['rtk-wrapped safe read (no false positive)', 'rtk git status'],
    ['time-wrapped safe read (no false positive)', 'time git log --oneline'],
    ['env-wrapped safe read (no false positive)', 'env FOO=bar git diff --stat'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  // ── EI-7872: the guard keys on the SHARED TREE, not a fragile env marker ──
  // The PAPERCUSP_AGENT_SESSION marker is silently absent in fleet-launched
  // sessions (verified 2026-07-06 in the Claude process env this hook inherits),
  // which left this rail INERT for exactly the sessions it must protect. The
  // guard now fires on cwd ∈ the canonical staging tree — WITHOUT any marker —
  // and stays exempt in the owner's own separate checkouts (a different cwd),
  // preserving the D-003 intent by TREE rather than by marker.
  it.each([
    ['reset --hard in the canonical tree', 'git reset --hard', CANON],
    ['clean -fd in a subdir of the canonical tree', 'git clean -fd', `${CANON}/apps/operator`],
    ['bare stash in the canonical tree', 'git stash', CANON],
    ['checkout . in the canonical tree', 'git checkout .', CANON],
  ])('fires WITHOUT the agent marker: %s (EI-7872 fail-open fix)', (_label, command, cwd) => {
    expectGitDeny(runGate(bashCmd(command, { cwd }), CANON_ENV));
  });

  it.each([
    ["owner's release checkout (sibling of the canonical tree)", '/ws/papercupai-workspace/papercup-release'],
    ['a name that PREFIXES the canonical tree but is a sibling', '/ws/papercupai-workspace/papercusp-staging'],
    ['an unrelated repo outside the workspace', '/tmp/some-other-repo'],
  ])('does NOT fire without the marker outside the canonical tree — %s (D-003 preserved)', (_label, cwd) => {
    expectAllow(runGate(bashCmd('git reset --hard', { cwd }), CANON_ENV));
  });

  it('still honors the agent marker even OUTSIDE the canonical tree (OR-trigger)', () => {
    expectGitDeny(runGate(bashCmd('git reset --hard', { cwd: '/tmp/elsewhere' }), { ...AGENT, ...CANON_ENV }));
  });
});

/**
 * EI-13135 — systemd user-manager exit/kill guard.
 *
 * `systemctl --user exit` tears down the WHOLE shared user@<uid> manager in
 * one shot (bg-host, :3070, :3170, gateway, git-sync, mcp-proxy, every other
 * live agent session's scope) — confirmed root cause of a ~15min fleet-wide
 * outage on 2026-07-16. UNCONDITIONAL: unlike the git-guard, this fires with
 * NO agent marker and NO tree/cwd condition at all — the resource is the
 * whole host, not a working tree, so every test here omits AGENT/CANON_ENV
 * entirely to prove that.
 */
function expectExitGuardDeny(out: { stdout: string; status: number | null }) {
  const reason = denyReason(out);
  expect(reason).toContain('EI-13135');
}

describe('systemd user-manager exit/kill guard (EI-13135)', () => {
  it.each([
    ['systemctl --user exit', 'systemctl --user exit'],
    ['systemctl exit (no --user flag)', 'systemctl exit'],
    ['systemctl --user start exit.target', 'systemctl --user start exit.target'],
    ['systemctl --user halt', 'systemctl --user halt'],
    ['systemctl --user poweroff', 'systemctl --user poweroff'],
    ['loginctl terminate-user', 'loginctl terminate-user someuser'],
    ['loginctl kill-user', 'loginctl kill-user 1000'],
    ['systemctl stop user@<uid>.service', 'systemctl stop user@1000.service'],
    ['systemctl kill user@<uid>.service', 'systemctl kill user@1000.service'],
    ['sudo-prefixed exit', 'sudo systemctl --user exit'],
    ['compound && exit', 'cd /tmp && systemctl --user exit'],
    ['compound ; halt', 'echo done ; systemctl --user halt'],
    ['newline-separated', 'true\nsystemctl --user exit'],
    ['rtk-wrapped (the same wrapper-bypass class as the git-guard)', 'rtk systemctl --user exit'],
    ['time-wrapped', 'time systemctl --user exit'],
    ['env-wrapped', 'env FOO=bar systemctl --user exit'],
  ])('denies %s — with NO agent marker, NO tree cwd', (_label, command) => {
    expectExitGuardDeny(runGate(bashCmd(command)));
  });

  it.each([
    ['status is not exit', 'systemctl --user status papercup-staging-api.service'],
    ['restart a real service is not exit', 'systemctl --user restart papercup-staging-api.service'],
    ['stop a real service is not the user@ class', 'systemctl --user stop papercup-vite.service'],
    ['"exit" only in a commit message, not command position', 'git commit -m "handle process exit"'],
    ['"systemctl --user exit" inside a quoted string, not command position', 'echo "systemctl --user exit"'],
    ['a stop of an unrelated numbered service (not user@)', 'systemctl stop worker@1000.service'],
    ['ordinary command', 'ls -la'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

/**
 * EI-18690252462401774 — pkill/killall host-wide dev-process guard.
 *
 * `pkill -f <substring>` (and `killall <name>`) match by process cmdline/name
 * SUBSTRING across the ENTIRE host process table, not scoped to the caller's
 * own PID tree. An agent cleaning up its OWN redundant backgrounded
 * `npm run test:affected` job ran `pkill -f "test:affected"` and collaterally
 * killed 5-6 OTHER agents' in-flight `test:affected` runs on this shared host
 * (2026-07-26). UNCONDITIONAL: like the systemd exit-guard above, this fires
 * with NO agent marker and NO tree/cwd condition — the hazard is host-wide
 * process-table scope, not a working tree.
 */
function expectPkillDeny(out: { stdout: string; status: number | null }) {
  const reason = denyReason(out);
  expect(reason).toContain('EI-18690252462401774');
}

describe('pkill/killall host-wide dev-process guard (EI-18690252462401774)', () => {
  it.each([
    ['pkill -f test:affected (the exact repro)', 'pkill -f "test:affected"'],
    ['pkill -f test:affected, unquoted', 'pkill -f test:affected'],
    ['killall vitest', 'killall vitest'],
    ['pkill -f npm run test', 'pkill -f "npm run test"'],
    ['pkill -f vitest', 'pkill -f vitest'],
    ['pkill -f jest', 'pkill -f jest'],
    ['pkill -f tsc', 'pkill -f tsc'],
    ['pkill node', 'pkill node'],
    ['killall -9 python3', 'killall -9 python3'],
    ['pkill -f playwright', 'pkill -f playwright'],
    ['pkill -f cargo', 'pkill -f cargo'],
    ['sudo-prefixed', 'sudo pkill -f "npm run test"'],
    ['compound &&', 'cd /tmp && pkill -f vitest'],
    ['compound ;', 'echo done ; killall vitest'],
    ['newline-separated', 'true\npkill -f test:affected'],
    ['rtk-wrapped (the same wrapper-bypass class as the git-guard)', 'rtk pkill -f vitest'],
    ['time-wrapped', 'time pkill -f test:affected'],
    ['env-wrapped', 'env FOO=bar pkill -f vitest'],
  ])('denies %s — with NO agent marker, NO tree cwd', (_label, command) => {
    expectPkillDeny(runGate(bashCmd(command)));
  });

  it.each([
    ['a genuinely unique/caller-specific pattern', 'pkill -f my-unique-script-xyz123'],
    ['killing a specific PID (the recommended remedy)', 'kill -9 12345'],
    ['killing a specific PID, plain', 'kill 12345'],
    ['read-only pgrep (not pkill/killall)', 'pgrep vitest'],
    ['prose mention, not command position', 'echo "you could pkill -f vitest here"'],
    ['a commit message mentioning it', 'git commit -m "fix: guard against pkill -f test:affected"'],
    ['ordinary command', 'ls -la'],
    ['ordinary process listing', 'ps aux | grep vitest'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

describe('owner sessions + fail-open (D-003)', () => {
  it("never fires without the agent marker — the owner's crontab is their business", () => {
    expectAllow(runGate(bashCmd('crontab -l')));
  });

  it('fail-open on malformed JSON', () => {
    expectAllow(runGate('not json {'));
  });

  it('fail-open on a missing command field', () => {
    expectAllow(runGate({ tool_name: 'Bash', tool_input: {} }, AGENT));
  });

  it('no-ops entirely when the su-token install is absent (early exit 0)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'gate-bare-'));
    try {
      const r = spawnSync('bash', [SCRIPT], {
        input: JSON.stringify(bashCmd('crontab -e')),
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: bare, ...AGENT },
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? '').trim()).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('heavy-command admission control (WI-3821)', () => {
  // Deterministic threshold so the suite never depends on the runner's core
  // count: cap at 100 and inject the "current" load1 via PC_HEAVY_LOAD1_OVERRIDE.
  const OVER = { PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: '200' };
  const UNDER = { PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: '50' };

  const expectHeavyDeny = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const decision = JSON.parse(out.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('heavy-command admission');
  };

  it.each([
    ['npm test', 'npm test'],
    ['npm run test', 'npm run test'],
    ['npm run test:affected', 'npm run test:affected'],
    ['npm run build', 'npm run build'],
    ['bare vitest', 'vitest run lib/x.test.ts'],
    ['npx vitest', 'npx vitest run lib/x.test.ts'],
    ['pnpm vitest', 'pnpm vitest'],
    ['path-invoked vitest (.bin)', '../../node_modules/.bin/vitest run app/x.test.ts'],
    ['compound cd && .bin/vitest', 'cd apps/operator && ../../node_modules/.bin/vitest run x.test.ts'],
    ['tsc --noEmit', 'tsc --noEmit'],
    ['npx tsc -p', 'npx tsc -p tsconfig.json'],
    ['turbo run test', 'turbo run test'],
    ['time-wrapped npm test', 'time npm test'],
    ['nice-wrapped vitest', 'nice -n 10 vitest run x'],
  ])('denies %s when the host is over the load threshold (agent session)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    ['npm run test:affected', 'npm run test:affected'],
    ['path-invoked vitest', '../../node_modules/.bin/vitest run app/x.test.ts'],
    ['tsc --noEmit', 'tsc --noEmit'],
  ])('allows %s when the host is UNDER the load threshold', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...UNDER }));
  });

  it.each([
    ['ordinary ls', 'ls -la'],
    ['git status', 'git status'],
    ['reading a vitest config file', 'cat vitest.config.ts'],
    ['grep for vitest in a file', 'grep vitest package.json'],
    ['vitest named only in a prose arg', 'echo "run vitest later"'],
    ['a docs path containing vitest', 'ls docs/vitest-guide'],
    ['bare tsx runs a light script (NOT heavy)', 'tsx scripts/one-shot.ts'],
    ['npm run lint (not a heavy pattern)', 'npm run lint'],
  ])('does NOT false-positive on %s even over the threshold', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('is skipped when PC_HEAVY_BYPASS=1 (the pc-heavy wrapper self-limits)', () => {
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, ...OVER, PC_HEAVY_BYPASS: '1' }));
  });

  // ── EI-9634: the two remedies the deny message itself recommends must WORK ──
  // The hook decides BEFORE the wrapped command runs, so a child-shell env
  // (`PC_HEAVY_BYPASS=1 …`) and the wrapper's own PC_HEAVY_BYPASS export aren't
  // in THIS process's env yet — so both documented escape hatches were denied
  // under the exact high load they exist for. The gate now reads them in-band
  // from the command text (no PC_HEAVY_BYPASS in the hook's own env here).
  it.each([
    ['scripts/pc-heavy.sh -- <heavy> (the primary suggested remedy)', 'scripts/pc-heavy.sh -- node_modules/.bin/vitest run lib/x.test.ts'],
    ['./scripts/pc-heavy.sh wrapping npm test', './scripts/pc-heavy.sh npm run test:affected'],
    ['bare pc-heavy.sh invocation', 'pc-heavy.sh -- vitest run x.test.ts'],
    ['pc-heavy.sh behind bash', 'bash scripts/pc-heavy.sh -- vitest run x.test.ts'],
    ['env-prefixed inline PC_HEAVY_BYPASS=1', 'env PC_HEAVY_BYPASS=1 vitest run lib/x.test.ts'],
    ['bare inline PC_HEAVY_BYPASS=1 prefix', 'PC_HEAVY_BYPASS=1 npm run test:affected'],
    ['PC_HEAVY_BYPASS=1 among other assignments', 'FOO=bar PC_HEAVY_BYPASS=1 vitest run x.test.ts'],
    // EI-10001: the deny message's own suggested remedy ("run it under
    // `scripts/pc-heavy.sh -- <your command>`") must actually work in the
    // everyday forms an agent naturally reaches for, not just the bare form.
    ['cd <dir> && scripts/pc-heavy.sh -- <heavy> (EI-10001)', 'cd packages/operator-core && scripts/pc-heavy.sh -- npx tsc --noEmit -p .'],
    ['cd "<quoted dir>" && scripts/pc-heavy.sh -- <heavy> (EI-10001)', 'cd "packages/operator-core" && scripts/pc-heavy.sh -- npx tsc --noEmit -p .'],
    ['cd <dir>; scripts/pc-heavy.sh -- <heavy> (EI-10001, semicolon separator)', 'cd packages/operator-core; scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['(scripts/pc-heavy.sh -- <heavy>) & subshell wrapper (EI-10001)', '(scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts) &'],
    ['cd <dir> && (scripts/pc-heavy.sh -- <heavy>) & both wrappers stacked (EI-10001)', 'cd packages/operator-core && (scripts/pc-heavy.sh -- npx tsc --noEmit) &'],
    ['timeout <seconds> && scripts/pc-heavy.sh -- <heavy> (EI-10439)', 'timeout 90 scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['timeout with long option && scripts/pc-heavy.sh -- <heavy> (EI-10439)', 'timeout --preserve-status 90 ./scripts/pc-heavy.sh -- npm run test:affected'],
    // WI-4547 follow-on: `set -o pipefail` was NOT in the peel set, so the whole
    // remedy collapsed the moment an agent used it — `cd d && set -o pipefail &&
    // scripts/pc-heavy.sh -- vitest` stopped peeling at `set`, never saw the
    // pc-heavy lead, and got denied as a raw vitest with a message telling it to
    // do the thing it had just done. It punished exactly the right habit, too:
    // pipefail is what stops `… | tail` from masking a real exit code (which is how
    // a failing migration run reported "exit 0" earlier the same day). `set` only
    // flips shell options — it runs no command — so peeling it is safe.
    ['set -o pipefail && scripts/pc-heavy.sh -- <heavy>', 'set -o pipefail && scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['cd <dir> && set -o pipefail && scripts/pc-heavy.sh -- <heavy> (the real-world form)', 'cd packages/operator-core && set -o pipefail && scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['set -euo pipefail; scripts/pc-heavy.sh -- <heavy> (semicolon + combined flags)', 'set -euo pipefail; scripts/pc-heavy.sh -- npm run test:affected'],
    ['set -e && set -o pipefail && scripts/pc-heavy.sh -- <heavy> (stacked sets)', 'set -e && set -o pipefail && scripts/pc-heavy.sh -- npx tsc --noEmit'],
  ])('allows the in-band bypass %s even over the threshold (EI-9634)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    // The in-band bypass must not become a free pass: a raw heavy leading a
    // chain is still gated even if a later segment wraps with pc-heavy.sh —
    // EI-10001's peel loop only strips genuinely benign wrappers (cd/(/sudo/
    // env/nice/ionice/rtk/time) that run no command of their own, so it stops
    // the instant it hits a REAL command and never reaches pc-heavy.sh.
    ['a raw heavy leading a pc-heavy chain', 'vitest run a.test.ts && scripts/pc-heavy.sh -- vitest run b.test.ts'],
    ['a raw heavy leading a pc-heavy chain, behind a cd (EI-10001 guard)', 'cd packages/operator-core && npm test && scripts/pc-heavy.sh -- vitest run b.test.ts'],
    ['timeout-wrapped raw heavy remains gated (EI-10439 guard)', 'timeout 90 npm run test:affected'],
    ['PC_HEAVY_BYPASS with the wrong value does not bypass', 'env PC_HEAVY_BYPASS=0 vitest run x.test.ts'],
    // The `set` peel must not become a free pass either: it strips the option-setting
    // builtin, then stops dead at the first REAL command.
    ['set -o pipefail && <raw heavy> stays gated', 'set -o pipefail && vitest run x.test.ts'],
    ['set -o pipefail && a raw heavy leading a pc-heavy chain stays gated', 'set -o pipefail && npm test && scripts/pc-heavy.sh -- vitest run b.test.ts'],
  ])('does NOT over-bypass %s (EI-9634 guard)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('is disabled by the PC_HEAVY_ADMISSION=off kill-switch', () => {
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, ...OVER, PC_HEAVY_ADMISSION: 'off' }));
  });

  // ── EI-10913: the documented kill-switch must WORK as an INLINE prefix ──
  // The deny message advertises `PC_HEAVY_ADMISSION=off` as the kill-switch, but
  // the gate only read it from THIS hook process's env — and an agent cannot set
  // that from a Bash call (the assignment applies to the child, not to the hook).
  // So the guard's own documented escape hatch was itself denied under the exact
  // high load it exists for. The gate now reads a leading `PC_HEAVY_ADMISSION=off`
  // prefix in-band from the command text, exactly parallel to the PC_HEAVY_BYPASS=1
  // in-band remedy (EI-9634). Recurrence guards — these fail against the pre-fix hook.
  it.each([
    ['bare PC_HEAVY_ADMISSION=off prefix', 'PC_HEAVY_ADMISSION=off npm run test:affected'],
    ['inline off in front of a bare vitest', 'PC_HEAVY_ADMISSION=off vitest run lib/x.test.ts'],
    ['env-prefixed inline off', 'env PC_HEAVY_ADMISSION=off npm run test:affected'],
    // The EXACT repro from the item body: the message told the agent to run it
    // under pc-heavy.sh AND named PC_HEAVY_ADMISSION=off, and both were rejected.
    ['PC_HEAVY_ADMISSION=off scripts/pc-heavy.sh -- <heavy> (the item repro)', 'PC_HEAVY_ADMISSION=off scripts/pc-heavy.sh -- node_modules/.bin/vitest run lib/x.test.ts'],
    ['cd <dir> && PC_HEAVY_ADMISSION=off <heavy>', 'cd packages/operator-core && PC_HEAVY_ADMISSION=off npx tsc --noEmit -p .'],
    ['PC_HEAVY_ADMISSION=off among other assignments', 'FOO=bar PC_HEAVY_ADMISSION=off vitest run x.test.ts'],
    // The env read lower-cases and accepts off/0/false/no — the inline form must
    // accept the same value set (value case-insensitive, var name literal).
    ['uppercase value PC_HEAVY_ADMISSION=OFF', 'PC_HEAVY_ADMISSION=OFF vitest run x.test.ts'],
    ['numeric off PC_HEAVY_ADMISSION=0', 'PC_HEAVY_ADMISSION=0 npm test'],
    ['PC_HEAVY_ADMISSION=false', 'PC_HEAVY_ADMISSION=false vitest run x.test.ts'],
    ['PC_HEAVY_ADMISSION=no', 'PC_HEAVY_ADMISSION=no npm run build'],
  ])('allows the inline kill-switch %s even over the threshold (EI-10913)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    // Not a free pass: `=on` is NOT an off-value, so my value alternation must
    // reject it and leave the command gated. Use the `env`-prefixed form so the
    // heavy detector actually sees the wrapped `vitest` as heavy (a BARE
    // `KEY=val vitest` prefix was never recognized as heavy by the detector's
    // anchor to begin with — that gap predates this fix) — this exercises the
    // off/0/false/no vs on discrimination in the new inline check directly.
    ['env PC_HEAVY_ADMISSION=on does not bypass', 'env PC_HEAVY_ADMISSION=on vitest run x.test.ts'],
    ['env PC_HEAVY_ADMISSION=onward (not an off-value) does not bypass', 'env PC_HEAVY_ADMISSION=onward vitest run x.test.ts'],
    // The prefix must be at command position — hidden after a real heavy op it
    // does not un-gate the leading heavy command.
    ['inline off after a raw heavy stays gated', 'vitest run a.test.ts && PC_HEAVY_ADMISSION=off vitest run b.test.ts'],
  ])('does NOT over-bypass %s (EI-10913 guard)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('never throttles the owner (no agent marker, outside the canonical tree)', () => {
    expectAllow(runGate(bashCmd('npm run test:affected', { cwd: '/tmp/not-canonical' }), { ...CANON_ENV, ...OVER }));
  });

  it('fires WITHOUT the agent marker inside the canonical tree (EI-7872 tree-keyed parity)', () => {
    expectHeavyDeny(runGate(bashCmd('npm run test:affected', { cwd: CANON }), { ...CANON_ENV, ...OVER }));
  });

  it('honors the codex shell tool name (exec_command) — same wire contract', () => {
    expectHeavyDeny(runGate(bashCmd('npm run test:affected', { tool: 'exec_command' }), { ...AGENT, ...OVER }));
  });

  it('fails open (allows) when load cannot be read', () => {
    // A non-numeric override forces the load-read to throw → fail-open allow.
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: 'not-a-number' }));
  });
});

describe('compound `cd <canonical> && …` coverage (WI-3853 — marker-less fleet sessions)', () => {
  // The OUTER cwd is outside the canonical tree; the command cds INTO it. A
  // fleet-launched session carries no PAPERCUSP_AGENT_SESSION marker (EI-7872),
  // so only the tree check can catch these — and it must follow the leading cd.
  const OUTSIDE = '/tmp/outside-canonical';
  const OVER = { PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: '200' };
  const expectHeavyDeny = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toContain('heavy-command admission');
  };

  it('git-guard fires on `cd <canonical> && git reset --hard` from a marker-less session', () => {
    expectGitDeny(runGate(bashCmd(`cd ${CANON} && git reset --hard`, { cwd: OUTSIDE }), CANON_ENV));
  });

  it('git-guard resolves a simply-quoted cd target', () => {
    expectGitDeny(runGate(bashCmd(`cd "${CANON}" && git clean -fd`, { cwd: OUTSIDE }), CANON_ENV));
  });

  it('git-guard does NOT fire when the cd targets a DIFFERENT tree (no false positive)', () => {
    expectAllow(runGate(bashCmd('cd /some/other/repo && git reset --hard', { cwd: OUTSIDE }), CANON_ENV));
  });

  it('admission gate denies `cd <canonical> && npm run test:affected` (marker-less, over threshold)', () => {
    expectHeavyDeny(runGate(bashCmd(`cd ${CANON} && npm run test:affected`, { cwd: OUTSIDE }), { ...CANON_ENV, ...OVER }));
  });

  it('admission gate does NOT gate a heavy command that cds into a DIFFERENT tree', () => {
    expectAllow(runGate(bashCmd('cd /some/other/repo && npm run test:affected', { cwd: OUTSIDE }), { ...CANON_ENV, ...OVER }));
  });

  it('a bare `cd` with no path does not throw / falls through to allow', () => {
    expectAllow(runGate(bashCmd('cd && npm run test:affected', { cwd: OUTSIDE }), { ...CANON_ENV, ...OVER }));
  });
});

describe('long-foreground-exec advisory (coord-delivery-residual-gaps P-003)', () => {
  // Claude-Bash-only soft nudge: explicit foreground timeout > 120s → allow
  // WITH additionalContext advising run_in_background (same-session detach).
  // Never a deny; never fired for backends without the native primitive.
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('run_in_background');
    expect(hso.additionalContext).toContain('THIS session');
  };

  it('fires on Claude Bash with an explicit foreground timeout > 120s', () => {
    expectAdvisory(runGate(bashWithInput({ command: 'npm ci', timeout: 300_000 })));
  });

  it('names the requested duration in seconds', () => {
    const out = runGate(bashWithInput({ command: 'sleep 400', timeout: 400_000 }));
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('400s');
  });

  it('silent when the call is already backgrounded', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 300_000, run_in_background: true })));
  });

  it('silent at/under the 120s default (no explicit long-hold intent)', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 120_000 })));
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 5_000 })));
  });

  it('silent when no timeout is requested at all', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci' })));
  });

  it('does NOT nudge codex shells — no native background primitive there', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 300_000 }, tool)));
    }
  });

  it('a deny gate still WINS over the advisory (advisory never masks a block)', () => {
    const out = runGate(
      { tool_name: 'Bash', tool_input: { command: 'crontab -e', timeout: 300_000 }, session_id: 's-test' },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a non-numeric timeout never fires or throws', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 'lots' })));
  });
});

describe('background-pipe exit-code trap advisory (EI-8871/EI-14065)', () => {
  // A backgrounded `cmd | tail/head/grep` reports the PIPE's last-stage exit
  // code in the completion notification, not the real command's — soft nudge
  // only, never a deny.
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectPipeAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('background-pipe exit-code advisory');
    expect(hso.additionalContext).toContain('tail/head/grep');
  };

  it('fires on a backgrounded `cmd | tail -N`', () => {
    expectPipeAdvisory(
      runGate(bashWithInput({ command: 'npm run test:affected 2>&1 | tail -100', run_in_background: true })),
    );
  });

  it('fires on a backgrounded `cmd | head`', () => {
    expectPipeAdvisory(runGate(bashWithInput({ command: 'rsync -av a b 2>&1 | head -50', run_in_background: true })));
  });

  it('fires on a backgrounded `cmd | grep`', () => {
    expectPipeAdvisory(runGate(bashWithInput({ command: 'ssh host cmd | grep error', run_in_background: true })));
  });

  it('silent when NOT backgrounded (foreground pipe reads the output directly)', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm run test:affected 2>&1 | tail -100' })));
  });

  // EI-18686555459167489: the list was tail/head/grep only, so the most natural
  // idiom for a LONG verification run (tee the output to a log, count the
  // errors, slice it with sed) walked straight through and still produced a
  // false "exit code 0". These are the stages that actually showed up in the
  // incident class, and every one of them exits 0 regardless of upstream.
  it.each([
    ['tee (save the output AND see it — the most likely miss)', 'npx tsc --noEmit 2>&1 | tee /tmp/tsc.log'],
    ['wc (count the errors)', 'npx tsc --noEmit 2>&1 | wc -l'],
    ['sed (slice the output)', "npm run build 2>&1 | sed -n '1,40p'"],
    ['awk', 'npm test 2>&1 | awk "{print $1}"'],
    ['sort', 'npm test 2>&1 | sort'],
    ['uniq', 'npm test 2>&1 | uniq -c'],
    ['cut', 'npm test 2>&1 | cut -d: -f1'],
    ['jq', 'npm test --json 2>&1 | jq .'],
    ['cat', 'npm test 2>&1 | cat'],
  ])('fires on a backgrounded pipe into %s', (_label, command) => {
    expectPipeAdvisory(runGate(bashWithInput({ command, run_in_background: true })));
  });

  it('still fires when the masking stage is reached via a path', () => {
    expectPipeAdvisory(
      runGate(bashWithInput({ command: 'npm test 2>&1 | /usr/bin/tee /tmp/x.log', run_in_background: true })),
    );
  });

  it('still silent when a widened stage is used but the caller handles pipefail', () => {
    expectAllow(
      runGate(
        bashWithInput({
          command: 'set -o pipefail; npx tsc --noEmit 2>&1 | tee /tmp/tsc.log',
          run_in_background: true,
        }),
      ),
    );
  });

  it('does not false-positive on a widened stage name appearing as a plain argument', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm test -- --reporter=tee', run_in_background: true })));
  });

  it('silent for a plain backgrounded command with no pipe', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm run test:affected > /tmp/x.log 2>&1', run_in_background: true })));
  });

  it('does NOT confuse `||` with a real pipe', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm test || echo failed', run_in_background: true })));
  });

  it('silent when the caller already applies `set -o pipefail`', () => {
    expectAllow(
      runGate(
        bashWithInput({
          command: 'set -o pipefail; npm run test:affected 2>&1 | tail -100',
          run_in_background: true,
        }),
      ),
    );
  });

  it('silent when the caller already captures PIPESTATUS', () => {
    expectAllow(
      runGate(
        bashWithInput({
          command: 'npm test 2>&1 | tail -20; echo "EXIT=${PIPESTATUS[0]}"',
          run_in_background: true,
        }),
      ),
    );
  });

  it('does not false-positive on a pipe-to-tail token INSIDE quotes', () => {
    expectAllow(
      runGate(
        bashWithInput({ command: 'grep -E "a|tail" some-file.ts', run_in_background: true }),
      ),
    );
  });

  it('does NOT nudge codex shells — no native background primitive there', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectAllow(runGate(bashWithInput({ command: 'npm test 2>&1 | tail -20', run_in_background: true }, tool)));
    }
  });

  it('a deny gate still WINS over the pipe advisory', () => {
    const out = runGate(
      { tool_name: 'Bash', tool_input: { command: 'crontab -e | tail', run_in_background: true }, session_id: 's-test' },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-15605 — tauri-agent-tools raw-JSON --token advisory.
 *
 * The dev-bridge token file (/tmp/tauri-dev-bridge-<pid>.token) is JSON
 * (`{"port":N,"token":"...","pid":N}`), not a bare token string. Piping its
 * raw content straight into `--token` silently fails auth even though the
 * token itself is correct inside that JSON. Soft advisory only (never a
 * deny) — the CLI is third-party/global, so we cannot fix its own error
 * message; this just saves the failed-attempt detour.
 */
describe('tauri-agent-tools raw-JSON --token advisory (EI-15605)', () => {
  const expectTokenAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('tauri-agent-tools --token advisory');
    expect(hso.additionalContext).toContain('is JSON');
  };

  it('fires on the inline raw-cat repro (`--token "$(cat …/*.token)"`)', () => {
    expectTokenAdvisory(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token "$(cat /tmp/tauri-dev-bridge-1234.token)" 'document.title'`)),
    );
  });

  it('fires on an unquoted inline raw-cat substitution', () => {
    expectTokenAdvisory(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token $(cat /tmp/tauri-dev-bridge-1234.token) 'x'`)),
    );
  });

  it('fires on the assign-then-use form (TOK=$(cat …/*.token); … --token "$TOK")', () => {
    expectTokenAdvisory(
      runGate(
        bashCmd(
          'TOK=$(cat /tmp/tauri-dev-bridge-1234.token)\n' +
            `tauri-agent-tools eval --port 46423 --token "$TOK" 'x'`,
        ),
      ),
    );
  });

  it('silent when the value is already extracted via jq', () => {
    expectAllow(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token "$(jq -r .token /tmp/tauri-dev-bridge-1234.token)" 'x'`)),
    );
  });

  it('silent when the value is already extracted via node/JSON.parse', () => {
    expectAllow(
      runGate(
        bashCmd(
          `tauri-agent-tools eval --port 46423 --token "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' /tmp/tauri-dev-bridge-1234.token)" 'x'`,
        ),
      ),
    );
  });

  it('silent for a plain bare token value (the correct usage)', () => {
    expectAllow(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token tok-abc123 'x'`)),
    );
  });

  it('silent when --token is absent (auto-discovery / --pid usage)', () => {
    expectAllow(runGate(bashCmd(`tauri-agent-tools probe`)));
  });

  it('silent for a cat on a non-.token file', () => {
    expectAllow(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token "$(cat /tmp/some-other-file.txt)" 'x'`)),
    );
  });

  it('a deny gate (e.g. the target guard) still wins over the token advisory', () => {
    // No --pid and no bridges live: the target guard itself allows here (per
    // its own "nothing to hit" rule), so assert the DECISION is allow — this
    // just confirms the advisory path never OVERRIDES a deny when one fires.
    // (Covered structurally: deny() calls sys.exit(0) before this block runs.)
    const out = runGate(
      bashCmd('crontab -e'),
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-18664655909328670 — shell-write file-target guard.
 *
 * Raw shell writes to tree files (`cat >>`, `echo >`, `tee`, `sed -i`, `cp`)
 * bypass the Edit/Write PreToolUse hooks entirely: no file lock is claimed,
 * and if the session cwd has silently drifted the write does not error — it
 * silently CREATES a stray file (repro'd live 2026-07-25: an agent appended
 * via `cat >> tools/conversations-list.test.ts` believing cwd was a package
 * subdir; cwd had drifted to the repo root, which also has a `tools/`, so
 * the redirect silently created a stray file there instead of erroring).
 *
 * UNCONDITIONAL like the exit-guard: it keys on the resolved TARGET path
 * resolving inside the canonical tree, not on the agent marker or cwd, so
 * every test below explicitly asserts this fires with NO agent marker too.
 */
describe('shell-write file-target guard (EI-18664655909328670)', () => {
  const expectShellWriteDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('denies the exact cwd-drift repro: `cat >> file <<EOF` whose target resolves inside the canonical tree', () => {
    const command = "cat >> tools/conversations-list.test.ts <<'EOF'\nsome appended content\nEOF";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('tools/conversations-list.test.ts');
    expect(reason).toMatch(/shell redirect \(`>>`\)/);
  });

  it('denies a plain `echo > file` redirect into the tree', () => {
    expectShellWriteDeny(
      runGate(bashCmd('echo hi > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
  });

  it('denies `tee` writing into the tree', () => {
    const reason = expectShellWriteDeny(
      runGate(bashCmd('echo hi | tee apps/operator/foo.txt', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(/`tee`/);
  });

  it('denies `sed -i` editing a tree file in place', () => {
    const reason = expectShellWriteDeny(
      runGate(bashCmd("sed -i 's/a/b/' apps/operator/foo.ts", { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(/`sed -i`/);
  });

  it('denies `cp` copying a file into the tree', () => {
    const reason = expectShellWriteDeny(
      runGate(bashCmd('cp /tmp/x.ts apps/operator/foo.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(/`cp`/);
  });

  it('fires WITH NO agent marker at all — unconditional, like the exit-guard', () => {
    expectShellWriteDeny(runGate(bashCmd('echo hi >> apps/operator/foo.txt', { cwd: CANON }), CANON_ENV));
  });

  it.each([
    ['redirect to /tmp (outside the tree)', 'echo hi > /tmp/scratch-out.txt'],
    ['append outside the tree', 'echo hi >> /tmp/notes.txt'],
    ['recursive `cp -r` (directory copy — no single-file substitute)', 'cp -r /tmp/somedir apps/operator/somedir'],
    ['`cp -a` archive copy (same recursive exemption)', 'cp -a /tmp/somedir apps/operator/somedir'],
    ['fd-duplication `2>&1` is not a file target', 'npm run build > /tmp/out.log 2>&1'],
    ['arithmetic `>=` comparison is not a redirect', '(( a >= b ))'],
    ['a quoted `>` inside a string is not a real redirect', 'echo "a > b was found"'],
    ['a quoted `tee`-looking string is not an invocation', 'echo "please tee up the report"'],
    ['a plain read-only command', 'git status'],
    ['a redirect target using shell expansion is left alone (fail-open)', 'echo hi >> "$SOME_DIR/file.txt"'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('does not fire when the resolved target is OUTSIDE the canonical tree even with a relative path', () => {
    expectAllow(runGate(bashCmd('cat >> notes.txt <<EOF\nhi\nEOF', { cwd: '/tmp/outside-canonical' }), CANON_ENV));
  });

  it('a deny gate still wins over anything else that would allow (structural: deny() exits before further checks)', () => {
    const out = runGate(bashCmd('cat >> apps/operator/foo.ts <<EOF\nx\nEOF', { cwd: CANON }), CANON_ENV);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  /**
   * EI-18683619680591304 — heredoc-body comparison/arrow operators are DATA,
   * not shell redirects. Repro'd live 2026-07-26: a heredoc'd python one-liner
   * doing `if v>100` was denied as if `100` were a redirect target resolving
   * inside the shared tree (the guard scanned the heredoc BODY for `>` tokens
   * with no awareness it was inside a heredoc at all).
   */
  it('allows a comparison operator inside a heredoc python script (`v>100`) — the exact repro', () => {
    const command =
      "python3 - <<'PY'\n" +
      'per = {"a": 50, "b": 150}\n' +
      'print(sum(1 for v in per.values() if v>100))\n' +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it.each([
    ['a bare `>` comparison (`x > y`)', 'if x > y:'],
    ['a fat-arrow (`=>`)', 'const f = (x) => x + 1;'],
    ['a thin-arrow (`->`)', 'def f(x) -> int:'],
    ['a `>=` comparison', 'if v >= 100:'],
    ['a real filename-looking token following `>`', 'echo "not a redirect: report.txt > 5"'],
  ])('allows heredoc body text containing %s', (_label, bodyLine) => {
    const command = `cat <<'EOF'\n${bodyLine}\nEOF`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('an UNQUOTED heredoc delimiter body is stripped the same way', () => {
    const command = 'node <<EOF\nconsole.log(1 > 2 ? "a" : "b");\nEOF';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('a genuine redirect on the heredoc START line still denies (the strip only removes the BODY)', () => {
    const command = "cat >> apps/operator/generated.ts <<'PY'\nprint(1 > 2)\nPY";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('a real redirect AFTER a heredoc closes still denies (text past the terminator is not swallowed)', () => {
    const command = "cat <<'EOF'\nharmless body\nEOF\necho hi > apps/operator/after-heredoc.ts";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/after-heredoc.ts');
  });

  it('a bare numeric target with NO heredoc at all is still not treated as a path (looks-like-a-path heuristic)', () => {
    // `(( v>100 ))` arithmetic — quote-stripping never touches this, so the
    // looks-like-a-path check is the only thing standing between this and a
    // false deny; already covered structurally by the existing `(( a >= b ))`
    // allow-case above, this asserts the un-`=`-suffixed `>100` form too.
    expectAllow(runGate(bashCmd('echo $(( 1 > 100 ))', { cwd: CANON }), CANON_ENV));
  });
});

/**
 * EI-18691482279179647 — interpreter inline-code write guard.
 *
 * The shell-write guard above only recognizes SHELL write constructs
 * (`>`/`>>`, `tee`, `sed -i`, `cp`). An interpreter invoked with inline code
 * (`python3 -c`, `node -e`, or a `python3 - <<EOF … EOF` heredoc script) does
 * its own file I/O — invisible to shell-redirect detection — and sailed
 * straight through with no lock claimed and no worktree validation
 * (self-caught live 2026-07-26 rewriting a tree file via a heredoc'd python
 * script). Also covers the `perl -i`/`ruby -i` in-place-flag half, added as
 * a new leg on the existing shell-write guard's target extraction.
 */
describe('interpreter inline-code write guard (EI-18691482279179647)', () => {
  const expectInterpDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('denies the exact repro: a python3 heredoc script writing a literal tree path via open(...)', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "s2 = open('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts').read()\n" +
      "open('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts', 'w').write(s2)\n" +
      'EOF';
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts');
    expect(reason).toContain('python3');
  });

  it('denies `python3 -c "..."` with an inline literal tree-path write', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('denies `node -e "..."` with fs.writeFileSync targeting a literal tree path', () => {
    const command = `node -e "require('fs').writeFileSync('apps/operator/generated.ts', data)"`;
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('node');
  });

  it('denies `perl -i` editing a tree file in place (the in-place-flag leg, same as `sed -i`)', () => {
    const out = runGate(bashCmd("perl -i -pe 's/a/b/' apps/operator/foo.pl", { cwd: CANON }), CANON_ENV);
    const reason = denyReason(out);
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).toMatch(/perl -i.*ruby -i/);
  });

  it('denies `ruby -i` editing a tree file in place', () => {
    const out = runGate(bashCmd("ruby -i.bak -pe 'gsub!(/a/,\"b\")' apps/operator/foo.rb", { cwd: CANON }), CANON_ENV);
    expect(denyReason(out)).toContain('EI-18664655909328670');
  });

  it('fires WITH NO agent marker at all — unconditional, like the shell-write guard', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows the exact pre-existing v>100 heredoc repro (EI-18683619680591304) — no literal tree path in the body', () => {
    const command =
      "python3 - <<'PY'\n" +
      'per = {"a": 50, "b": 150}\n' +
      'print(sum(1 for v in per.values() if v>100))\n' +
      "PY";
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows a READ-ONLY interpreter script that merely references a literal tree path (no write call) — the exact false-positive this guard self-caught during its own fix', () => {
    // A read-only syntax-check idiom: read a tree file's content, parse it,
    // print a result — no open(...,'w')/write(/writeFileSync anywhere. This
    // must stay allowed: a read needs no lock, and the ORIGINAL guard did
    // deny this before the write-indicator requirement was added, blocking
    // this test suite's own author mid-verification.
    const command =
      "python3 -c \"\n" +
      "with open('apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh') as f:\n" +
      "    content = f.read()\n" +
      "print(len(content))\n" +
      '"';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it.each([
    ['a python3 -c write targeting /tmp (outside the tree)', `python3 -c "open('/tmp/scratch.txt', 'w').write('x')"`],
    ['a node -e write targeting ~/.papercusp/scratch', `node -e "require('fs').writeFileSync('/home/x/.papercusp/scratch/out.json', '{}')"`],
    ['a plain `node script.js` — the code lives in a real (Edit-locked) file, not inline', 'node apps/operator/script.js'],
    ['a plain `python3 file.py` with no -c/-e/heredoc', 'python3 apps/operator/tool.py --flag'],
    ['python3 -c with no path literal at all', `python3 -c "print(1 + 1)"`],
    ['a read-only python3 -c (no write call, no tree path)', `python3 -c "import sys; print(sys.version)"`],
    ['a redirect target using shell expansion is left alone (fail-open)', `python3 -c "open(sys.argv[1], 'w')" "$SOME_PATH"`],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('does not fire when the resolved target is OUTSIDE the canonical tree even with a relative path', () => {
    const command = "python3 -c \"open('notes.txt', 'w').write('x')\"";
    expectAllow(runGate(bashCmd(command, { cwd: '/tmp/outside-canonical' }), CANON_ENV));
  });
});

// ── Substitution gate (bash-to-tool-substitution-2026-07-26, P-016) ─────────
// Two distinct things are under test and they fail differently:
//   1. the PRE-FILTER — does a command a registry rule could claim actually
//      reach the operator? A pre-filter miss is SILENT: no error, just an
//      advisory that never fires for the commands it was written for.
//   2. the VERDICT HANDLING — given a substitution payload, does `advise` ride
//      out as a non-blocking additionalContext and `deny` actually deny?
describe('substitution pre-filter', () => {
  // With OPERATOR_URL pointed at a dead port, a command that PASSES the
  // pre-filter attempts HTTP and fails open with a diagnostic on stderr, while
  // one filtered out returns in silence. That difference is the probe.
  const reachedOperator = (out: { stderr: string }) => out.stderr.includes('operator unreachable');

  it.each([
    ['sed range read', "sed -n '1,80p' packages/foo.ts"],
    ['sed behind a cd', "cd /repo && sed -n '1,80p' packages/foo.ts"],
    ['cat a file', 'cat packages/operator-core/lib/foo.ts'],
    ['head a file', 'head -n 20 packages/foo.ts'],
    ['tail a file', 'tail -n 50 packages/foo.ts'],
    ['psql select', 'psql -d papercusp -c "SELECT 1"'],
    ['behind sudo', "sudo sed -n '1,5p' /etc/hosts"],
    ['behind an env assignment', 'FOO=bar cat notes.txt'],
    ['second atom in a pipeline', 'echo hi; cat notes.txt'],
  ])('routes %s to the operator', (_label, command) => {
    expect(reachedOperator(runGate(bashCmd(command)))).toBe(true);
  });

  it.each([
    ['a plain listing', 'ls -la'],
    ['a word merely CONTAINING a verb', 'echo concatenate the duplicates'],
    ['a path merely containing a verb', 'node scripts/cat-herder.mjs'],
    ['an unrelated npm script', 'npm run lint'],
  ])('does NOT pay an HTTP round-trip for %s', (_label, command) => {
    const out = runGate(bashCmd(command));
    expect(reachedOperator(out)).toBe(false);
    expectAllow(out);
  });

  // THE ANTI-DRIFT GUARD. The pre-filter keeps a hand-written verb set, and a
  // registry pair whose verb is missing from it is enforced nowhere while every
  // other test stays green. This replays the REAL atoms behind every recorded
  // equivalence verdict — the same frozen corpus those verdicts were computed
  // from — and asserts each still reaches the operator. Add a pair without
  // adding its verb and this goes red.
  // __tests__ → cc → hooks → scripts → operator → apps → repo root (six).
  const FIXTURE_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../packages/operator-core/lib/bash-substitution/fixtures',
  );

  it('every atom behind a recorded verdict passes the pre-filter', () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.sample.json'));
    expect(files.length).toBeGreaterThan(0);

    const missed: string[] = [];
    for (const file of files) {
      const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as {
        sample: { atom: string }[];
      };
      for (const { atom } of fixture.sample) {
        if (!reachedOperator(runGate(bashCmd(atom)))) missed.push(`${file}: ${atom}`);
      }
    }
    expect(missed, `pre-filter dropped atoms a registry rule claims:\n${missed.join('\n')}`).toEqual(
      [],
    );
  });
});

describe('substitution verdict handling', () => {
  // A stand-in operator returning a real MCP envelope, so the hook's own
  // response parsing is exercised rather than mocked away.
  //
  // It MUST run in a separate process. runGate uses spawnSync, which blocks
  // this process's event loop for the whole hook run — an in-process server
  // could never accept the connection, so every case would hang until the
  // hook's 4s HTTP timeout and then fail open, and the suite would report
  // "allow" everywhere while testing nothing. (Cost an initial round of four
  // confusing "Unexpected end of JSON input" failures.)
  //
  // The desired reply is passed through a FILE the server re-reads per request,
  // so a test can change it without restarting the child.
  let child: ReturnType<typeof spawn>;
  let url = '';
  let replyFile = '';
  const setReply = (r: Record<string, unknown>) =>
    writeFileSync(replyFile, JSON.stringify({ ok: true, ...r }));

  beforeAll(async () => {
    replyFile = join(fakeHome, 'reply.json');
    setReply({ decision: 'allow', matched: [] });
    const serverJs = join(fakeHome, 'fake-operator.mjs');
    writeFileSync(
      serverJs,
      `import { createServer } from 'node:http';
       import { readFileSync } from 'node:fs';
       const s = createServer((req, res) => {
         req.resume();
         req.on('end', () => {
           const body = readFileSync(process.argv[2], 'utf8');
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ jsonrpc: '2.0', id: 1,
             result: { content: [{ type: 'text', text: body }] } }));
         });
       });
       s.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));`,
    );

    child = spawn(process.execPath, [serverJs, replyFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    url = await new Promise<string>((ok, fail) => {
      const t = setTimeout(() => fail(new Error('fake operator did not start')), 10_000);
      child.stdout!.on('data', (b: Buffer) => {
        const m = /PORT=(\d+)/.exec(String(b));
        if (m) {
          clearTimeout(t);
          ok(`http://127.0.0.1:${m[1]}`);
        }
      });
    });
  });

  afterAll(() => {
    child?.kill();
  });

  const CAT = 'cat packages/operator-core/lib/foo.ts';
  const SUB = {
    intentLabel: 'file-whole-read',
    toolName: 'capability:read',
    tier: 'advise',
    advisoryText: 'capability:read { file_path } returns the whole file.',
    atom: CAT,
  };
  const run = (command = CAT) => runGate(bashCmd(command), { PAPERCUSP_OPERATOR_URL: url });

  it('tier=advise rides out as a NON-BLOCKING additionalContext', () => {
    setReply({ decision: 'allow', matched: [], substitutions: [SUB], substitutionTier: 'advise' });
    const out = run();
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('allow'); // the command still runs
    expect(hook.additionalContext).toContain('capability:read');
    expect(hook.additionalContext).toContain('proceeding as issued');
  });

  it('tier=observe changes nothing the agent sees', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB, tier: 'observe' }],
      substitutionTier: 'observe',
    });
    expectAllow(run());
  });

  it('tier=deny blocks and names the tool to use instead', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB, tier: 'deny' }],
      substitutionTier: 'deny',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('capability:read');
  });

  it('an in-flight RESOURCE hold outranks a substitution advisory', () => {
    // A lock collision is happening right now; tool-choice guidance is not.
    // Burying the urgent message under the educational one is the failure.
    setReply({
      decision: 'block',
      matched: [{ resource: 'dev:restart' }],
      substitutions: [SUB],
      substitutionTier: 'advise',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('resource-gate');
  });

  it('degrades to pre-P-016 behaviour when the payload carries no substitutions', () => {
    setReply({ decision: 'allow', matched: [] });
    expectAllow(run());
  });

  it('never wedges a command on a malformed substitutions payload', () => {
    setReply({ decision: 'allow', matched: [], substitutions: 'not-an-array', substitutionTier: 'advise' });
    const out = run();
    expect(out.status).toBe(0);
    if (out.stdout.trim()) {
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    }
  });
});

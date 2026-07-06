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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  return { stdout: r.stdout ?? '', status: r.status };
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
const bashCmd = (command: string, tool = 'Bash') => ({
  tool_name: tool,
  tool_input: { command },
  session_id: 's-test',
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
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  it('accepts codex shell tool names (exec_command) — same wire contract', () => {
    expectDeny(runGate(bashCmd('crontab -l', 'exec_command'), AGENT));
  });

  it('ignores non-shell tools even in agent sessions', () => {
    expectAllow(runGate({ tool_name: 'Edit', tool_input: { file_path: '/x' } }, AGENT));
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
  ])('denies %s', (_label, command) => {
    expectGitDeny(runGate(bashCmd(command), AGENT));
  });

  it.each([
    ['checkout of an explicit single file', 'git checkout -- path/to/file.ts'],
    ['restore of an explicit single file', 'git restore path/to/file.ts'],
    ['stash pop', 'git stash pop'],
    ['stash apply', 'git stash apply'],
    ['stash list', 'git stash list'],
    ['stash show', 'git stash show'],
    ['stash drop', 'git stash drop'],
    ['stash branch', 'git stash branch wip-x'],
    ['stash clear', 'git stash clear'],
    ['stash push with an explicit `--` path', 'git stash push -- path/to/file.ts'],
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

  it("never fires without the agent marker — the owner's own tree-cleaning is their business (D-003 exemption mirrors the scheduler lockout)", () => {
    expectAllow(runGate(bashCmd('git reset --hard')));
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

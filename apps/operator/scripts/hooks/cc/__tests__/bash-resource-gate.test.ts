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
    ['PC_HEAVY_BYPASS with the wrong value does not bypass', 'env PC_HEAVY_BYPASS=0 vitest run x.test.ts'],
  ])('does NOT over-bypass %s (EI-9634 guard)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('is disabled by the PC_HEAVY_ADMISSION=off kill-switch', () => {
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, ...OVER, PC_HEAVY_ADMISSION: 'off' }));
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

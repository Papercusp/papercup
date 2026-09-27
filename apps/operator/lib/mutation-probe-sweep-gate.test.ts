/**
 * `scripts/mutation-probe.sh` — the sweep-race gate on `--in-tree`.
 *
 * WHY THIS FILE EXISTS (EI-18701398718982653): the probe script is the repo's
 * sanctioned way to prove a guard is falsifiable, and `--in-tree` is its one
 * mode that leaves a deliberately-wrong state in the SHARED tracked tree.
 * git-sync commits that tree on a short cadence, so a probe outliving one tick
 * gets its mutant committed — a committed RED test freezes every agent's
 * deploys. The script cannot take the lock itself (it lives in Postgres behind
 * an authed door), so the next best thing is that it refuses to proceed until
 * the caller has DECIDED what to do about the sweep. Before this gate the same
 * information was a log line printed while the mutation was already under way.
 *
 * Every case below drives the REAL script against a throwaway git repo under
 * os.tmpdir(), never against this checkout — the same copy-out discipline the
 * script itself prescribes (CLAUDE.md § "Proving a guard is falsifiable").
 *
 * FALSIFIABILITY: the subject path is overridable via MUTATION_PROBE_SCRIPT, so
 * this suite can be pointed at a mutated COPY of the script:
 *
 *   scripts/mutation-probe.sh \
 *     --file scripts/mutation-probe.sh \
 *     --fake-destructive \
 *     --mutate 's/^if \[ "\$IN_TREE" -eq 1 \] && \[ -z "\$SWEEP_ACK" \]; then/if false; then/' \
 *     --test 'MUTATION_PROBE_SCRIPT={} npm run test:file -- apps/operator/lib/mutation-probe-sweep-gate.test.ts'
 *
 * That run mutates a copy in a scratch dir; the tracked script is never dirty.
 *
 * `--fake-destructive` is REQUIRED here and is easy to omit: probing the probe
 * makes the probe its own SUBJECT, and the script's source contains the very
 * destructive primitives it scans for (rm, rmdir, shred, mkfs, `dd of=`,
 * `find -delete` — its own detection list and cleanup). The tier-0 gate
 * therefore refuses the run outright, with a message about executing deletion
 * code that reads as alarming rather than as "you are probing this script".
 * The flag only PATH-shims those executables for the guard runs; this suite
 * deletes via node's fs, so nothing here depends on them.
 *
 * READ WHICH TESTS FAIL, not just the verdict line. A genuine catch here fails
 * a PROPER SUBSET — mutating the sweep gate fails only the sweep cases,
 * mutating the parse gate fails only the two REFUSES cases. A mutant that
 * fails EVERY case usually means the mutation broke the script rather than the
 * behaviour under test, which is the exact false verdict the parse gate below
 * exists to prevent (EI-21430792829614962).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Walk up from this file to the checkout root (the dir holding `scripts/`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'scripts', 'mutation-probe.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the checkout root from ' + import.meta.url);
}

const PROBE = process.env.MUTATION_PROBE_SCRIPT
  ? resolve(process.env.MUTATION_PROBE_SCRIPT)
  : join(repoRoot(), 'scripts', 'mutation-probe.sh');

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}

let scratch: string;
let subject: string;
let fakeBin: string;
let lockLog: string;
let submoduleSource: string;

/**
 * Run the probe inside the scratch repo. `cwd` matters: the script resolves the
 * file-lock path from the repo root it is standing in, so running here also
 * proves that path is DERIVED rather than hardcoded to this checkout.
 */
function runProbe(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [PROBE, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      TMPDIR: scratch,
      // Scrub the AMBIENT value so every case below measures what the PROBE
      // does, not who launched vitest. This is not hypothetical: the
      // green-checkpoint runs the suite as `npm run test:affected` THROUGH
      // pc-heavy, and pc-heavy exports PC_HEAVY_BYPASS=1 into its whole child
      // tree (its release-gate fast path does exactly that) — so in the gate
      // this process already carries the variable the ceiling cases assert on,
      // while an interactive shell does not. MEASURED 2026-09-20: without this
      // line the copy-out case is green locally and RED in the gate. Empty is
      // the right scrub rather than "0": pc-heavy tests `= "1"`, and the probe
      // reports via `${PC_HEAVY_BYPASS:-unset}`, which treats empty as unset.
      PC_HEAVY_BYPASS: '',
      ...extraEnv,
    },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const GOOD = 'value = GOOD\n';

function runLockedProbe(
  args: string[],
  mode:
    | 'all'
    | 'no-file'
    | 'no-resource'
    | 'heartbeat-refused'
    | 'timeout-once'
    | 'heartbeat-timeout-once'
    | 'auth-failure'
    | 'input-failure' = 'all',
  extraEnv: Record<string, string> = {},
): { code: number; out: string } {
  writeFileSync(lockLog, '');
  const result = runProbe(args, {
    ...process.env,
    PATH: fakeBin + ':' + (process.env.PATH ?? ''),
    PAPERCUSP_SID: 'mutation-probe-test-session',
    PAPERCUSP_TEST_RUN_HARNESS: 'probe-harness',
    MUTATION_PROBE_WINDOW_MAX_SEC: '600',
    MUTATION_PROBE_LOCK_MODE: mode,
    MUTATION_PROBE_LOCK_LOG: lockLog,
    PAPERCUSP_OPERATOR_BASE: '',
    PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070',
    PAPERCUSP_HONO_PORT: '',
    PAPERCUSP_MCP_PROXY_BASE: '',
    PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    ...extraEnv,
  });
  // spawnSync reports null when the child died on a signal; -1 keeps that distinct from every real exit code.
  return { code: result.status ?? -1, out: result.out };
}

let mjsSubject: string;
let shSubject: string;

/**
 * A subject shaped like the one that produced the false verdict in
 * EI-21430792829614962: a function whose DECLARATION and CALL SITE share the
 * exact text `isTunnelForward(addrs, port)`, so a natural-looking mutation of
 * "the call" silently rewrites the declaration too and yields `function false`.
 * It exits 0 as written, which is what the probe's baseline gate requires.
 */
const MJS_SUBJECT = [
  "import process from 'node:process';",
  "const addrs = ['127.0.0.10'];",
  "const port = '443';",
  'function isTunnelForward(addrs, port) {',
  "  return addrs.length > 0 && port === '443';",
  '}',
  'if (isTunnelForward(addrs, port)) {',
  '  process.exit(0);',
  '}',
  'process.exit(1);',
  '',
].join('\n');

const SH_SUBJECT = [
  '#!/usr/bin/env bash',
  'if [ "1" = "1" ]; then',
  '  exit 0',
  'fi',
  'exit 1',
  '',
].join('\n');

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mutation-probe-gate-'));
  subject = join(scratch, 'subject.txt');
  writeFileSync(subject, GOOD);
  mjsSubject = join(scratch, 'subject.mjs');
  writeFileSync(mjsSubject, MJS_SUBJECT);
  shSubject = join(scratch, 'subject.sh');
  writeFileSync(shSubject, SH_SUBJECT);
  // `git hash-object` / `rev-parse --show-toplevel` need a real repo.
  const init = spawnSync('git', ['init', '-q'], { cwd: scratch, encoding: 'utf8' });
  expect(init.status, `git init failed: ${init.stderr}`).toBe(0);
});

beforeAll(() => {
  fakeBin = join(scratch, 'fake-bin');
  mkdirSync(fakeBin);
  lockLog = join(scratch, 'ptool.log');
  writeFileSync(lockLog, '');
  const fakePtool = join(fakeBin, 'ptool');
  writeFileSync(fakePtool, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "let input = '';",
    'process.stdin.on("data", (chunk) => input += chunk);',
    'process.stdin.on("end", () => {',
    '  const argv = process.argv.slice(2);',
    '  const tool = argv[0];',
    '  const args = input ? JSON.parse(input) : {};',
    '  const mode = process.env.MUTATION_PROBE_LOCK_MODE;',
    "  const projectionAt = argv.indexOf('--projection');",
    "  const projectionRaw = projectionAt >= 0 ? argv[projectionAt + 1] : undefined;",
    '  const explicitUrl = argv.find((arg) => arg.startsWith("--url="));',
    '  const targetUrl = explicitUrl ? explicitUrl.slice("--url=".length) : (process.env.PAPERCUSP_HONO_PORT ? "http://127.0.0.1:" + process.env.PAPERCUSP_HONO_PORT : (process.env.PAPERCUSP_OPERATOR_URL || "http://127.0.0.1:3070"));',
    '  if (process.env.MUTATION_PROBE_LOCK_LOG) {',
    '    fs.appendFileSync(process.env.MUTATION_PROBE_LOCK_LOG, JSON.stringify({ tool, args, projection: projectionRaw, targetUrl }) + "\\n");',
    '  }',
    // Mirror the real dispatch contract (WI-10002758): a projection must name
    // pick or pipe. The fake used to ignore --projection, so a probe sending
    // '{}' passed here while every real in-tree run was refused.
    '  if (projectionRaw !== undefined) {',
    '    let projection;',
    '    try { projection = JSON.parse(projectionRaw); } catch { projection = null; }',
    '    const valid = projection && typeof projection === "object" && (Array.isArray(projection.pick) && projection.pick.length > 0 || Array.isArray(projection.pipe) && projection.pipe.length > 0);',
    '    if (!valid) {',
    '      process.stderr.write("projection_invalid: projection needs a non-empty pick or pipe");',
    '      process.exitCode = 1;',
    '      return;',
    '    }',
    '  }',
    '  const loggedCalls = process.env.MUTATION_PROBE_LOCK_LOG ? fs.readFileSync(process.env.MUTATION_PROBE_LOCK_LOG, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];',
    '  if (mode === "timeout-once" && tool === "coord:presence" && targetUrl !== "http://127.0.0.1:3170" && loggedCalls.filter((call) => call.tool === "coord:presence" && call.targetUrl !== "http://127.0.0.1:3170").length === 1) {',
    '    process.stderr.write("ptool: tools/call coord:presence failed: MCP error -32001: Request timed out; the tool call may have executed — verify its state before retrying. Do not blindly retry a mutation.");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  if (mode === "heartbeat-timeout-once" && tool === "locks:heartbeat" && targetUrl !== "http://127.0.0.1:3170" && loggedCalls.filter((call) => call.tool === "locks:heartbeat" && call.targetUrl !== "http://127.0.0.1:3170").length === 1) {',
    '    process.stderr.write("ptool: tools/call locks:heartbeat failed: MCP error -32001: Request timed out; the tool call may have executed — verify its state before retrying. Do not blindly retry a mutation.");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  if (mode === "auth-failure" && tool === "coord:presence") {',
    '    process.stderr.write("ptool: tools/call coord:presence failed: HTTP 401 authorization_denied");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  if (mode === "input-failure" && tool === "coord:presence") {',
    '    process.stderr.write("ptool: tools/call coord:presence failed: HTTP 400 InputValidationError");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    "  if (mode === 'heartbeat-refused' && tool === 'locks:heartbeat') {",
    '    process.stderr.write("lock_not_owned: fake heartbeat refusal for the stderr-surfacing case");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  const expires = new Date(Date.now() + 3600000).toISOString();',
    "  if (tool === 'coord:presence') {",
    "    process.stdout.write(JSON.stringify({ self: { ownerId: 'probe-owner' } }));",
    "  } else if (tool === 'locks:queue') {",
    "    const active = mode === 'no-file' ? [] : [{ path: args.paths[0], owner: 'probe-owner', intent: 'mutation probe', lock_id: '33333333-3333-4333-8333-333333333333' }];",
    '    process.stdout.write(JSON.stringify({ active_locks: active }));',
    "  } else if (tool === 'locks:heartbeat') {",
    "    const extended = mode !== 'file-heartbeat-fails';",
    '    process.stdout.write(JSON.stringify({ results: [{ lock_id: args.lock_id, extended, ok: extended }] }));',
    "  } else if (tool === 'locks:list') {",
    "    const holders = mode === 'no-resource' ? [] : [{ resource: args.resource, owner: 'probe-owner', mode: 'exclusive', status: 'held', expires_ts: expires }];",
    '    process.stdout.write(JSON.stringify({ holders }));',
    "  } else if (tool === 'locks:heartbeat_resource') {",
    '    process.stdout.write(JSON.stringify({ results: [{ lock_id: args.lock_id, extended: true, ok: true }] }));',
    '  } else {',
    '    process.stderr.write("unexpected fake ptool request: " + tool);',
    '    process.exitCode = 2;',
    '  }',
    '});',
    '',
  ].join('\n'));
  chmodSync(fakePtool, 0o755);

  submoduleSource = mkdtempSync(join(tmpdir(), 'mutation-probe-submodule-'));
  git(submoduleSource, ['init', '-q']);
  git(submoduleSource, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(submoduleSource, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(join(submoduleSource, 'subject.txt'), GOOD);
  git(submoduleSource, ['add', 'subject.txt']);
  git(submoduleSource, ['commit', '-qm', 'subject baseline']);
  git(scratch, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(scratch, ['config', 'user.name', 'mutation-probe-test']);
  git(scratch, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleSource, 'nested']);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (submoduleSource) rmSync(submoduleSource, { recursive: true, force: true });
});

describe('mutation-probe.sh --in-tree sweep-race gate', () => {
  it('REFUSES --in-tree from a capability:bash foreground child before touching the tracked file', () => {
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      {
        PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '1',
        PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS: '50000',
      },
    );

    // The foreground handler kills the whole child tree at its deadline, so
    // this refusal must happen before the probe creates scratch state or
    // applies the deliberately-wrong tracked-file mutation.
    expect(status).toBe(2);
    expect(out).toContain('REFUSING --in-tree from capability:bash foreground execution');
    expect(out).toContain('captured timeout: 50000ms');
    expect(out).toContain('run_in_background: true');
    expect(out).not.toContain('mutant applied:');
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('REFUSES --in-tree with no acknowledgement, and hands over the exact lock incantation', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
    ]);

    // Exit 2 is the script's documented "misuse / could not run soundly" code.
    expect(status).toBe(2);
    expect(out).toContain('SWEEP race');
    // The refusal must be ACTIONABLE: the repo-relative file path is resolved
    // from the repo it is standing in, not copied from a doc that can drift.
    expect(out).toContain("paths: ['subject.txt']");
    expect(out).toContain('locks:acquire');
    expect(out).toContain('locks:acquire_resource');
    expect(out).toContain("intent: 'mutation probe'");
    expect(out).toContain('locks:heartbeat');
    expect(out).toContain('locks:release');
    // Both escapes must be named, or the gate is a dead end rather than a fork.
    expect(out).toContain('--sweep-lock-held');
    expect(out).toContain('--accept-sweep-race');

    // A refusal must refuse: the file is untouched and no probe ran. Assert on
    // the RESULT LINE and the mutation log, not on the bare token
    // "MUTATION_PROBE_RESULT" — the refusal text names it while explaining that
    // an accepted race gets recorded there, so the token alone cannot tell a
    // refusal apart from a completed run.
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=');
    expect(out).not.toContain('mutant applied:');
  });

  it.each(['3070', '9071'])('retries a local :%s transport timeout once through staging :3170', (port) => {
    const primaryUrl = 'http://127.0.0.1:' + port;
    const endpointEnv: Record<string, string> = port === '9071'
      ? { PAPERCUSP_HONO_PORT: port }
      : { PAPERCUSP_OPERATOR_URL: primaryUrl };
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'timeout-once',
      endpointEnv,
    );

    expect(code).toBe(0);
    expect(out).toContain('recovered once through staging :3170');
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.tool === 'coord:presence').map((call) => call.targetUrl))
      .toEqual([primaryUrl, 'http://127.0.0.1:3170']);
  });

  it('retries a same-lock heartbeat timeout through staging and verifies the extension', () => {
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'heartbeat-timeout-once',
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070' },
    );

    expect(code).toBe(0);
    expect(out).toContain('recovered once through staging :3170');
    expect(out).toContain("verified this session's live file lock");
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.tool === 'locks:heartbeat').map((call) => call.targetUrl))
      .toEqual(['http://127.0.0.1:3070', 'http://127.0.0.1:3170']);
  });

  it('does not reroute authentication or input failures to staging', () => {
    for (const mode of ['auth-failure', 'input-failure'] as const) {
      const { code, out } = runLockedProbe(
        [
          '--file', subject,
          '--mutate', 's/GOOD/BAD/',
          '--test', 'grep -q GOOD {}',
          '--in-tree',
          '--sweep-lock-held',
        ],
        mode,
      );

      expect(code).toBe(2);
      expect(out).toContain('could not read this session');
      const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0].targetUrl).toBe('http://127.0.0.1:3070');
    }
  });

  it('does not route a timeout from an explicitly pinned remote operator to local staging', () => {
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'timeout-once',
      { PAPERCUSP_OPERATOR_URL: 'https://pinned.example' },
    );

    expect(code).toBe(2);
    expect(out).toContain('could not read this session');
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].targetUrl).toBe('https://pinned.example');
  });

  it('runs under --accept-sweep-race, records the accepted race, and restores the file', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    // The acceptance is auditable in the machine-readable line, not just in a
    // log the operator may never read back.
    expect(out).toContain('target=in-tree:race-accepted');
    expect(out).toContain('tree integrity: VERIFIED');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('requires a live caller-owned lock with the probe intent before --sweep-lock-held mutates', () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ], 'no-file');

    expect(code).toBe(2);
    expect(out).toContain("no live file lock for 'subject.txt'");
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('verifies and extends the caller-owned file lock before mutation', () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ]);

    expect(code).toBe(0);
    expect(out).toContain("verified this session's live file lock for subject.txt");
    expect(out).toContain('target=in-tree:lock-held');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.tool)).toEqual(['coord:presence', 'locks:queue', 'locks:heartbeat', 'locks:list']);
    expect(calls[1].args).toMatchObject({ paths: ['subject.txt'], coordination_domain: scratch });
    expect(calls[2].args).toMatchObject({ ttl_sec: 1200, coordination_domain: scratch });
    // Every call must send a projection the real dispatch accepts (WI-10002758).
    for (const call of calls) {
      const projection = JSON.parse(call.projection);
      expect(Array.isArray(projection.pick) && projection.pick.length > 0, `${call.tool} projection ${call.projection}`).toBe(true);
    }
  });

  it("surfaces the tool's own refusal text when a lock call fails", () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ], 'heartbeat-refused');

    expect(code).toBe(2);
    // The refusal reason reaches the operator; it used to be discarded, leaving
    // only the generic "could not extend" line.
    expect(out).toContain('ptool locks:heartbeat failed (exit 1)');
    expect(out).toContain('lock_not_owned: fake heartbeat refusal');
    expect(out).toContain('could not extend the verified file lock');
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it.each(['superproject', 'submodule'] as const)('requires an exclusive harness git-sync lock when probing a %s', (kind) => {
    const nestedSubject = kind === 'submodule' ? join(scratch, 'nested', 'subject.txt') : subject;
    const refused = runLockedProbe([
      '--file', nestedSubject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ], 'no-resource');

    expect(refused.code).toBe(2);
    expect(refused.out).toContain("must hold an exclusive 'git-sync:probe-harness' lock");
    expect(refused.out).not.toContain('mutant applied:');
    expect(readFileSync(nestedSubject, 'utf8')).toBe(GOOD);

    const accepted = runLockedProbe([
      '--file', nestedSubject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ]);

    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("verified this session's exclusive git-sync:probe-harness lock");
    expect(readFileSync(nestedSubject, 'utf8')).toBe(GOOD);
  });

  it('leaves copy-out mode ungated and never dirties the tracked file', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('target=copy-out');
    expect(out).not.toContain('SWEEP race');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('rejects a sweep acknowledgement passed WITHOUT --in-tree', () => {
    // A stray ack means the caller believes they are mutating the tree when
    // they are not — accepting it silently teaches a wrong mental model.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--sweep-lock-held',
    ]);

    expect(status).toBe(2);
    expect(out).toContain('only mean something with --in-tree');
  });
});

/**
 * `scripts/mutation-probe.sh` — the unparseable-mutant gate (EI-21430792829614962).
 *
 * The probe decided its verdict purely from the guard's exit code, so a
 * mutation that corrupted the subject's SYNTAX produced a confident
 * "MUTANT CAUGHT ... the guard is falsifiable" about assertions that were
 * never exercised — the guard failed only because the subject had stopped
 * being a loadable program. That is the same false-verdict class as the
 * pre-existing no-op refusal, inverted: a no-op mutation makes a guard look
 * WEAK, an unparseable one makes it look STRONG.
 *
 * It is the more dangerous half, because a probe's whole job is to certify
 * that a test suite can be trusted. A false "weak" verdict provokes
 * investigation; a false "strong" verdict ends it.
 *
 * Both directions are asserted throughout: a broken mutant must be REFUSED,
 * and a valid semantic mutant on the same subject must still reach a normal
 * verdict. Asserting only the refusal would pass equally against a script
 * that had started refusing everything.
 */
describe('mutation-probe.sh unparseable-mutant gate', () => {
  it('REFUSES a mutant that no longer parses, instead of scoring it as caught', () => {
    // The exact shape from the field report: the pattern matches the function
    // DECLARATION as well as the call site, producing `function false {`.
    const { status, out } = runProbe([
      '--file', mjsSubject,
      '--mutate', 's/isTunnelForward\\(addrs, port\\)/false/',
      '--test', 'node {}',
    ]);

    // Exit 2 is the documented "misuse / could not be run soundly" code. It is
    // emphatically NOT 0: pre-fix this same invocation exited 0 with
    // verdict=caught, which is the bug.
    expect(status).toBe(2);
    expect(out).toContain('not a valid program');
    expect(out).toContain('mutant_parse=broken');

    // A refusal must refuse — no falsifiability verdict may be emitted.
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).not.toContain('the guard is falsifiable');

    // And it must be ACTIONABLE: the fix is to anchor the pattern on text the
    // declaration cannot match, so the refusal hands over that exact pattern.
    expect(out).toContain('MORE THAN THE INTENDED SITE');
    expect(out).toContain('if \\(isTunnelForward');

    // The subject is restored regardless of which exit path was taken.
    expect(readFileSync(mjsSubject, 'utf8')).toBe(MJS_SUBJECT);
  });

  it('still scores a VALID semantic mutation on the same subject, stamped mutant_parse=ok', () => {
    // Calibration for the case above: same file, same guard, a mutation that
    // is correctly anchored. Without this, the refusal proves nothing — a
    // script that refused every mutation would pass the previous test.
    const { status, out } = runProbe([
      '--file', mjsSubject,
      '--mutate', 's/if \\(isTunnelForward/if (false \\&\\& isTunnelForward/',
      '--test', 'node {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('mutant_parse=ok');
    expect(readFileSync(mjsSubject, 'utf8')).toBe(MJS_SUBJECT);
  });

  it('REFUSES an unparseable shell mutant too (the bash -n path)', () => {
    // Shell subjects are the script's other common case, and a dropped `fi`
    // is the way a shell mutation most often stops being a program.
    const { status, out } = runProbe([
      '--file', shSubject,
      '--mutate', 's/^fi$//',
      '--test', 'bash {}',
    ]);

    expect(status).toBe(2);
    expect(out).toContain('not a valid program');
    expect(out).toContain('mutant_parse=broken');
    expect(readFileSync(shSubject, 'utf8')).toBe(SH_SUBJECT);
  });

  it('still scores a VALID shell mutation, stamped mutant_parse=ok', () => {
    const { status, out } = runProbe([
      '--file', shSubject,
      '--mutate', 's/exit 0/exit 1/',
      '--test', 'bash {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('mutant_parse=ok');
    expect(readFileSync(shSubject, 'utf8')).toBe(SH_SUBJECT);
  });

  it('degrades LOUDLY on a subject it cannot syntax-check, rather than implying it did', () => {
    // subject.txt has no checker. The run must still work — the gate may only
    // ever refuse on POSITIVE proof of breakage — but the result line has to
    // carry its own caveat, or an unchecked caught verdict reads identically
    // to a verified one.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('mutant_parse=unchecked');
    expect(out).not.toContain('mutant_parse=ok');
  });
});

/**
 * EI-23809205858633494 — the DIRTY-WINDOW ceiling.
 *
 * `--in-tree` holds the TRACKED file mutated for exactly as long as the guard
 * child runs, so time spent in that child that is not MEASUREMENT is pure
 * sweep-race risk. The documented `--test` command (`npm run test:file`) is
 * pc-heavy-wrapped, and pc-heavy is a host-wide counting semaphore that WAITS
 * for other agents' heavy runs to drain: measured 2026-09-20, it sat in that
 * queue 6+ minutes without starting a single test while a mutated
 * operator-core file sat in the shared tree (~25s through the direct router).
 * The window had inherited an unbounded wait from a queue that has nothing to
 * do with the probe.
 *
 * Two halves, each asserted below in both directions:
 *   - in-tree guard children export PC_HEAVY_BYPASS=1 (copy-out does NOT —
 *     it has no window, so it stays a well-behaved queued citizen);
 *   - the in-tree guard runs under a wall-clock ceiling, and tripping it is a
 *     harness-error, never a verdict.
 */
describe('mutation-probe.sh in-tree dirty-window ceiling', () => {
  // Echoes the inherited value so the assertion reads the CHILD's environment
  // rather than this test process's, then behaves like the ordinary subject
  // guard so the surrounding verdict logic is exercised unchanged.
  const REPORT_BYPASS = 'echo "BYPASS=[${PC_HEAVY_BYPASS:-unset}]"; grep -q GOOD {}';

  it('exports PC_HEAVY_BYPASS=1 into in-tree guard children, so the window cannot inherit an admission queue', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', REPORT_BYPASS,
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('BYPASS=[1]');
    expect(out).not.toContain('BYPASS=[unset]');
    // The bypass must not disturb the thing the probe exists to produce, and
    // the default 600s ceiling must not fire on an ordinary fast guard.
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).not.toContain('window_exceeded_sec=');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('leaves COPY-OUT mode queueing normally — no window means no reason to skip admission', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', REPORT_BYPASS,
    ]);

    expect(status).toBe(0);
    expect(out).toContain('BYPASS=[unset]');
    expect(out).not.toContain('BYPASS=[1]');
    expect(out).toContain('target=copy-out');
  });

  it('applies the bypass to the BASELINE too, so both phases share one invocation path', () => {
    // The baseline runs before the mutation. If only the mutant child were
    // bypassed, the verdict would compare two differently-scheduled runs — so
    // assert the marker appears for BOTH phases, not just once.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', REPORT_BYPASS,
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out.match(/BYPASS=\[1\]/g) ?? []).toHaveLength(2);
  });

  it('kills a hung BASELINE at the ceiling — before anything is mutated — and reports no verdict', () => {
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'sleep 60',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: '2' },
    );

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error');
    expect(out).toContain('window_exceeded_sec=');
    expect(out).toContain('phase=baseline');
    expect(out).toContain('DIRTY-WINDOW ceiling');
    // This phase is where the diagnosis earns its keep. Without it the run
    // reports `BASELINE FAILED (guard exited 124) — refusing to score the
    // mutant`, which accuses the caller's guard of failing on the UNMUTATED
    // file when in fact the probe killed it — a wrong answer, not a vague one.
    expect(out).not.toContain('BASELINE FAILED');
    // Tripping in the baseline phase is the BEST outcome available: the tree
    // was never dirtied at all.
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('refuses to score a KILLED mutant run as a verdict, and restores the file', () => {
    // The mutant path here would exit 0 if allowed to finish — the honest
    // verdict is SURVIVED — and `timeout` kills it at rc=124 instead.
    //
    // ⚠ MEASURED, against an earlier draft of this comment: rc=124 does NOT
    // become `caught`. The verdict ladder scores `caught` on TEST_RC -eq 1
    // ALONE and sends every other nonzero status to `harness-error`, so the
    // killed run was already refused a verdict before this block existed.
    // (A mutation probe that disabled the detection below printed exactly
    // that: `verdict=harness-error ... guard_exit=124`.) What this block adds
    // is the DIAGNOSIS — which phase, how long, and what to do — on top of a
    // bare "guard exited 124". The assertions therefore pin the diagnosis,
    // and keep the no-verdict property from silently regressing into one.
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {} || { sleep 60; exit 0; }',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: '2' },
    );

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error');
    expect(out).toContain('phase=mutant');
    expect(out).not.toContain('verdict=caught');
    expect(out).not.toContain('verdict=survived');
    // The baseline DID run here, so the mutation really was applied — which
    // makes the restore the load-bearing half of this case.
    expect(out).toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('honours MUTATION_PROBE_WINDOW_MAX_SEC=0 as an explicit opt-out rather than a 0-second ceiling', () => {
    // A numeric-looking 0 must not be read as "kill immediately" — that would
    // turn the opt-out into the harshest possible setting.
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'sleep 2; grep -q GOOD {}',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: '0' },
    );

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).not.toContain('window_exceeded_sec=');
  });

  it('refuses a non-numeric ceiling instead of silently falling back to unbounded', () => {
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: 'abc' },
    );

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_WINDOW_MAX_SEC must be a whole number');
    expect(out).not.toContain('mutant applied:');
  });
});

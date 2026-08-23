/**
 * EI-18666147162251862: agents (and admin-commands.ts's `start-mac-vm`) guard
 * destructive/skip decisions with `pgrep -f <pattern>` / `pkill -f <pattern>`.
 * Since every such command runs as `bash -c '<the whole command string>'`, the
 * invoking shell's OWN cmdline contains the pattern text literally (it's the
 * pgrep argument itself) — and `pgrep -f` matches against every process
 * system-wide, not just descendants, so it self-matches its own ancestor.
 * Reproduced live (see scripts/proc-guard.mjs's header comment):
 *
 *   bash -c 'pgrep -f "definitely-not-a-real-process-zzqq" >/dev/null && echo MATCHED'
 *   # => MATCHED, though nothing by that name exists anywhere.
 *
 * scripts/proc-guard.mjs fixes this by excluding the caller's own pid + its
 * whole ancestor chain before matching. These tests build a fake /proc fixture
 * reproducing exactly that shape (a bash -c wrapper ancestor whose own cmdline
 * embeds the pattern) and assert the guard is immune to it while still catching
 * a genuinely unrelated external process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAncestryChain,
  getOperationalArgv,
  matchesAdjacentArgvSequence,
  isStructuredPayloadArg,
  listProcesses,
  matchExternalProcesses,
  matchExternalProcessesDetailed,
  parseArgv,
  parseCmdline,
  parsePpid,
  parseCgroupPath,
  parseUsageUsec,
  computeCoresBusy,
  sampleCgroupBusy,
  sampleBusyMatches,
  formatBusy,
} from '../../../scripts/proc-guard.mjs';

let fixtureRoot: string | null = null;

function fixtureProc(root: string, pid: number, ppid: number, argv: string[], comm = 'bash') {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
  // Minimal realistic /proc/<pid>/stat: "pid (comm) state ppid ...". Real
  // stat lines have 50+ fields; parsePpid only needs the ones up to ppid.
  writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0`);
}

function fixtureIdentity(
  root: string,
  pid: number,
  options: { environment?: string[]; cgroupPath?: string },
) {
  const dir = join(root, String(pid));
  if (options.environment) writeFileSync(join(dir, 'environ'), options.environment.join('\0') + '\0');
  if (options.cgroupPath) writeFileSync(join(dir, 'cgroup'), `0::${options.cgroupPath}\n`);
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

describe('parseCmdline', () => {
  it('joins NUL-separated argv into a space-joined display string', () => {
    expect(parseCmdline(Buffer.from('pgrep\0-f\0qemu.*mac_hdd_ng\0'))).toBe('pgrep -f qemu.*mac_hdd_ng');
  });

  it('drops the trailing empty segment from the terminating NUL', () => {
    expect(parseCmdline(Buffer.from('node\0script.mjs\0'))).toBe('node script.mjs');
  });
});

describe('parseArgv and getOperationalArgv', () => {
  it('keeps raw argv boundaries while parseCmdline remains display-compatible', () => {
    const raw = Buffer.from('node\0script.mjs\0argument with spaces\0');
    expect(parseArgv(raw)).toEqual(['node', 'script.mjs', 'argument with spaces']);
    expect(parseCmdline(raw)).toBe('node script.mjs argument with spaces');
  });

  it('removes kickoff prompt payloads but retains the executable and real args', () => {
    const argv = [
      '/usr/bin/gnome-terminal',
      '--wait',
      'PAPERCUSP_KICKOFF_PROMPT=green-checkpoint',
      '--target',
      'mac_hdd_ng.img',
    ];
    expect(getOperationalArgv(argv)).toEqual(['/usr/bin/gnome-terminal', '--wait', '--target', 'mac_hdd_ng.img']);
  });

  it('removes a peer agent JSON payload but retains the executable and real args', () => {
    const argv = [
      'node',
      '/repo/scripts/ptool.mjs',
      'work_items:checkpoint',
      '{"id":"WI-38341","checkpoint":"waiting on green-checkpoint"}',
      '--json',
    ];
    expect(getOperationalArgv(argv)).toEqual(['node', '/repo/scripts/ptool.mjs', 'work_items:checkpoint', '--json']);
  });
});

describe('matchesAdjacentArgvSequence', () => {
  const sequence = ['gitnexus', 'analyze'];

  it('matches npx when gitnexus and analyze are adjacent tokens', () => {
    expect(matchesAdjacentArgvSequence(['npx', '--yes', 'gitnexus', 'analyze', '/repo'], sequence)).toBe(true);
  });

  it('matches a node-launched gitnexus.js path by basename', () => {
    expect(
      matchesAdjacentArgvSequence(
        ['node', '/repo/node_modules/gitnexus/bin/gitnexus.js', 'analyze', '/repo'],
        sequence,
      ),
    ).toBe(true);
  });

  it('matches a node-launched gitnexus package entrypoint by node_modules path', () => {
    expect(
      matchesAdjacentArgvSequence(
        ['node', '/repo/node_modules/gitnexus/dist/cli/index.js', 'analyze', '/repo', '--skip-agents-md'],
        sequence,
      ),
    ).toBe(true);
  });

  it('matches the direct gitnexus executable', () => {
    expect(matchesAdjacentArgvSequence(['/usr/local/bin/gitnexus', 'analyze', '/repo'], sequence)).toBe(true);
  });

  it('rejects a python hook whose JSON payload merely names the command', () => {
    expect(
      matchesAdjacentArgvSequence(
        ['python3', '-', JSON.stringify({ tool_input: { command: 'npx --yes gitnexus analyze /repo' } })],
        sequence,
      ),
    ).toBe(false);
  });

  it('rejects the right executable with the wrong verb', () => {
    expect(matchesAdjacentArgvSequence(['npx', '--yes', 'gitnexus', 'cypher', '/repo'], sequence)).toBe(false);
  });

  it('rejects command text embedded in a node -e script', () => {
    expect(matchesAdjacentArgvSequence(['node', '-e', 'gitnexus analyze /repo'], sequence)).toBe(false);
  });
});

// EI-20303820187580514. Ancestor-exclusion cannot reach these: a peer's hook
// process is an unrelated third party, not the caller's ancestor, and its
// payload carries no fixed marker to match on. The discriminator is structural.
describe('isStructuredPayloadArg', () => {
  it('treats a hook envelope as payload, at the sizes really observed (12KB)', () => {
    const envelope = JSON.stringify({
      session_id: '019ff901-330d-7dd2-a4c4-88523cbe11e4',
      transcript_path: '/home/x/.papercusp/session-claude/t.jsonl',
      tool_name: 'Bash',
      tool_input: { command: "ptool work_items:checkpoint --json - <<'JSON' ... green-checkpoint ..." },
      padding: 'x'.repeat(12_000),
    });
    expect(isStructuredPayloadArg(envelope)).toBe(true);
  });

  it('treats a settings blob and a JSON array as payload', () => {
    expect(isStructuredPayloadArg('{"apiKeyHelper":"","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9073"}}')).toBe(
      true,
    );
    expect(isStructuredPayloadArg('["green-checkpoint","release-cut"]')).toBe(true);
  });

  it('tolerates surrounding whitespace, as a shell-quoted payload can carry it', () => {
    expect(isStructuredPayloadArg('  {"tool_name":"Bash"}\n')).toBe(true);
  });

  // The controls. These must stay operational: a jq program and a brace-glob
  // both START like JSON, so a naive first-character check would swallow them
  // and silently turn real matches into non-matches.
  it('does NOT treat a jq program as payload (starts with { but is not valid JSON)', () => {
    expect(isStructuredPayloadArg('{a:1}')).toBe(false);
    expect(isStructuredPayloadArg('{"green-checkpoint"')).toBe(false);
  });

  it('does NOT treat ordinary arguments as payload', () => {
    expect(isStructuredPayloadArg('green-checkpoint')).toBe(false);
    expect(isStructuredPayloadArg('/var/log/green-checkpoint.log')).toBe(false);
    expect(isStructuredPayloadArg('')).toBe(false);
    expect(isStructuredPayloadArg('{}')).toBe(true);
  });

  // Calibration: a JSON SCALAR is not a payload envelope. Without this, a
  // subject that returned true for everything parseable would still pass the
  // positive cases above.
  it('does NOT treat a bare JSON scalar as payload', () => {
    expect(isStructuredPayloadArg('123')).toBe(false);
    expect(isStructuredPayloadArg('"green-checkpoint"')).toBe(false);
    expect(isStructuredPayloadArg('null')).toBe(false);
  });
});

describe('parsePpid', () => {
  it('parses ppid from a normal comm field', () => {
    expect(parsePpid('1234 (bash) S 1000 1234 1234 0 -1 0')).toBe(1000);
  });

  it('resumes field-splitting after the LAST close-paren so a comm containing ")" is safe', () => {
    // A process named "weird)proc" would otherwise be mis-split mid-name.
    expect(parsePpid('55 (weird)proc) S 42 55 55 0 -1 0')).toBe(42);
  });

  it('returns null when the line has no comm parens at all', () => {
    expect(parsePpid('garbage line with no parens')).toBeNull();
  });
});

describe('getAncestryChain', () => {
  it('walks parent -> grandparent -> ... -> pid 1', () => {
    const byPid = new Map([
      [1, null],
      [50, 1],
      [100, 50],
      [200, 100],
    ]);
    expect(getAncestryChain(200, byPid)).toEqual(new Set([200, 100, 50, 1]));
  });

  it('is cycle-safe (a corrupt ppid chain never infinite-loops)', () => {
    const byPid = new Map([
      [10, 20],
      [20, 10], // cycle
    ]);
    const chain = getAncestryChain(10, byPid);
    expect(chain).toEqual(new Set([10, 20]));
  });

  it('stops cleanly on an unknown ppid', () => {
    const byPid = new Map([[5, 999]]); // 999 not in the map
    expect(getAncestryChain(5, byPid)).toEqual(new Set([5, 999]));
  });
});

describe('matchExternalProcesses — the EI-18666147162251862 regression', () => {
  it('does NOT self-match when the pattern only appears in the caller\'s own ancestor cmdline', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'definitely-not-a-real-process-zzqq';
    // pid 1: init. pid 50: the `bash -c '<whole command>'` wrapper — its own
    // cmdline embeds the pattern text (it's literally running `pgrep -f
    // "<PATTERN>"`), which is exactly what makes a bare `pgrep -f` self-match.
    // pid 100: "us" (e.g. the proc-guard CLI itself, or the pgrep it would spawn).
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 50, 1, ['bash', '-c', `if pgrep -f "${PATTERN}" >/dev/null; then echo MATCHED; fi`]);
    fixtureProc(fixtureRoot, 100, 50, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches).toEqual([]); // the naive `pgrep -f` equivalent would have returned pid 50 here
  });

  it('DOES match a genuinely unrelated external process with the pattern in its cmdline', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'qemu.*mac_hdd_ng';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 50, 1, ['bash', '-c', `if pgrep -f "${PATTERN}" >/dev/null; then echo MATCHED; fi`]);
    fixtureProc(fixtureRoot, 100, 50, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    // The real target: an unrelated qemu process, NOT an ancestor of pid 100.
    fixtureProc(fixtureRoot, 777, 1, ['qemu-system-x86_64', '-drive', 'file=./mac_hdd_ng.img'], 'qemu-system-x8');

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches.map((m) => m.pid)).toEqual([777]);
  });

  it('excludes an unrelated process that is merely a SIBLING ancestor-less match correctly, and excludes self', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'target-thing';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]); // self
    fixtureProc(fixtureRoot, 200, 1, ['some-other-proc', PATTERN]); // unrelated sibling, real match

    const matches = matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(matches.map((m) => m.pid)).toEqual([200]);
  });

  it('returns [] against a missing /proc root rather than throwing', () => {
    const matches = matchExternalProcesses('anything', { procRoot: '/no/such/proc/root', selfPid: 1 });
    expect(matches).toEqual([]);
  });

  it('ignores kickoff prompt text while retaining the real-vs-argv-text split', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    fixtureProc(fixtureRoot, 778, 1, [
      'bun',
      '/home/dev/.papercusp/bin/omp',
      '--model',
      'model:low',
      '⟦turn-origin:fleet-kickoff nonce:abc⟧ The green-checkpoint gate is red.',
    ]);
    fixtureProc(fixtureRoot, 779, 1, [
      'bash',
      '-lc',
      "export PAPERCUSP_KICKOFF_PROMPT='The green-checkpoint gate is red.'; exec $SHELL",
    ]);

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(report.matches.map((m) => m.pid)).toEqual([777]);
    expect(report.fullMatches.map((m) => m.pid)).toEqual([777, 778, 779]);
    expect(report.argvTextOnly.map((m) => m.pid)).toEqual([778, 779]);
    expect(matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 }).map((m) => m.pid)).toEqual([777]);
  });

  // EI-20303820187580514, the live repro: `check green-checkpoint` reported 4
  // matches while exactly ONE green-checkpoint process existed. The other three
  // were peers' hook/tool processes whose JSON argv named the gate because those
  // agents were writing checkpoints ABOUT it. A false POSITIVE here reads as
  // concurrent gate runs, and the standing rule is to stand down for those.
  it('does NOT count a peer agent whose JSON payload merely NAMES the pattern', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    // The one real gate process — the ground truth the CLI must report.
    fixtureProc(fixtureRoot, 777, 1, ['node', 'apps/operator/lib/release/green-checkpoint.ts']);
    // A peer's PostToolUse hook: the gate name rides inside the tool_input.
    fixtureProc(fixtureRoot, 269555, 1, [
      'python3',
      '-',
      JSON.stringify({
        session_id: '21e71b6f-7059-41ed-bb16-54ee447c00ce',
        tool_name: 'Bash',
        tool_input: { command: 'ptool work_items:checkpoint ... green-checkpoint ...' },
      }),
    ]);
    // A peer's ptool call, checkpointing ABOUT the gate.
    fixtureProc(fixtureRoot, 269556, 1, [
      'node',
      '/repo/scripts/ptool.mjs',
      'work_items:checkpoint',
      '{"id":"WI-38341","checkpoint":"blocked on green-checkpoint"}',
    ]);
    // A peer claude launcher carrying a --settings blob.
    fixtureProc(fixtureRoot, 269557, 1, [
      'claude',
      '--settings',
      '{"env":{"PAPERCUSP_GATE":"green-checkpoint"}}',
    ]);

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    // The verdict: one real process, not four.
    expect(report.matches.map((m) => m.pid)).toEqual([777]);
    // Nothing is silently dropped — the ignored rows stay auditable. Sorted
    // because row order follows /proc readdir order, which is lexicographic.
    expect(report.fullMatches.map((m) => m.pid).sort((a, b) => a - b)).toEqual([777, 269555, 269556, 269557]);
    expect(report.argvTextOnly.map((m) => m.pid).sort((a, b) => a - b)).toEqual([269555, 269556, 269557]);
  });

  it('uses argv adjacency mode to ignore gitnexus prose while retaining real commands', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'gitnexus.*analyze';
    const sequence = ['gitnexus', 'analyze'];
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, ['npx', '--yes', 'gitnexus', 'analyze', '/repo']);
    fixtureProc(fixtureRoot, 778, 1, ['node', '/repo/bin/gitnexus.js', 'analyze', '/repo']);
    fixtureProc(fixtureRoot, 779, 1, ['/usr/local/bin/gitnexus', 'analyze', '/repo']);
    fixtureProc(fixtureRoot, 780, 1, [
      'node',
      '/repo/node_modules/gitnexus/dist/cli/index.js',
      'analyze',
      '/repo',
      '--skip-agents-md',
    ]);
    fixtureProc(fixtureRoot, 888, 1, [
      'python3',
      '-',
      JSON.stringify({ tool_input: { command: 'npx --yes gitnexus analyze /repo' } }),
    ]);
    fixtureProc(fixtureRoot, 889, 1, ['node', '-e', 'gitnexus analyze /repo']);
    fixtureProc(fixtureRoot, 890, 1, ['npx', '--yes', 'gitnexus', 'cypher', '/repo']);

    const report = matchExternalProcessesDetailed(PATTERN, {
      procRoot: fixtureRoot,
      selfPid: 100,
      argvSequence: sequence,
    });
    expect(report.matches.map((m) => m.pid)).toEqual([777, 778, 779, 780]);
    expect(report.fullMatches.map((m) => m.pid).sort((a, b) => a - b)).toEqual([777, 778, 779, 780, 888, 889]);
    expect(report.argvTextOnly.map((m) => m.pid).sort((a, b) => a - b)).toEqual([888, 889]);
  });

  // Calibration for the test above: the payload rule must not be so broad that
  // it suppresses a real process. A gate process invoked WITH a JSON argument
  // still matches, because the pattern is in its script path, not the payload.
  it('still matches a real process that happens to also carry a JSON argument', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);
    fixtureProc(fixtureRoot, 777, 1, [
      'node',
      'apps/operator/lib/release/green-checkpoint.ts',
      '{"candidate":"bb026a02ba"}',
    ]);

    expect(matchExternalProcesses(PATTERN, { procRoot: fixtureRoot, selfPid: 100 }).map((m) => m.pid)).toEqual([777]);
  });

  it('matches argv-blind gate descendants through authoritative markers and cgroup identity', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    const PATTERN = 'green-checkpoint';
    fixtureProc(fixtureRoot, 1, 0, ['/sbin/init']);
    fixtureProc(fixtureRoot, 100, 1, ['node', 'scripts/proc-guard.mjs', 'check', PATTERN]);

    // The real gate descendants run from the checkpoint tree, whose argv does
    // not name green-checkpoint. The suite env carries both dedicated markers.
    fixtureProc(fixtureRoot, 777, 1, ['node', '/repo/papercusp-checkpoint/scripts/affected-tests.mjs']);
    fixtureIdentity(fixtureRoot, 777, {
      environment: ['GREEN_CHECKPOINT=1', 'PC_HEAVY_RELEASE_GATE=1'],
    });

    // GREEN_CHECKPOINT alone is intentionally insufficient: agents can export
    // it to reproduce the gate's skip-set without being the release gate.
    fixtureProc(fixtureRoot, 778, 1, ['node', '/repo/papercusp-checkpoint/scripts/worker.mjs']);
    fixtureIdentity(fixtureRoot, 778, { environment: ['GREEN_CHECKPOINT=1'] });

    // The detached manual launcher supplies the same identity at the cgroup
    // boundary even when a child does not expose the env files in the fixture.
    fixtureProc(fixtureRoot, 779, 1, ['node', '/repo/papercusp-checkpoint/scripts/worker.mjs']);
    fixtureIdentity(fixtureRoot, 779, {
      cgroupPath: '/user.slice/user-1000.slice/papercup-green-checkpoint-manual-abc.service',
    });

    const report = matchExternalProcessesDetailed(PATTERN, { procRoot: fixtureRoot, selfPid: 100 });
    expect(report.matches.map((m) => m.pid)).toEqual([777, 779]);
    expect(report.identityMatches.map((m) => m.pid)).toEqual([777, 779]);
    expect(report.fullMatches).toEqual([]);
    expect(report.argvTextOnly).toEqual([]);

    // Identity enrichment is scoped to the known workload; generic patterns
    // remain argv-only and therefore do not inherit gate marker semantics.
    expect(matchExternalProcesses('gate-only-sentinel', { procRoot: fixtureRoot, selfPid: 100 })).toEqual([]);
  });
});

describe('listProcesses', () => {
  it('skips a pid whose cmdline is empty (kernel threads / zombies)', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-fixture-'));
    mkdirSync(join(fixtureRoot, '2'), { recursive: true });
    writeFileSync(join(fixtureRoot, '2', 'cmdline'), ''); // kthread-like: empty cmdline
    writeFileSync(join(fixtureRoot, '2', 'stat'), '2 (kthreadd) S 0 0 0 0 -1 0');
    fixtureProc(fixtureRoot, 3, 0, ['real-process']);

    const procs = listProcesses(fixtureRoot);
    expect(procs.map((p) => p.pid)).toEqual([3]);
  });
});

/**
 * EI-20425164406230624 — `--busy`: "is it WORKING", as opposed to `check`'s
 * "is it RUNNING". Two agents measured the SAME live gate run within one
 * minute and reached OPPOSITE conclusions, because a hand-rolled /proc tree
 * walk false-idles here two ways (a depth-bounded walk halts on a 0-tick shell
 * wrapper; `c*` ticks are credited only on wait(), which vitest never does for
 * its own workers). The cgroup cannot be escaped, so it is the instrument.
 */
describe('proc-guard --busy: cgroup CPU sampling', () => {
  describe('parseCgroupPath', () => {
    it('extracts the cgroup-v2 path', () => {
      expect(parseCgroupPath('0::/user.slice/user-1000.slice/run-u123272.scope\n')).toBe(
        '/user.slice/user-1000.slice/run-u123272.scope',
      );
    });

    it('returns null on a v1-only host rather than guessing a path', () => {
      expect(parseCgroupPath('12:pids:/user.slice\n4:cpu,cpuacct:/user.slice\n')).toBeNull();
    });
  });

  describe('parseUsageUsec', () => {
    it('reads usage_usec out of a cpu.stat body', () => {
      expect(parseUsageUsec('usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n')).toBe(123456);
    });

    it('returns null when the field is absent', () => {
      expect(parseUsageUsec('nr_periods 0\nnr_throttled 0\n')).toBeNull();
    });
  });

  describe('computeCoresBusy', () => {
    it('converts a usec delta over elapsed ms into cores', () => {
      expect(computeCoresBusy(2_000_000, 1000)).toBeCloseTo(2.0, 5);
    });

    it('returns null rather than Infinity when elapsed is zero', () => {
      expect(computeCoresBusy(1_000_000, 0)).toBeNull();
    });
  });

  describe('sampleCgroupBusy', () => {
    function busyFixture(usageSeries: number[]): { procRoot: string; cgroupRoot: string; advance: () => void } {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-busy-'));
      const procRoot = join(fixtureRoot, 'proc');
      const cgroupRoot = join(fixtureRoot, 'cgroup');
      mkdirSync(join(procRoot, '42'), { recursive: true });
      writeFileSync(join(procRoot, '42', 'cgroup'), '0::/test.scope\n');
      mkdirSync(join(cgroupRoot, 'test.scope'), { recursive: true });
      const statPath = join(cgroupRoot, 'test.scope', 'cpu.stat');
      writeFileSync(join(cgroupRoot, 'test.scope', 'cgroup.procs'), '42\n43\n44\n');
      let i = 0;
      const write = () => writeFileSync(statPath, `usage_usec ${usageSeries[i]}\n`);
      write();
      return { procRoot, cgroupRoot, advance: () => { i = Math.min(i + 1, usageSeries.length - 1); write(); } };
    }

    it('divides by MEASURED elapsed, not the requested sample window', async () => {
      // 1 core-second of CPU observed over a MEASURED 500ms => 2 cores.
      // If the implementation divided by sampleMs (10s) it would say 0.10 —
      // so this number is what pins the correct divisor.
      const { procRoot, cgroupRoot, advance } = busyFixture([1_000_000, 2_000_000]);
      let t = 0;
      const res = await sampleCgroupBusy(42, {
        procRoot,
        cgroupRoot,
        sampleMs: 10_000,
        sleep: async () => { advance(); t = 500; },
        now: () => t,
      });

      expect(res.status).toBe('ok');
      if (res.status !== 'ok') throw new Error(`expected an ok sample, got ${res.status}`);
      expect(res.cores).toBeCloseTo(2.0, 5);
      expect(res.elapsedMs).toBe(500);
      expect(res.procs).toBe(3); // every descendant, not just the pid asked about
    });

    it('reports UNKNOWN — never 0 cores — when the cgroup cannot be read', async () => {
      // "could not measure" and "measured, idle" must not render alike: the
      // whole incident behind this feature was an unmeasurable read being
      // reported as an idle one.
      fixtureRoot = mkdtempSync(join(tmpdir(), 'proc-guard-busy-none-'));
      const procRoot = join(fixtureRoot, 'proc');
      mkdirSync(join(procRoot, '42'), { recursive: true });
      writeFileSync(join(procRoot, '42', 'cgroup'), '0::/test.scope\n');

      const res = await sampleCgroupBusy(42, {
        procRoot,
        cgroupRoot: join(fixtureRoot, 'cgroup-does-not-exist'),
        sampleMs: 1,
        sleep: async () => {},
      });

      expect(res.status).toBe('unknown');
      if (res.status !== 'unknown') throw new Error(`expected an unknown sample, got ${res.status}`);
      expect(res.reason).toBe('cpu-stat-unreadable');
      expect(res.cores).toBeUndefined();
    });

    it('fails closed before sleeping when the budget cannot fit one full sample', async () => {
      const { procRoot, cgroupRoot } = busyFixture([1_000_000, 2_000_000]);
      let sleeps = 0;
      const res = await sampleCgroupBusy(42, {
        procRoot,
        cgroupRoot,
        sampleMs: 1_000,
        budgetMs: 500,
        sleep: async () => {
          sleeps += 1;
        },
        now: () => 0,
      });

      expect(res.status).toBe('unknown');
      if (res.status !== 'unknown') throw new Error(`expected an unknown sample, got ${res.status}`);
      expect(res.reason).toBe('budget-exhausted');
      expect(sleeps).toBe(0);
    });

    it('shares one wall-clock budget across matches instead of serialising samples', async () => {
      const { procRoot, cgroupRoot, advance } = busyFixture([1_000_000, 2_000_000]);
      mkdirSync(join(procRoot, '43'), { recursive: true });
      writeFileSync(join(procRoot, '43', 'cgroup'), '0::/test.scope\n');

      let nowMs = 0;
      let active = 0;
      let maxActive = 0;
      const results = await sampleBusyMatches(
        [{ pid: 42 }, { pid: 43 }],
        {
          procRoot,
          cgroupRoot,
          sampleMs: 1_000,
          budgetMs: 1_500,
          sleep: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            advance();
            nowMs = 1_000;
            active -= 1;
          },
          now: () => nowMs,
        },
      );

      expect(maxActive).toBe(2);
      expect(results.map((sample) => sample.status)).toEqual(['ok', 'ok']);
    });
  });

  describe('formatBusy', () => {
    it('attaches the falsifier to a near-zero reading', () => {
      const lines = formatBusy({ status: 'ok', cores: 0.0, procs: 1, elapsedMs: 10_000, cgroupPath: '/t.scope' });
      expect(lines.join(' ')).toMatch(/near-zero/);
      expect(lines.join(' ')).toMatch(/DIFFERENT cgroup/);
    });

    it('does NOT cry wolf on a genuinely busy reading', () => {
      const lines = formatBusy({ status: 'ok', cores: 2.54, procs: 15, elapsedMs: 10_000, cgroupPath: '/t.scope' });
      expect(lines.join(' ')).toContain('2.54 core(s)');
      expect(lines.join(' ')).not.toMatch(/near-zero/);
    });

    it('renders an unknown sample as UNKNOWN and explicitly not idle', () => {
      const lines = formatBusy({ status: 'unknown', reason: 'no-cgroup-entry' });
      expect(lines.join(' ')).toContain('UNKNOWN');
      expect(lines.join(' ')).toMatch(/NOT "idle"/);
    });
  });
});

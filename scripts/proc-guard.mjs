#!/usr/bin/env node
/**
 * proc-guard — a process-liveness check that CANNOT self-match.
 *
 * WHY THIS EXISTS (EI-18666147162251862): the Bash tool (and admin-commands.ts's
 * SSE command runner) invoke every command as `bash -c '<the whole command
 * string>'` / `bash -lic '<...>'`, so the COMMAND STRING ITSELF is a live line in
 * the process table for as long as that shell runs. A bare `pgrep -f <pattern>` /
 * `pkill -f <pattern>` matches against FULL cmdlines *system-wide* — not just
 * descendants — so any pattern that appears literally anywhere in your own
 * invocation (inside the pgrep call's own argument, an echo, a comment) matches
 * your own wrapper. This is trivially reproducible and has nothing to do with
 * whether the real target process is running:
 *
 *   bash -c 'if pgrep -f "definitely-not-a-real-process-zzqq" >/dev/null; \
 *              then echo MATCHED; else echo NOMATCH; fi'
 *   # => MATCHED, even though nothing by that name exists anywhere — pgrep
 *   #    matched its OWN invoking bash -c process, whose cmdline contains the
 *   #    pattern text literally (as the pgrep argument itself).
 *
 * A guard built on this pattern fails in BOTH directions: it can report "already
 * running" when it isn't (a destructive start is skipped) and, via `pkill -f`,
 * can kill the CALLING shell itself (the pattern matches the caller's own
 * ancestor, not just the intended target) — see the work-item for a live repro
 * of both.
 *
 * THE FIX: walk the CALLER's own ancestor chain (parent, grandparent, ... up to
 * pid 1) and exclude every pid in it before matching, so a caller running inside
 * a `bash -c` / `-lic` wrapper whose own command line happens to contain the
 * pattern text is never mistaken for a real match — while a genuinely unrelated
 * external process with the same pattern in its cmdline still matches.
 *
 * A second, independent false-positive class is agent launchers: their argv can
 * carry a long `PAPERCUSP_KICKOFF_PROMPT=...` shell assignment or a turn prompt
 * as the final argument. Those are operator prose, not the executable or its
 * runtime arguments. Matching the raw joined cmdline therefore reports a live
 * agent as a running gate/script whenever its prompt happens to name that gate.
 * `getOperationalArgv` removes those known prompt payload arguments while
 * retaining the executable and all other process arguments (including qemu's
 * image/path arguments). The detailed matcher reports both views so a caller can
 * audit what was ignored instead of mistaking a raw argv count for liveness.
 *
 * A THIRD false-positive class, and the one that grows with fleet size, is a
 * PEER's structured payload (EI-20303820187580514). Agent hook and tool
 * processes are invoked as `python3 - '<json>'` / `node <tool> '<json>'`, where
 * the JSON argument carries whatever that agent is currently working on — so a
 * peer writing a checkpoint ABOUT the green-checkpoint gate puts the literal
 * text "green-checkpoint" in its argv. Ancestor-exclusion above cannot help:
 * those peers are unrelated third parties, not the caller's ancestors. Marker
 * matching could not help either, because the payload carries no fixed marker.
 * The discriminator is STRUCTURAL — an argv entry that parses as a JSON
 * object/array is data the process was handed, never the process's identity —
 * and it was validated against this box's live /proc rather than assumed:
 * across 3,288 processes plus a 20s sweep of transient hook processes, all 49
 * observed JSON-shaped payloads (`{"session_id":…}` hook envelopes up to 12KB,
 * `claude --settings {…}`, `ptool` checkpoint bodies) parsed cleanly, and ZERO
 * argv entries started like JSON but failed to parse — so no length heuristic
 * or truncation fallback is warranted.
 *
 * Note the failure direction this protects: a false NEGATIVE is corrected by
 * the very next check, but a false POSITIVE reports "4 gate processes running"
 * when one is, which reads as a stampede and invites an agent to intervene
 * against a healthy run — or to stand down from a stalled one.
 *
 * CLI:
 *   node scripts/proc-guard.mjs check <pattern>
 *     Exit 0 + print every operationally matching row (pid + full cmdline) when
 *     at least one EXTERNAL (non-self, non-ancestor) process matches. Exit 1 + a
 *     "no match" line otherwise. The output includes the full-argv count and
 *     argv-text-only count so prompt collisions are visible but cannot turn a
 *     liveness check into a permanent YES.
 *
 * Library (unit-tested against a fixture /proc — see proc-guard.test.ts;
 * `procRoot` / `selfPid` are both injectable for that reason):
 *   listProcesses(procRoot?)              -> [{ pid, ppid, argv, cmdline }]
 *   getAncestryChain(pid, byPid)           -> Set<pid> (pid + every ancestor, incl. pid 1)
 *   isStructuredPayloadArg(arg)           -> is this argv entry a JSON payload (data, not identity)?
 *   getOperationalArgv(argv)              -> argv with prompt + structured payloads removed
 *   matchExternalProcesses(pattern, opts) -> operational matching rows, self + ancestors excluded
 *   matchExternalProcessesDetailed(...)   -> operational, full, and argv-text-only rows
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PROC_ROOT = '/proc';

/**
 * One live process, as read out of `/proc`.
 *
 * @typedef {object} ProcRow
 * @property {number} pid
 * @property {number | null} ppid - null when `/proc/<pid>/stat` was unreadable or unparseable.
 * @property {string[]} argv - Raw process arguments, decoded from NUL-separated cmdline.
 * @property {string} cmdline - Full command line, NUL separators replaced by spaces.
 */

const PROMPT_ARG_MARKERS = ['PAPERCUSP_KICKOFF_PROMPT=', '⟦turn-origin:'];

/**
 * Parse a NUL-separated /proc/<pid>/cmdline buffer into a display string (space-joined args).
 *
 * @param {Buffer | string} raw
 * @returns {string}
 */
export function parseCmdline(raw) {
  return parseArgv(raw).join(' ');
}

/**
 * Parse a NUL-separated `/proc/<pid>/cmdline` buffer into argv entries.
 *
 * @param {Buffer | string} raw
 * @returns {string[]}
 */
export function parseArgv(raw) {
  return raw
    .toString('utf8')
    .split('\0')
    .filter((s) => s.length > 0);
}

/**
 * Is this argv entry a structured payload the process was HANDED, rather than
 * part of the process's own identity?
 *
 * An argument that parses as a JSON object/array is by construction data — a
 * hook envelope, a settings blob, a tool-call body. Its contents name whatever
 * the emitting agent was working on, so matching against it reports a peer's
 * SUBJECT as if it were a running process (EI-20303820187580514).
 *
 * The check is deliberately strict: it requires balanced object/array
 * delimiters AND a successful parse, so a shell/jq argument that merely starts
 * with `{` (e.g. jq's `{a:1}`, which is not valid JSON) stays operational.
 *
 * @param {string} arg
 * @returns {boolean}
 */
export function isStructuredPayloadArg(arg) {
  const trimmed = arg.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Remove agent prompt payloads and peers' structured (JSON) payloads from argv
 * before process matching. The executable and every real argument remain
 * eligible, so commands such as `qemu-system-x86_64 ... mac_hdd_ng.img` retain
 * their target args.
 *
 * Index 0 is always kept: the executable is the process's identity even in the
 * pathological case of a binary whose path parses as JSON.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function getOperationalArgv(argv) {
  return argv.filter(
    (arg, index) =>
      index === 0 || (!PROMPT_ARG_MARKERS.some((marker) => arg.includes(marker)) && !isStructuredPayloadArg(arg)),
  );
}

/**
 * Parse the ppid out of a /proc/<pid>/stat line. The comm field (2nd field) is
 * parenthesized and may itself contain spaces/parens, so field-splitting must
 * resume from the LAST `)` rather than naively splitting on whitespace — the
 * kernel guarantees fields after that point never contain unescaped `)`.
 *
 * @param {string} statLine
 * @returns {number | null}
 */
export function parsePpid(statLine) {
  const closeParen = statLine.lastIndexOf(')');
  if (closeParen === -1) return null;
  const rest = statLine.slice(closeParen + 1).trim().split(/\s+/);
  // rest[0] = state, rest[1] = ppid
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) ? ppid : null;
}

/**
 * Enumerate every live process as { pid, ppid, argv, cmdline }, from a /proc root (real or a test fixture).
 *
 * @param {string} [procRoot] - Defaults to `/proc`; a fixture directory in tests.
 * @returns {ProcRow[]}
 */
export function listProcesses(procRoot = DEFAULT_PROC_ROOT) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  /** @type {ProcRow[]} */
  const out = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let argv;
    try {
      argv = parseArgv(readFileSync(path.join(procRoot, name, 'cmdline')));
    } catch {
      continue; // process exited between readdir and read (or fixture has no cmdline) — skip
    }
    const cmdline = argv.join(' ');
    if (!cmdline) continue; // kernel threads / zombies have empty cmdline — never a real match
    let ppid = null;
    try {
      ppid = parsePpid(readFileSync(path.join(procRoot, name, 'stat'), 'utf8'));
    } catch {
      ppid = null;
    }
    out.push({ pid, ppid, argv, cmdline });
  }
  return out;
}

/**
 * pid + every ancestor up to (and including) pid 1, by walking `ppid` via
 * `byPid` (a Map<pid, ppid|null>). Cycle/depth-guarded so a corrupt or
 * adversarial ppid chain can't loop forever.
 *
 * @param {number} pid
 * @param {Map<number, number | null>} byPid
 * @param {number} [maxHops]
 * @returns {Set<number>}
 */
export function getAncestryChain(pid, byPid, maxHops = 512) {
  /** @type {Set<number>} */
  const chain = new Set();
  let cur = pid;
  let hops = 0;
  while (cur != null && !chain.has(cur) && hops < maxHops) {
    chain.add(cur);
    cur = byPid.has(cur) ? byPid.get(cur) : null;
    hops += 1;
  }
  return chain;
}

/**
 * Processes matching `pattern` (a RegExp source) against operational argv,
 * EXCLUDING the caller's own pid and its whole ancestor chain. Operational argv
 * keeps the executable and real process arguments but excludes agent prompt
 * payloads and peers' structured (JSON) payloads. A genuinely unrelated
 * external process with the same pattern in a real argument still matches.
 *
 * @param {string} pattern - A RegExp source, matched against operational argv.
 * @param {{ procRoot?: string; selfPid?: number }} [opts]
 * @returns {ProcRow[]}
 */
export function matchExternalProcesses(pattern, opts = {}) {
  return matchExternalProcessesDetailed(pattern, opts).matches;
}

/**
 * Return both the liveness-safe matches and the raw-argv matches for audit.
 * `argvTextOnly` contains external processes where the pattern appears only in
 * a prompt payload or a structured (JSON) payload; those must never make a
 * liveness check positive. They stay visible in the counts so a caller can
 * audit what was ignored — nothing is silently dropped.
 *
 * @param {string} pattern - A RegExp source.
 * @param {{ procRoot?: string; selfPid?: number }} [opts]
 * @returns {{ matches: ProcRow[]; fullMatches: ProcRow[]; argvTextOnly: ProcRow[] }}
 */
export function matchExternalProcessesDetailed(pattern, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const selfPid = opts.selfPid ?? process.pid;
  const all = listProcesses(procRoot);
  const byPid = new Map(all.map((p) => [p.pid, p.ppid]));
  const excluded = getAncestryChain(selfPid, byPid);
  const re = new RegExp(pattern);
  const external = all.filter((p) => !excluded.has(p.pid));
  const fullMatches = external.filter((p) => re.test(p.cmdline));
  const matches = external.filter((p) => re.test(getOperationalArgv(p.argv).join(' ')));
  const matchedOperationalPids = new Set(matches.map((p) => p.pid));
  const argvTextOnly = fullMatches.filter((p) => !matchedOperationalPids.has(p.pid));
  return { matches, fullMatches, argvTextOnly };
}

const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';
const DEFAULT_SAMPLE_MS = 10_000;
/** Below this, report the reading as near-zero and print its falsifier. */
const NEAR_ZERO_CORES = 0.05;

/**
 * Parse the cgroup-v2 path out of a `/proc/<pid>/cgroup` body (`0::<path>`).
 *
 * @param {Buffer | string} raw
 * @returns {string | null} null when there is no v2 line (cgroup v1-only host).
 */
export function parseCgroupPath(raw) {
  for (const line of String(raw).split('\n')) {
    const m = /^0::(.*)$/.exec(line.trim());
    if (m) return m[1] || '/';
  }
  return null;
}

/**
 * Parse `usage_usec <n>` out of a cgroup `cpu.stat` body. This counter is
 * MONOTONIC, which is what makes a two-sample delta a true rate even as
 * children spawn and exit between the samples.
 *
 * @param {Buffer | string} raw
 * @returns {number | null}
 */
export function parseUsageUsec(raw) {
  const m = /^usage_usec\s+(\d+)/m.exec(String(raw));
  return m ? Number(m[1]) : null;
}

/**
 * Cores busy = Δusage_usec / elapsed.
 *
 * ⚠ Divide by the MEASURED elapsed time, never by the requested sleep: a
 * loaded box oversleeps, and dividing by the request inflates the rate.
 *
 * @param {number} deltaUsec
 * @param {number} elapsedMs
 * @returns {number | null} null when elapsed is non-positive (rate undefined).
 */
export function computeCoresBusy(deltaUsec, elapsedMs) {
  if (!(elapsedMs > 0)) return null;
  return deltaUsec / 1000 / elapsedMs;
}

/**
 * Two-sample CPU rate over a pid's WHOLE cgroup — the answer to "is it
 * actually WORKING", as opposed to `check`'s "is it RUNNING".
 *
 * The cgroup is the instrument on purpose (EI-20425164406230624): it accounts
 * for EVERY descendant at ANY depth, so nothing can hide below a walk bound.
 * A hand-rolled /proc tree walk reports a confident FALSE IDLE two ways — a
 * depth-bounded walk halts on a 0-tick shell wrapper (this repo's test
 * entrypoint is ~8 levels deep), and one pid's utime+stime+cutime+cstime
 * credits `c*` only on wait(), which vitest never does for its own workers.
 *
 * Returns a discriminated result: an unreadable cgroup is `unknown`, NEVER 0
 * cores — "could not measure" and "measured, idle" must not render alike.
 *
 * @param {number} pid
 * @param {{ procRoot?: string; cgroupRoot?: string; sampleMs?: number;
 *           sleep?: (ms: number) => Promise<void>; now?: () => number }} [opts]
 */
export async function sampleCgroupBusy(pid, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const cgroupRoot = opts.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  let cgPath = null;
  try {
    cgPath = parseCgroupPath(readFileSync(path.join(procRoot, String(pid), 'cgroup'), 'utf8'));
  } catch {
    return { status: 'unknown', reason: 'no-cgroup-entry' };
  }
  if (!cgPath) return { status: 'unknown', reason: 'not-cgroup-v2' };

  const statPath = path.join(cgroupRoot, cgPath, 'cpu.stat');
  const readUsage = () => {
    try {
      return parseUsageUsec(readFileSync(statPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const a = readUsage();
  if (a === null) return { status: 'unknown', reason: 'cpu-stat-unreadable', cgroupPath: cgPath };
  const t0 = now();
  await sleep(sampleMs);
  const b = readUsage();
  const elapsedMs = now() - t0;
  if (b === null) return { status: 'unknown', reason: 'cpu-stat-unreadable', cgroupPath: cgPath };
  const cores = computeCoresBusy(b - a, elapsedMs);
  if (cores === null) return { status: 'unknown', reason: 'zero-elapsed', cgroupPath: cgPath };

  let procs = null;
  try {
    procs = readFileSync(path.join(cgroupRoot, cgPath, 'cgroup.procs'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '').length;
  } catch {
    /* the proc count is a nicety; the rate is the answer */
  }
  return { status: 'ok', cores, procs, elapsedMs, cgroupPath: cgPath };
}

/** Render one `--busy` line (+ its falsifier when near-zero). Pure, so the
 *  wording is pinned by tests rather than by eyeballing terminal output. */
export function formatBusy(sample) {
  if (sample.status !== 'ok') {
    return [
      `busy: UNKNOWN (${sample.reason}) — this is NOT "idle"; the cgroup could not be read`,
    ];
  }
  const secs = (sample.elapsedMs / 1000).toFixed(1);
  const out = [
    `busy: ${sample.cores.toFixed(2)} core(s) over ${secs}s across ${sample.procs ?? '?'} proc(s) in ${sample.cgroupPath}`,
  ];
  if (sample.cores < NEAR_ZERO_CORES) {
    out.push(
      `⚠ near-zero — before calling this STALLED: if the pid is a SUPERVISOR its children may sit in a DIFFERENT cgroup, so check the proc count above (1 proc often means you measured the wrapper, not the work).`,
    );
  }
  return out;
}

async function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const [cmd, pattern] = positional;
  const busy = flags.includes('--busy');
  const sampleMsFlag = flags.find((f) => f.startsWith('--sample-ms='));
  const sampleMs = sampleMsFlag ? Number(sampleMsFlag.slice('--sample-ms='.length)) : DEFAULT_SAMPLE_MS;
  if (cmd !== 'check' || !pattern || !(sampleMs > 0)) {
    console.error(
      'usage: node scripts/proc-guard.mjs check <pattern> [--busy] [--sample-ms=<n>]\n' +
        '  --busy  also answer "is it WORKING" — a two-sample cgroup CPU rate per match,\n' +
        '          which sees every descendant at any depth (a /proc tree walk does not).',
    );
    process.exit(2);
    return;
  }
  const report = matchExternalProcessesDetailed(pattern);
  const { matches, fullMatches, argvTextOnly } = report;
  if (matches.length === 0) {
    if (fullMatches.length > 0) {
      console.log(
        `proc-guard: no external process matches /${pattern}/ (${fullMatches.length} full-argv match(es), all ${argvTextOnly.length} argv-text-only; ignored)`,
      );
    } else {
      console.log(`proc-guard: no external process matches /${pattern}/`);
    }
    process.exit(1);
    return;
  }
  const rawSuffix =
    fullMatches.length === matches.length
      ? ''
      : ` (${fullMatches.length} full-argv match(es): ${argvTextOnly.length} argv-text-only ignored)`;
  console.log(`proc-guard: ${matches.length} external process(es) match /${pattern}/${rawSuffix}:`);
  for (const m of matches) {
    console.log(`  ${m.pid}  ${m.cmdline}`);
    if (!busy) continue;
    const sample = await sampleCgroupBusy(m.pid, { sampleMs });
    for (const line of formatBusy(sample)) console.log(`         ${line}`);
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // main() is async now (--busy samples over time); without this catch a throw
  // becomes an unhandled rejection whose exit code is NOT the guard's contract.
  main(process.argv.slice(2)).catch((e) => {
    console.error(`proc-guard: ${e?.message ?? e}`);
    process.exit(2);
  });
}

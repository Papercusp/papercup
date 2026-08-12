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
 *   getOperationalArgv(argv)              -> argv with known prompt payloads removed
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
 * Remove known agent-launch prompt payloads from argv before process matching.
 * The executable and every non-prompt argument remain eligible, so commands
 * such as `qemu-system-x86_64 ... mac_hdd_ng.img` retain their target args.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function getOperationalArgv(argv) {
  return argv.filter((arg, index) => index === 0 || !PROMPT_ARG_MARKERS.some((marker) => arg.includes(marker)));
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
 * keeps the executable and real process arguments but excludes known agent
 * prompt payloads. A genuinely unrelated external process with the same
 * pattern in a real argument still matches.
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
 * a recognized prompt payload; those must never make a liveness check positive.
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

function main(argv) {
  const [cmd, pattern] = argv;
  if (cmd !== 'check' || !pattern) {
    console.error('usage: node scripts/proc-guard.mjs check <pattern>');
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
  for (const m of matches) console.log(`  ${m.pid}  ${m.cmdline}`);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main(process.argv.slice(2));

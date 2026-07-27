#!/usr/bin/env node
/**
 * One live process, as read out of `/proc`.
 *
 * @typedef {object} ProcRow
 * @property {number} pid
 * @property {number | null} ppid - null when `/proc/<pid>/stat` was unreadable or unparseable.
 * @property {string} cmdline - Full command line, NUL separators replaced by spaces.
 */
/**
 * Parse a NUL-separated /proc/<pid>/cmdline buffer into a display string (space-joined args).
 *
 * @param {Buffer | string} raw
 * @returns {string}
 */
export function parseCmdline(raw: Buffer | string): string;
/**
 * Parse the ppid out of a /proc/<pid>/stat line. The comm field (2nd field) is
 * parenthesized and may itself contain spaces/parens, so field-splitting must
 * resume from the LAST `)` rather than naively splitting on whitespace — the
 * kernel guarantees fields after that point never contain unescaped `)`.
 *
 * @param {string} statLine
 * @returns {number | null}
 */
export function parsePpid(statLine: string): number | null;
/**
 * Enumerate every live process as { pid, ppid, cmdline }, from a /proc root (real or a test fixture).
 *
 * @param {string} [procRoot] - Defaults to `/proc`; a fixture directory in tests.
 * @returns {ProcRow[]}
 */
export function listProcesses(procRoot?: string): ProcRow[];
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
export function getAncestryChain(pid: number, byPid: Map<number, number | null>, maxHops?: number): Set<number>;
/**
 * Processes matching `pattern` (a RegExp source — `pgrep -f` semantics: matched
 * against the full cmdline), EXCLUDING the caller's own pid and its whole
 * ancestor chain. This is the guard primitive: a caller running inside a
 * `bash -c` / `-lic` wrapper whose own command line happens to contain
 * `pattern` is never reported as a match, while a genuinely unrelated external
 * process with the same pattern in its cmdline still is.
 *
 * @param {string} pattern - A RegExp source, matched against the full cmdline.
 * @param {{ procRoot?: string; selfPid?: number }} [opts]
 * @returns {ProcRow[]}
 */
export function matchExternalProcesses(pattern: string, opts?: {
    procRoot?: string;
    selfPid?: number;
}): ProcRow[];
/**
 * One live process, as read out of `/proc`.
 */
export type ProcRow = {
    pid: number;
    /**
     * - null when `/proc/<pid>/stat` was unreadable or unparseable.
     */
    ppid: number | null;
    /**
     * - Full command line, NUL separators replaced by spaces.
     */
    cmdline: string;
};

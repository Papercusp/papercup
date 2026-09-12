/**
 * psu-pty-host — the production managed-PTY host for interactive psu sessions
 * (turn-lifecycle-control-2026-06-08 Phase 3, P-012/P-013/P-014; D-006/D-011).
 *
 * Why: by default `psu` launches the agent with `stdio:'inherit'` straight into
 * the user's terminal, so the operator doesn't own its stdin — a wake can only
 * PARK + inbox-nudge the live session (wake-executor Channel 3: "alive but not
 * an injectable managed pty"). This module instead launches the agent attached
 * to a `@lydell/node-pty` managed pty and bridges the user's real TTY <-> the
 * pty, exposing an owner-only control socket. The operator reaches that socket
 * to INJECT a wake turn (or, Phase 4, an interrupt) into the LIVE session.
 *
 * Crucial ownership boundary (D-006): the pty + control socket live IN THE PSU
 * PROCESS, not the operator. The operator only CONNECTS to the socket; an
 * operator restart never disturbs the human's session. This sidesteps the
 * operator-lifecycle coupling an operator-hosted pty would have.
 *
 * Security (D-011): the control socket lets a connector inject keystrokes into
 * an agent running with permissions bypassed — an injected line is effectively
 * command execution as this user. So the dir is 0700, the socket is 0600, and a
 * tight umask wraps the bind so the node is never even briefly world-accessible.
 * Same-UID is the OS boundary; per-agent auth/audit/rate-limit is layered on top
 * by the operator-mediated `turn:interrupt` tool (D-008, Phase 4).
 *
 * Discovery (P-014): the host writes a discovery file
 *   ~/.papercusp/psu-pty/<ownerId>.json  =  { ownerId, advSessionId, pid, ptyPid, sock, command, startedAt }
 * keyed by the session's coord ownerId (PAPERCUSP_SID — the same key the wake
 * handle joins on). The operator's wake-executor reads this dir to find a live
 * session's socket. The contract (dir + filename + {ownerId,pid,sock}) is
 * mirrored read-side in packages/operator-core/lib/events/await/psu-pty-discovery.ts —
 * keep the two in lockstep. A local-FS discovery file (not PG) is deliberate:
 * the socket is a same-host, process-lifetime-bound IPC resource that must be
 * removed on process exit, exactly like ~/.papercusp/voice-ipc.json /
 * embedded-pg.json.
 *
 * Derived from the validated psupty.mjs spike (which proved the feel + the
 * inject path end-to-end); this is the reusable, gated, operator-discoverable
 * version wired into psu-launcher's runWrapper.
 */

import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { constants as osConstants, homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  realpathSync,
  chmodSync,
  renameSync,
  appendFileSync,
  closeSync,
  fsyncSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import net from 'node:net';

/** Environment fragments injected by launchers and tests need not carry every
 * ambient key that an application framework merges into NodeJS.ProcessEnv.
 * @typedef {Record<string, string | undefined>} EnvironmentMap
 */

/**
 * The environment key used by a headless spawn to give this host a separate,
 * grep-safe copy of the child PTY stream. The ordinary stdout path remains
 * byte-oriented/raw for the existing lifecycle and activity consumers.
 */
export const HEADLESS_NORMALIZED_LOG_ENV = 'PAPERCUSP_PSU_HEADLESS_NORMALIZED_LOG';

const require = createRequire(import.meta.url);

/** This script's own directory — used to locate sibling scripts (the session-compacted
 *  emit CLI) and the checkout root. */
const HOST_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** This script's own path — the file whose LOADED contents this process runs.
 *  Separate from HOST_SCRIPT_DIR because WI-38292 needs the file, not the dir. */
const HOST_SCRIPT_PATH = fileURLToPath(import.meta.url);

/** WI-38292: sha256 of a host script ON DISK, or null when unreadable.
 *  `path` is overridable so the staleness guard below can be proven falsifiable
 *  against a COPY outside the checkout — never by mutating this file in the
 *  shared tree, which git-sync would sweep into a commit mid-probe. */
export function hashHostScript(path = HOST_SCRIPT_PATH) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** WI-38292: the psu-pty-host version THIS PROCESS IS ACTUALLY RUNNING, frozen at
 *  module load. psu-launcher.mjs imports this module ONCE into a long-lived process
 *  and `recycleChild` only ever replaces the CLI child, so a deployed host fix stays
 *  inert here until the whole launcher restarts. Capturing the hash at load is what
 *  makes that detectable at all: it is the only value in the process that still
 *  describes the code actually executing after the file on disk moves on. */
export const LOADED_HOST_CODE_VERSION = hashHostScript();

/** WI-38292: is this host executing code older than what is on disk?
 *  `stale` is true ONLY when both hashes are known and differ — an unreadable file
 *  degrades to "not stale" so a transient fs error can never turn a working respawn
 *  path into a warning storm. Pure + exported for tests. */
export function hostCodeStaleness({
  loaded = LOADED_HOST_CODE_VERSION,
  path = HOST_SCRIPT_PATH,
} = {}) {
  const onDisk = hashHostScript(path);
  return { stale: Boolean(loaded && onDisk && loaded !== onDisk), loaded, onDisk };
}

/** WI-38292: the exit code that asks the psu shim's re-exec loop to re-run the
 *  launcher from disk. MIRRORS `PSU_REEXEC_EXIT_CODE` in
 *  packages/operator-core/lib/desktop-install/papercusp-files.ts — this file is
 *  bare ESM run by `node` and cannot import TS, so the two copies are pinned
 *  together by a test rather than by the module system. */
export const PSU_REEXEC_EXIT_CODE = 87;

/** WI-38292: does the process that launched us promise to re-run us if we exit
 *  with the sentinel? The shim exports `PAPERCUSP_PSU_REEXEC=<code>`; anything
 *  else (an old shim, an operator-spawned headless member, a packaged CLI
 *  wrapper, a direct `node psu-launcher.mjs`) means NOBODY would re-run us, so
 *  the adopting path must never be taken. Returns the code to exit with, or
 *  null. `PAPERCUSP_PSU_HOST_ADOPT=0` is the kill switch — same boot-mode-select
 *  role as PAPERCUSP_CACHE_PROXY_ROUTE, not a product feature gate.
 *  @param {EnvironmentMap} [env]
 */
export function reexecExitCodeFrom(env = process.env, ppid = process.ppid) {
  if (String(env.PAPERCUSP_PSU_HOST_ADOPT ?? '').trim() === '0') return null;
  // Number(), NOT parseInt(): parseInt('87.5') is 87 and parseInt('87abc') is 87,
  // so a malformed advertisement would read as a valid promise to re-run us.
  const advertised = Number(String(env.PAPERCUSP_PSU_REEXEC ?? '').trim() || NaN);
  if (!(Number.isInteger(advertised) && advertised > 0 && advertised < 256)) return null;
  // The advertisement must come from OUR OWN PARENT. Environment variables are
  // inherited by every descendant, so without this a nested launch — an agent
  // running `psu` from inside a psu terminal, a direct `node psu-launcher.mjs`,
  // anything spawned by the CLI child — would read a psu shim's promise as if it
  // had been made to IT. Exiting on that inherited promise kills the session
  // outright: the loop that would have re-run it belongs to a different process
  // entirely. The shim publishes its own pid, and bash is still alive as our
  // parent precisely because the loop does not `exec`.
  const advertiser = Number(String(env.PAPERCUSP_PSU_REEXEC_PPID ?? '').trim() || NaN);
  if (!Number.isInteger(advertiser) || advertiser !== ppid) return null;
  return advertised;
}

/**
 * A host-code adoption re-exec is safe only when no human terminal is bridged.
 * Interactive carry-respawns must stay inside the current PTY host: exiting the
 * launcher visibly tears down the TUI and a missed successor handoff falls into
 * the fresh-session wizard. Headless hosts have no such continuity boundary and
 * may still adopt current on-disk host code.
 */
export function shouldAdoptHostCode({ onReexec, reexecCode, bridgeTty }) {
  return Boolean(onReexec && reexecCode && !bridgeTty);
}

/** The discovery dir. Owner-only (0700). Shared contract with the read side
 *  (operator-core psu-pty-discovery.ts). */
export const PSU_PTY_DIR = join(homedir(), '.papercusp', 'psu-pty');

/** How long the host waits for the user's input line to go idle before writing
 *  an injected turn into the pty (P-013 mid-keystroke safety). A burst of typing
 *  defers the inject until this much quiet has passed. */
const DEFAULT_IDLE_MS = Number(process.env.PAPERCUSP_PSU_PTY_IDLE_MS) || 750;
/** Cap on how long an inject will wait for idle before giving up and writing
 *  anyway — a wake must not be deferred forever by a user who keeps typing. */
const DEFAULT_IDLE_WAIT_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS) || 8_000;

/** Hard ceiling for one control-socket message. The socket is same-UID, but it
 * is still an untrusted streaming boundary: buffering until EOF without a cap
 * lets a wedged or compromised connector grow this long-lived host without
 * bound. Eight MiB is deliberately large enough for the biggest supported
 * session-port seed while keeping the allocation deterministic. Mirrored by
 * operator-core/lib/events/await/psu-pty-discovery.ts. */
export const MAX_CONTROL_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Environment keys for the optional detached kickoff-proof rendezvous. Keep
 * these string-identical to operator-core/lib/console-spawn.ts: this host is a
 * standalone ESM process and cannot import the TypeScript module. */
export const KICKOFF_PROOF_PATH_ENV = 'PAPERCUSP_KICKOFF_PROOF_PATH';
export const KICKOFF_PROOF_TOKEN_ENV = 'PAPERCUSP_KICKOFF_PROOF_TOKEN';
const KICKOFF_PROOF_TOKEN_RE = /^[a-f0-9]{48}$/i;

/**
 * Publish the parent-visible proof for a plain launch kickoff.
 *
 * The parent creates an empty 0600 file before detaching the child and passes
 * its path plus a random token through the existing PAPERCUSP_* environment
 * chain. Treat both values as untrusted at this boundary: only replace an
 * absolute, same-UID, regular 0600 empty placeholder, and never follow a
 * symlink. The receipt is written to a unique same-directory 0600 temporary
 * file, fsynced, and atomically renamed over that exact placeholder. A failed
 * publication is returned as a negative result so a receipt problem can never
 * tear down an otherwise usable host.
 *
 * @param {{persisted?: boolean, nativeRef?: string | null, reason?: string | null}} proof
 * @param {EnvironmentMap} [env]
 * @returns {{published: boolean, reason?: string}}
 */
export function publishKickoffProofReceipt(proof, env = process.env) {
  const rawPath = env?.[KICKOFF_PROOF_PATH_ENV];
  const rawToken = env?.[KICKOFF_PROOF_TOKEN_ENV];
  if (rawPath == null && rawToken == null) {
    return { published: false, reason: 'kickoff-proof-request-missing' };
  }
  if (typeof rawPath !== 'string' || typeof rawToken !== 'string') {
    return { published: false, reason: 'kickoff-proof-request-malformed' };
  }
  const path = rawPath;
  const token = rawToken;
  if (!isAbsolute(path) || path.includes(String.fromCharCode(0))) {
    return { published: false, reason: 'kickoff-proof-path-invalid' };
  }
  if (!KICKOFF_PROOF_TOKEN_RE.test(token)) {
    return { published: false, reason: 'kickoff-proof-token-invalid' };
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const assertPlaceholder = () => {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('kickoff-proof placeholder is not a regular file');
    }
    if ((before.mode & 0o777) !== 0o600 || before.size !== 0) {
      throw new Error('kickoff-proof placeholder is not an empty 0600 file');
    }
    if (currentUid == null || before.uid !== currentUid) {
      throw new Error('kickoff-proof placeholder is not owned by this parent uid');
    }
    const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.size !== 0 ||
        opened.uid !== currentUid
      ) {
        throw new Error('kickoff-proof placeholder changed during secure open');
      }
      return { dev: opened.dev, ino: opened.ino };
    } finally {
      closeSync(fd);
    }
  };

  let tempPath = null;
  let tempFd = null;
  try {
    const original = assertPlaceholder();
    const persisted = proof?.persisted === true;
    const nativeRef = typeof proof?.nativeRef === 'string' ? proof.nativeRef : null;
    const reason =
      typeof proof?.reason === 'string'
        ? proof.reason
        : persisted
          ? null
          : 'native-turn-marker-timeout';
    const receipt = JSON.stringify({ token, persisted, nativeRef, reason });
    const dir = dirname(path);
    const base = path.slice(path.lastIndexOf('/') + 1);
    tempPath = join(
      dir,
      '.' + base + '.tmp-' + process.pid + '-' + randomBytes(12).toString('hex'),
    );
    tempFd = openSync(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(tempFd, receipt, { encoding: 'utf8' });
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    chmodSync(tempPath, 0o600);

    // Re-check the inode after the potentially slow receipt write. This closes
    // the ordinary replacement race; rename itself never follows a symlink.
    const stillPlaceholder = assertPlaceholder();
    if (stillPlaceholder.dev !== original.dev || stillPlaceholder.ino !== original.ino) {
      throw new Error('kickoff-proof placeholder changed before atomic publish');
    }
    renameSync(tempPath, path);
    tempPath = null;
    return { published: true };
  } catch {
    return { published: false, reason: 'kickoff-proof-receipt-publish-failed' };
  } finally {
    if (tempFd != null) {
      try { closeSync(tempFd); } catch { /* best-effort */ }
    }
    if (tempPath) {
      try { unlinkSync(tempPath); } catch { /* best-effort */ }
    }
  }
}

/** Byte-accurate (not JS-code-unit) wire limit check. Exported so the exact
 * UTF-8 boundary is regression-tested without weakening the runtime guard. */
export function controlPayloadWithinLimit(payload, maxBytes = MAX_CONTROL_PAYLOAD_BYTES) {
  const bytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload), 'utf8');
  return bytes <= maxBytes;
}

/** Read a server-owned session-port seed without following a same-UID symlink.
 * The file is deliberately kept until the operator accepts native-persistence
 * proof; reading it is not delivery and therefore never consumes it. */
export function readManagedKickoffFile(path, expectedRenderedHash) {
  if (!path || !/^[0-9a-f]{64}$/i.test(String(expectedRenderedHash ?? ''))) {
    throw new Error('managed kickoff requires a file and rendered hash');
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('managed kickoff is not a regular file');
  if ((before.mode & 0o077) !== 0) throw new Error('managed kickoff permissions are broader than 0600');
  if (before.size <= 0 || before.size > MAX_CONTROL_PAYLOAD_BYTES) {
    throw new Error(`managed kickoff exceeds ${MAX_CONTROL_PAYLOAD_BYTES} byte cap`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('managed kickoff changed during secure open');
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size || bytes.length > MAX_CONTROL_PAYLOAD_BYTES) {
      throw new Error('managed kickoff changed size during read');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('managed kickoff is not valid UTF-8');
    const marker = `[PAPERCUSP SESSION PORT CHECKSUM ${expectedRenderedHash}]`;
    if (!text.includes(marker)) throw new Error('managed kickoff checksum marker mismatch');
    return { text, marker, renderedHash: expectedRenderedHash, bytes: bytes.length };
  } finally {
    closeSync(fd);
  }
}

/** Dedicated verified provenance for the imported-history first turn. It is
 * neither owner input nor a fleet kickoff. Mirror the turn-provenance JSONL
 * envelope/ledger protocol; write the ledger row before PTY submission.
 * @param {string} text
 * @param {string} sid
 * @param {EnvironmentMap} [env]
 * @param {number} [nowMs]
 */
export function tagSessionPortTurn(text, sid, env = process.env, nowMs = Date.now()) {
  if (!text || !sid) throw new Error('session-port provenance requires seed text and target sid');
  const nonce = randomBytes(8).toString('hex');
  const sha256 = createHash('sha256')
    .update(String(text).replace(/\r\n?/g, '\n').trim(), 'utf8')
    .digest('hex');
  const dir = env.PAPERCUSP_TURN_PROVENANCE_DIR || join(homedir(), '.papercusp', 'turn-provenance');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const safe = sanitizeKey(sid);
  appendFileSync(
    join(dir, `${safe}.jsonl`),
    JSON.stringify({ sid, nonce, origin: 'session-port', sha256, ts: nowMs }) + '\n',
    { mode: 0o600 },
  );
  return `⟦turn-origin:session-port nonce:${nonce}⟧\n${text}`;
}

/** Chunk a large paste without splitting a UTF-16 surrogate pair. 16k code
 * units is at most 64 KiB of UTF-8, keeping node-pty writes bounded while the
 * concatenated stream remains byte-identical. */
export function ptyWriteChunks(value, maxCodeUnits = 16 * 1024) {
  const text = String(value ?? '');
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxCodeUnits);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    if (end <= start) end = Math.min(text.length, start + 2);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function nativeTranscriptRoot(agent, env, home) {
  if (agent === 'claude') {
    const root = env.CLAUDE_CONFIG_DIR ? String(env.CLAUDE_CONFIG_DIR) : join(home, '.claude');
    return join(root, 'projects');
  }
  if (agent === 'codex') {
    const root = env.CODEX_HOME ? String(env.CODEX_HOME) : join(home, '.codex');
    return join(root, 'sessions');
  }
  if (agent === 'omp') {
    if (env.PI_CODING_AGENT_DIR) return join(String(env.PI_CODING_AGENT_DIR), 'sessions');
    const configured = String(env.PI_CONFIG_DIR || '.omp');
    const root = isAbsolute(configured) ? configured : join(home, configured);
    return join(root, 'agent', 'sessions');
  }
  return null;
}

/** The carry prompt's unique first line is the strongest cross-backend proof
 * that the fresh native transcript accepted THIS successor turn. */
export function leadingTurnOriginMarker(text) {
  const firstLine = String(text ?? '').replace(/\r\n?/g, '\n').split('\n', 1)[0].trim();
  return /^⟦turn-origin:[a-z0-9][a-z0-9-]* nonce:[a-f0-9]{16,64}⟧$/i.test(firstLine)
    ? firstLine
    : null;
}

/** Find the exact port marker in a recently-written target-native JSONL. This
 * is the delivery authority: PTY output/activity is intentionally insufficient.
 * @param {{agent: string, env?: EnvironmentMap, marker: string, sinceMs: number,
 *   home?: string, nativeId?: string | null}} options
 */
export function findNativeTranscriptMarker({
  agent,
  env = process.env,
  marker,
  sinceMs,
  home = homedir(),
  nativeId = null,
}) {
  const root = nativeTranscriptRoot(agent, env, home);
  if (!root || !existsSync(root) || !marker) return null;
  const markerBytes = Buffer.from(marker, 'utf8');
  const stack = [{ path: root, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 4096) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 4096) break;
      const path = join(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < 10) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      // A carry-respawn mints a fresh native id. Restricting the proof to that
      // file prevents a coincidental marker in an older transcript from
      // certifying the successor that actually stayed mute.
      if (nativeId && !entry.name.includes(String(nativeId))) continue;
      try {
        const st = statSync(path);
        if (st.mtimeMs < sinceMs - 5_000 || st.size < markerBytes.length || st.size > 64 * 1024 * 1024) continue;
        if (readFileSync(path).includes(markerBytes)) return path;
      } catch {
        /* a concurrently-rotated transcript is simply not proof yet */
      }
    }
  }
  return null;
}

/** A carry requested in THIS turn may use its exact native completion as a
 * safe boundary even while the terminal keeps repainting. Never scan other
 * sessions or accept an older turn's completion. Missing/partial proof falls
 * back to the existing output gate. */
export function codexCarryTurnCompleted({ agent, env, transcriptPath, receivedAtMs }) {
  if (agent !== 'codex' || !env?.CODEX_HOME || !transcriptPath || !Number.isFinite(receivedAtMs)) return false;
  let fd;
  try {
    const root = realpathSync(join(env.CODEX_HOME, 'sessions'));
    const path = realpathSync(transcriptPath);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !path.endsWith('.jsonl')) return false;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0) return false;
    const length = Math.min(info.size, 256 * 1024);
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, info.size - length);
    let tail = bytes.subarray(0, read).toString('utf8');
    if (!tail.endsWith('\n')) return false; // the newest record is still being written
    if (info.size > length) tail = tail.slice(tail.indexOf('\n') + 1);
    let completed = false;
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type !== 'event_msg') continue;
      const kind = row.payload?.type;
      if (kind === 'task_started' || kind === 'user_message' || kind === 'turn_aborted') completed = false;
      if (kind === 'task_complete' || kind === 'turn_completed') {
        const at = Date.parse(row.timestamp);
        completed = Number.isFinite(at) && at >= receivedAtMs && at <= Date.now()
          && typeof row.payload?.turn_id === 'string' && row.payload.turn_id.length > 0;
      }
    }
    return completed;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Return the newest regular Codex rollout beneath this session's isolated
 * CODEX_HOME. A resumed/carry chain can contain several native threads in the
 * same home, so an ordinary warm wake must follow the current writer rather
 * than pinning the predecessor path forever. Symlinks and paths outside the
 * sessions root are never candidates; traversal shares the native-proof cap. */
function newestCodexTranscriptPath(env) {
  if (!env?.CODEX_HOME) return null;
  let root;
  try { root = realpathSync(join(env.CODEX_HOME, 'sessions')); }
  catch { return null; }
  const stack = [{ path: root, depth: 0 }];
  let visited = 0;
  let newest = null;
  while (stack.length && visited < 4096) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 4096) break;
      const path = join(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < 10) stack.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size === 0 || st.size > 64 * 1024 * 1024) continue;
        if (!newest || st.mtimeMs > newest.mtimeMs || (st.mtimeMs === newest.mtimeMs && path > newest.path)) {
          newest = { path, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* a concurrently-rotated rollout is simply not a boundary candidate */
      }
    }
  }
  return newest?.path ?? null;
}

/** An ordinary warm Codex wake may use the CURRENT native turn's settled state
 * as its prompt boundary when idle TUI repaint prevents OUTPUT_QUIET_MS from
 * ever elapsing. Unlike the carry-specific probe above, this follows the newest
 * rollout in the session's isolated CODEX_HOME and accepts a completion that
 * predates the arriving wake. `completedAtOrAfterMs` fences out the preceding
 * completion after any newer owner/machine submit, so a mid-turn wake cannot
 * use stale history to bypass the anti-wedge gate. Missing/partial proof stays
 * false and falls back to the existing output-silence gate. */
export function codexLatestTurnCompleted({
  agent,
  env,
  completedAtOrAfterMs = 0,
}) {
  if (agent !== 'codex' || !Number.isFinite(completedAtOrAfterMs)) return false;
  const transcriptPath = newestCodexTranscriptPath(env);
  return transcriptPath
    ? codexCarryTurnCompleted({ agent, env, transcriptPath, receivedAtMs: completedAtOrAfterMs })
    : false;
}

/**
 * @param {{agent: string, env?: EnvironmentMap, marker: string, sinceMs: number,
 *   home?: string, timeoutMs?: number, pollMs?: number, nativeId?: string | null}} options
 */
export async function waitForNativeTranscriptMarker({
  agent,
  env = process.env,
  marker,
  sinceMs,
  home = homedir(),
  timeoutMs = 30_000,
  pollMs = 250,
  nativeId = null,
}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const nativeRef = findNativeTranscriptMarker({ agent, env, marker, sinceMs, home, nativeId });
    if (nativeRef) return { persisted: true, nativeRef };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
  return { persisted: false, nativeRef: null };
}

/**
 * Prove that a provenance-tagged turn actually entered the backend's native
 * transcript. PTY output is not authority: pressing Enter can repaint the TUI
 * while leaving the staged text unsubmitted (EI-21653971965333993 / WI-2930).
 *
 * One raw-CR retry mirrors the operator's documented stuck-composer recovery.
 * Callers decide how to dispose a still-unverified child; this helper only
 * returns the execution-backed verdict. Pure apart from the injected wait/write
 * callbacks, so launch and carry paths share one tested contract.
 */
export async function verifyNativeTurnStartWithRetry({
  agent,
  env = process.env,
  text,
  sinceMs,
  home = homedir(),
  timeoutMs = 30_000,
  nativeId = null,
  requireNativeId = false,
  waitForMarker = waitForNativeTranscriptMarker,
  writeCr = () => {},
  onRetry = () => {},
}) {
  const marker = leadingTurnOriginMarker(text);
  const proofSupported = ['claude', 'codex', 'omp'].includes(String(agent || ''));
  if (!marker) {
    return {
      persisted: false,
      nativeRef: null,
      retried: false,
      reason: 'missing-leading-turn-origin',
    };
  }
  if (requireNativeId && !nativeId) {
    return {
      persisted: false,
      nativeRef: null,
      retried: false,
      reason: 'missing-native-id',
    };
  }
  if (!proofSupported) {
    return {
      persisted: false,
      nativeRef: null,
      retried: false,
      reason: 'unsupported-backend',
    };
  }
  const readProof = () =>
    waitForMarker({
      agent,
      env,
      marker,
      sinceMs,
      home,
      timeoutMs,
      nativeId,
    });
  let proof = await readProof();
  if (proof?.persisted) {
    return {
      persisted: true,
      nativeRef: proof.nativeRef ?? null,
      retried: false,
      reason: null,
    };
  }
  try {
    onRetry({ marker, nativeId });
  } catch {
    /* retry observability must never block the recovery keystroke */
  }
  try {
    writeCr();
  } catch {
    /* the child may have exited while native persistence was checked */
  }
  proof = await readProof();
  return {
    persisted: Boolean(proof?.persisted),
    nativeRef: proof?.nativeRef ?? null,
    retried: true,
    reason: proof?.persisted ? null : 'native-turn-marker-timeout',
  };
}

/** WI-2140591: how long the host watches for the model to actually START the
 *  kickoff turn, once the native marker has proven the prompt was accepted.
 *
 *  The marker proof establishes SUBMISSION, never EXECUTION — and the two come
 *  apart exactly under load. Codex can accept the prompt, exhaust its sampling
 *  retries (`codex_core::responses_retry: stream disconnected — retrying
 *  sampling request 5/5, sampling_error="high demand"`) and then emit no
 *  assistant turn at all. The marker is still in the transcript, so the host
 *  printed "kickoff delivered" and returned, leaving a LIVE child idle forever:
 *  seven consecutive fleet goal holders on 2026-09-01 (12:29–14:02Z) each
 *  produced nothing but their boot `activity:report`.
 *
 *  Cadence deliberately mirrors the submit verifier (WI-2975): requiring an
 *  ENTIRE budget of ZERO new output is a far stronger "nothing happened" signal
 *  than a short quiet threshold, because a generating agent repaints its TUI
 *  continuously (spinner / elapsed counter) and a merely slow one still repaints
 *  while it retries. Set POLLS to 0 to disable the observation outright. */
const KICKOFF_TURN_START_POLL_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS) || 5_000;
const KICKOFF_TURN_START_POLLS = (() => {
  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and
  // silently removes the kill switch for a path every fleet launch runs.
  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 6;
})();

/**
 * Did the model actually begin the kickoff turn? Returns as soon as ANY new pty
 * output appears after the baseline, otherwise reports a stall once the whole
 * budget has elapsed with zero new bytes.
 *
 * Keyed on "new output since a baseline" rather than "output is quiet NOW",
 * because a healthy short turn ALSO ends quiet — quiet alone would flag every
 * fast kickoff. A turn that died at the sampling layer is distinguishable
 * precisely because it produces nothing whatsoever after the prompt is accepted.
 *
 * Fails SAFE: a disabled or zero-length budget reports `started:true` with
 * `observed:false`, so a caller never takes recovery action on an observation
 * that never ran. Pure apart from the injected reader/wait.
 */
export async function observeKickoffModelTurnStart({
  lastOutputAt = () => 0,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = KICKOFF_TURN_START_POLL_MS,
  polls = KICKOFF_TURN_START_POLLS,
} = {}) {
  const budgetMs = Math.max(0, pollMs) * Math.max(0, polls);
  if (!(pollMs > 0) || !(polls > 0)) {
    return { started: true, observed: false, polls: 0, budgetMs: 0, reason: 'observation-disabled' };
  }
  const baseline = Number(lastOutputAt()) || 0;
  for (let poll = 0; poll < polls; poll += 1) {
    await wait(pollMs);
    if ((Number(lastOutputAt()) || 0) > baseline) {
      return { started: true, observed: true, polls: poll + 1, budgetMs, reason: null };
    }
  }
  return {
    started: false,
    observed: true,
    polls,
    budgetMs,
    reason: 'no-model-output-after-kickoff',
  };
}

/** A carry-respawn can bind transcript proof to a native session id only when
 * the backend actually mints one. Claude does; Codex deliberately starts a
 * fresh thread without exposing its id, so its unique turn-origin marker plus
 * the post-respawn mtime floor is the strongest available native proof. Unknown
 * backends stay fail-closed. */
export function carryTurnProofRequiresNativeId(agent) {
  return String(agent ?? '').trim().toLowerCase() !== 'codex';
}

/** After writing an injected TURN's text, the host sends the submit Enter (CR)
 *  as a SEPARATE keystroke this long later. A single `text + CR` burst is
 *  swallowed by the Claude Code TUI's paste detector — the CR lands as a literal
 *  newline in the input box and the turn sits UNSUBMITTED until a human presses
 *  Enter ("the wake text appeared but the turn didn't start"). An isolated CR,
 *  arriving after the paste settles, registers as a real submit. */
const TURN_SUBMIT_CR_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS) || 150;
/** Codex's compose box needs a longer settle before the submit CR. With the
 *  Claude-tuned delay, live coord injections can leave the text sitting in
 *  Codex's input box until a human presses Enter. */
const CODEX_TURN_SUBMIT_CR_DELAY_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS) || 500;
/** If Codex treats the first submit CR as paste/input, the text is visibly left
 *  in the compose box. A second delayed CR is the same manual action the user
 *  had to take, but delivered by the host. Codex-only; Claude/OMP stay single-CR. */
const CODEX_TURN_RESUBMIT_CR_DELAY_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS) || 300;

/** WI-2930 submit VERIFICATION. An injected submit's CR can be SWALLOWED on any
 *  backend — the paste-settle race exists on Claude too, and a compact/reset
 *  carry can be typed into a TUI whose submission is momentarily locked (the
 *  agent-busy gate reads "compaction done" off output-quiet, which a silent
 *  summarizer gap / the post-compaction context-restore can fake). The failure
 *  is invisible-but-fatal: the turn text sits staged in the composer and the
 *  session parks until a human presses Enter (owner-reported, 6h stall).
 *  So after the FINAL CR of any injected submit the host VERIFIES instead of
 *  firing-and-forgetting: it polls the pty-output activity for a bounded window
 *  and, at each poll that finds the output QUIET (no turn running — a submitted
 *  turn repaints continuously), injects one bare resubmit CR. A bare CR at an
 *  idle prompt with an EMPTY composer is a no-op, so a redundant resubmit is
 *  harmless; one with staged text is exactly the Enter a human would press.
 *  WI-2975 ADDENDUM: "harmless" covered the retype-safety, not the noise — the
 *  quiet check originally reused OUTPUT_QUIET_MS (the busy-gate's short
 *  "back-at-prompt" threshold), so an ordinary silent thinking/latency gap
 *  after a genuine submit was misread as a stall on nearly every compaction,
 *  printing spurious "submit not confirmed" resubmit lines even on a fully
 *  successful compact + carry-note. The verifier now uses its own, larger,
 *  independently-tunable SUBMIT_VERIFY_QUIET_MS for that check. */
const SUBMIT_VERIFY_POLL_MS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS) || 5_000;
const SUBMIT_VERIFY_POLLS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS) || 6;
const SUBMIT_VERIFY_MAX_RESUBMITS = Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR) || 3;
/** WI-2975: the verifier's OWN "is a turn genuinely running" quiet threshold —
 *  deliberately DECOUPLED from OUTPUT_QUIET_MS. OUTPUT_QUIET_MS is tuned SHORT
 *  (1500ms) for a different question — "has the agent gone back to an idle
 *  prompt?" — where reacting fast matters. Reusing that same short threshold
 *  here was the bug: a genuinely-submitted turn commonly goes silent for
 *  several seconds (network latency / silent "thinking" before the first
 *  repaint, especially right after a large-transcript /compact), which is
 *  completely normal — but at 1500ms almost ANY such gap landing on a 5s poll
 *  boundary read as "nothing happened" and fired a resubmit CR. Live evidence
 *  (WI-2975): a fully successful /compact + carry-note + COMPACTED-RESUMED
 *  STILL printed three "submit not confirmed" resubmit lines — pure noise,
 *  every single compaction, on every backend (not only omp/codex). Defaulting
 *  this to a full poll interval means "quiet" requires an ENTIRE poll cycle of
 *  zero output — a much stronger "truly nothing happened" signal — while a
 *  submit that really was swallowed is still caught within the same bounded
 *  window (just one poll later). Env-tunable independently of both
 *  OUTPUT_QUIET_MS and SUBMIT_VERIFY_POLL_MS. */
const SUBMIT_VERIFY_QUIET_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS) || 6_000;

/** Mid-turn inject safety (coord-wake-mid-turn-2026-06-30). A wake `turn` (text +
 *  CR) written into a TUI that is MID-TURN — the agent is generating / mid
 *  tool-call — wedges the turn: the line lands as queued/garbled input and the
 *  session needs a manual ESC to recover. THIS was the multi-recipient
 *  `coord:send {wake:'required'}` broadcast hang — a broadcast wakes/keeps-busy
 *  many sessions at once, so a wake is far more likely to land on a mid-turn
 *  recipient (and the always-armed inbox-wake await is re-armed on every tool
 *  call, so a working agent is still wakeable). The host's existing idle gate only
 *  defers on the HUMAN's keystrokes (makeIdleGate) — it never sees the agent's
 *  turn state. The pty OUTPUT stream IS that state: a generating agent repaints
 *  its TUI constantly (spinner / elapsed-time counter), an idle-at-prompt agent is
 *  silent (agent-liveness-heartbeat-hardening P-006). So the host ALSO defers a
 *  `turn` inject until the agent's output has been quiet this long — i.e. it is
 *  back at its prompt. Must exceed the agent's busy repaint cadence (Claude Code's
 *  elapsed counter repaints ~1/s) so a working agent never reads as idle. */
const OUTPUT_QUIET_MS = Number(process.env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS) || 1500;
/** Cap on how long a `turn` inject waits for the agent to return to its prompt.
 *  On cap we DO NOT write into the still-busy turn (that is the wedge) — we DROP
 *  the live inject: the wake message is already durably in the recipient's inbox
 *  and is seen on its next natural turn ("queue to next-turn", the sanctioned safe
 *  default). Generous by default so a normal multi-minute turn still gets a clean
 *  live re-invoke the moment it ends; only a pathologically long turn drops. */
const TURN_INJECT_BUSY_CAP_MS = Number(process.env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS) || 180_000;

/** RESET-CONTEXT settle (su-cold-auto-mode P-004a). After the host submits the
 *  context-clear command (`/clear`) it waits this long before typing the
 *  carry-note turn, so the TUI has processed the clear and repainted a fresh
 *  prompt. Too short and the carry text lands in the clearing/animating TUI;
 *  the clear itself is fast, so this is a repaint budget, not a compute one. */
const CLEAR_SETTLE_MS = Number(process.env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS) || 1_500;
/** How long a RECYCLE waits for the killed child to actually exit before it
 *  spawns the fresh one, so we never double-spawn into a still-dying pty
 *  (su-cold-auto-mode P-004b). Fail-safe: on cap we spawn anyway (the old pid is
 *  being torn down regardless). */
const RECYCLE_KILL_TIMEOUT_MS = Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS) || 5_000;
/** After the graceful recycle signal's cap, give the forced process-tree kill a
 * short bounded hand-off window to report the pty child exit before spawning its
 * successor. SIGKILL itself is the lifetime fence; this wait only lets node-pty
 * reap the leader cleanly when it can. */
const RECYCLE_FORCE_KILL_WAIT_MS = Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS) || 1_000;

/** WI-1941: total wall-clock budget the recycle carry-note inject retries across
 *  before it is dropped LOUDLY. A fresh COLD child can stay busy past one
 *  agent-busy cap (large compacted-context replay, MCP load, an auto-continued
 *  boot turn) and THEN settle — the old single-shot waitAtPrompt() dropped the
 *  iteration SILENTLY the instant it first deferred ('the wc8 recycle left no
 *  trace'). Generous, but kept < the loop interval so a retry can't outrun the
 *  next scheduled wake. Env-overridable like the sibling timings. */
const RECYCLE_CARRY_INJECT_BUDGET_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS) || 600_000;
/** Backoff between deferred carry-inject attempts (WI-1941). Each attempt's
 *  agent-busy cap already paces the bulk of the wait; this just avoids a tight
 *  requeue when an attempt defers fast. */
const RECYCLE_CARRY_RETRY_BACKOFF_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS) || 3_000;
/** A backend readiness marker is the strongest proof that its composer exists,
 * but it is not a permanent liveness dependency. UI chrome changes across CLI
 * releases, so a healthy successor can emit output forever without matching
 * the marker. After this much time from the successor's FIRST output, fall back
 * to the ordinary output-quiescence proof. The delay remains longer than the
 * observed Codex onboarding/typewriter animation; the quiet gate still has to
 * pass before any carry text is written. */
const STARTUP_MARKER_FALLBACK_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS) || 15_000;

/** EI-22123519641932348: bounded watchdog on the inject-mutex hold itself
 *  (makeInjectMutex — EI-8822). Every individual gate/verify step downstream
 *  of acquire() (idle/composer/busy gates, submit verifier, recycleChild's
 *  kill+respawn+carry sequence) is independently bounded — confirmed by
 *  reading each one — but `acquire()`'s own `await prev` has NO bound: if any
 *  holder's critical section fails to reach its `finally` release for a
 *  reason none of those bounds cover, every later gated inject (a wake
 *  `turn`, a recycle, a session:request-compaction carry-respawn) queues
 *  BEHIND it silently and forever — observed live as a ~6h TOTAL SILENCE in
 *  one host's event log (zero rows of any kind, vs a ~3.5/hr baseline),
 *  spanning 4 stacked wake fires that all reported `delivered` yet started no
 *  turn. WARN_MS must clear the legitimate worst case with real margin: the
 *  slowest single hold is a `carry-respawn` recycle — kill (RECYCLE_KILL_
 *  TIMEOUT_MS) + force-kill wait (RECYCLE_FORCE_KILL_WAIT_MS) + the carry
 *  inject's own budget (RECYCLE_CARRY_INJECT_BUDGET_MS, 10min by design) +
 *  submit verification (~SUBMIT_VERIFY_POLLS × SUBMIT_VERIFY_POLL_MS) ≈ ~11min
 *  — so WARN_MS sits well above that (loud, cheap, no side effect beyond a
 *  host-event + stderr line) and FORCE_RELEASE_MS sits far above WARN_MS (a
 *  force-release lets the NEXT waiter's acquire() proceed as though the
 *  wedged holder had released; the wedged holder's own eventual/never release
 *  call becomes a harmless no-op on an already-superseded tail promise — see
 *  makeInjectMutex's doc comment). Any real force-release is still a rare,
 *  loud, diagnosable event — a session dark for tens of minutes instead of
 *  hours (or forever) is the trade this makes. */
const INJECT_MUTEX_WARN_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_WARN_MS) || 900_000; // 15min
const INJECT_MUTEX_FORCE_RELEASE_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_FORCE_RELEASE_MS) || 2_700_000; // 45min

/** EI-18109211232286833: max age a `carry-respawn` control message may reach
 *  before delivery, measured from the moment this host first received it
 *  (`msg.receivedAtMs`, stamped in `conn.on('end')`) to the instant it is
 *  ABOUT to be delivered (immediately before `recycleChild`, in both the
 *  first attempt and its one `makeCarryRearmController` retry — both legs
 *  reuse the same `msg` object, so this measures TOTAL elapsed wait, not
 *  per-attempt). A `session:request-compaction` carry-respawn never carries
 *  `routineId`/`fireNumber` (WI-5510's stale-fire guard is a structural no-op
 *  for it — loop-fire wakes are the only sender that stamps those fields), so
 *  a single message held stale-long by the busy-gate re-arm previously delivered
 *  an outdated carry document with no staleness check at all — the live instance
 *  of the EI-15777 wake-churn family this guards against (see isCarryRespawnStale).
 *  WI-5623: a PRODUCTION carry-respawn now RE-POLLS across successive busy-gate
 *  windows (makeCarryRearmController) instead of dropping after one retry — an
 *  autonomous/headless session is near-continuously busy and rarely presents the
 *  1.5s idle window inside a single window, so a pending respawn must SURVIVE long
 *  enough to catch the session's next idle/recycle boundary (fleet bug-drain
 *  members recycle their window ~every 22-33min). The old 10-min cap dropped every
 *  such respawn just before that boundary (0/22 delivered), so the default is now
 *  30 minutes — past the fleet recycle cadence, still bounding a genuinely stale
 *  carry (the successor re-orients via coord:orient { afterCompaction }, so a
 *  modestly-old carry is fine; a >30-min-busy session is pathological and
 *  stale-drops to the hard-wall watchdog). Env-overridable. */
const CARRY_RESPAWN_MAX_AGE_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS) || 1_800_000;

/** Orphan watchdog poll (WI-3141). A bridged interactive host exists ONLY to
 *  bridge the user's terminal to the agent under psu's own pty; once its
 *  launching shell dies it has no human to serve and MUST tear down — else it
 *  lingers as an orphan forwarding its live child's output to a /dev/pts fd the
 *  OS has recycled to the owner's NEXT terminal (the 2026-07-05 "random
 *  characters appear without typing" report). SIGHUP is the nominal signal but
 *  is NOT reliably delivered on a WSL/console-session teardown (the orphan was
 *  reparented to init with no SIGHUP), so this cheap unref'd poll is the
 *  belt-and-suspenders: only a TRANSITION to init (ppid 1) triggers teardown, so
 *  a host deliberately launched under init is left alone. Env-tunable. */
const ORPHAN_POLL_MS = Number(process.env.PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS) || 2_000;

/** Filename-safe key for an ownerId (SIDs are already `[a-z0-9-]`-ish, but a
 *  defensive sanitize keeps a stray char from escaping the dir). Pure. */
export function sanitizeKey(ownerId) {
  return String(ownerId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** EI-10412: per-owner durable host-event log. The host's stderr is the owner's
 *  terminal (/dev/pts/N) — every lifecycle diagnostic written there is LOST the
 *  moment the screen repaints, which is why the 2026-07-12 carry-note-drop
 *  epidemic (10 lost auto-continuations across 7 agents in one day) had to be
 *  reconstructed from transcript archaeology. Lifecycle verbs (compact/reset/
 *  recycle) now ALSO append one JSONL row per outcome here, so "did the carry
 *  ever get typed, and if not why" is a one-file read. */
export function eventLogPathForOwner(ownerId, dir = PSU_PTY_DIR) {
  return join(dir, `${sanitizeKey(ownerId)}.events.jsonl`);
}

/** Size cap for the per-owner event log — front-truncated (oldest rows dropped)
 *  on breach, same spirit as the turn-provenance ledger compaction. */
const EVENT_LOG_MAX_BYTES = 256 * 1024;

/** Append one durable host-event row ({ ts, kind, ...extra }) for `ownerId`.
 *  FAIL-SOFT by contract: an event-log write must never break the session —
 *  any fs error is swallowed (the stderr diagnostic still fires next to it). */
export function appendHostEvent(ownerId, kind, extra = {}, dir = PSU_PTY_DIR) {
  try {
    const p = eventLogPathForOwner(ownerId, dir);
    const row = JSON.stringify({ ts: new Date().toISOString(), kind, ...extra });
    try {
      if (statSync(p).size > EVENT_LOG_MAX_BYTES) {
        const tail = readFileSync(p, 'utf8');
        writeFileSync(p, tail.slice(Math.floor(tail.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      /* no log yet — the append below creates it */
    }
    appendFileSync(p, row + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Shared drill-lifecycle roll-up file — the SAME carry-drills.events.jsonl the
 *  tool side (cold-boot-drill-live.ts) writes requested/queued rows into. */
const DRILL_LEDGER_MAX_BYTES = 1024 * 1024;
export function sharedDrillLedgerPath(dir = PSU_PTY_DIR) {
  return join(dir, 'carry-drills.events.jsonl');
}

/** EI-12655 (fix b): mirror a carry-drill lifecycle event into the SHARED drill
 *  ledger. The tool side records only requested/queued there; every HOST-side
 *  outcome (respawned / respawn-failed / carry-delivered / carry-dropped)
 *  previously lived ONLY in the per-owner event log — so
 *  `session:carry-drill { op:'report' }` (which reads the shared ledger) saw
 *  perClass:[] even after real drills, and a vanished host left NO terminal row
 *  anywhere. Call this NEXT TO every carry-drill-* appendHostEvent. Row shape
 *  matches ColdBootDrillLedgerEvent ({ ts, kind, ownerId, drillId,
 *  sessionClass, reason?, nativeId?, ... }). FAIL-SOFT like appendHostEvent —
 *  a ledger write must never break the session. */
export function appendSharedDrillLedgerEvent(ownerId, kind, extra = {}, dir = PSU_PTY_DIR) {
  try {
    const p = sharedDrillLedgerPath(dir);
    const row = JSON.stringify({ ts: new Date().toISOString(), kind, ownerId, ...extra });
    try {
      if (statSync(p).size > DRILL_LEDGER_MAX_BYTES) {
        const tail = readFileSync(p, 'utf8');
        writeFileSync(p, tail.slice(Math.floor(tail.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      /* no ledger yet — the append below creates it */
    }
    appendFileSync(p, row + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Control-socket path for an ownerId. Pure. */
export function socketPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.sock`);
}

/** Discovery-metadata path for an ownerId. Pure. */
export function metaPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.json`);
}

/** WI-38292: where a host about to re-exec leaves the successor's marching
 *  orders. A FILE, not an env var: the successor is spawned by the shim's bash
 *  loop, not by us, so we cannot put anything in its environment. Pure. */
export function handoffPathFor(ownerId) {
  return join(PSU_PTY_DIR, `${sanitizeKey(ownerId)}.handoff.json`);
}

/**
 * WI-38292: persist the successor's marching orders — the child argv this host
 * had already minted (rotated native session id + the carry's
 * --append-system-prompt-file), so the carry survives the process swap without
 * riding memory. Returns the path, or null when it could not be written (the
 * caller must then NOT exit: a successor with no orders would boot a bare
 * session and drop the carry).
 */
/** WI-38292: the child env keys a host-code handoff carries to the re-exec'd successor.
 *  The shim re-runs the launcher with its ORIGINAL environment, not the child environment
 *  assembled after bootstrap, so everything the launch tail set for the child that the
 *  successor must reproduce has to travel in the handoff. Deliberately NOT the whole child
 *  env (it carries unrelated credentials) — but every key here is a copy of a truth the
 *  launcher's fresh path owns, so it DRIFTS: the list predated the context-trimming trio
 *  (ENABLE_TOOL_SEARCH / PAPERCUSP_TOOLS / PAPERCUSP_CONTEXT_TIER) and, on the first
 *  adoption after a pty-host edit, every headless fleet member re-booted with the whole
 *  ~581-tool catalog inline — 756k tokens on turn 1, respawned every ~10 min (WI-2140943
 *  lane 2, 2026-09-02). Two rails keep it honest now: the launcher's handoff successor
 *  re-derives that trio when absent (healContextTrimmingEnv), and
 *  psu-host-handoff-env.test.ts pins this list ⊇ contextTrimmingEnv's keys. */
export const HOST_HANDOFF_ENV_KEYS = Object.freeze([
  'PAPERCUSP_SID',
  'PAPERCUSP_AGENT',
  'PAPERCUSP_ADV_SESSION_ID',
  HEADLESS_NORMALIZED_LOG_ENV,
  'PAPERCUSP_WORKSPACE',
  'PAPERCUSP_HARNESS_SLUG',
  'PAPERCUSP_PROFILE',
  'PAPERCUSP_FLEET_SLUG',
  'PAPERCUSP_FLEET_ROLE',
  'PAPERCUSP_ACCOUNT_ID',
  'PAPERCUSP_ACCOUNT_ROUTING_MODE',
  'PAPERCUSP_OPERATOR_URL',
  'PAPERCUSP_AGENT_SESSION',
  'PAPERCUSP_AUTO_MODE',
  'PAPERCUSP_DRAIN_MODE',
  'PAPERCUSP_MODEL',
  // context-trimming trio (WI-2140943 lane 2) — see contextTrimmingEnv in psu-launcher.mjs.
  'ENABLE_TOOL_SEARCH',
  'PAPERCUSP_TOOLS',
  'PAPERCUSP_CONTEXT_TIER',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'DISABLE_AUTO_COMPACT',
  'DISABLE_COMPACT',
  // Console-history preservation (launcher terminalRenderEnv, owner terminal
  // 2026-09-06): a successor that boots into Claude Code's fullscreen TUI paints on
  // the alternate screen and its whole epoch vanishes from the console at the next
  // cut. Pinned ⊇ terminalRenderEnv's keys by psu-host-handoff-env.test.ts.
  'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
]);

export function writeHostHandoff(ownerId, record) {
  try {
    ensureDir();
    const p = handoffPathFor(ownerId);
    writeFileSync(
      p,
      JSON.stringify({
        ownerId,
        fromPid: process.pid,
        createdAt: new Date().toISOString(),
        ...record,
        // The successor is launched by the shim, not by this process. Its
        // parent pid is therefore the one stable rendezvous key available to
        // the next launcher before it has reconstructed PAPERCUSP_SID. Keep
        // this server-derived value authoritative even if a caller supplies a
        // similarly named field in its opaque record.
        parentPid: process.ppid,
      }),
      { mode: 0o600 },
    );
    return p;
  } catch {
    return null;
  }
}

function readHostHandoffFile(
  p,
  expectedOwnerId,
  { maxAgeMs = 120_000, now = Date.now, isAlive = pidAlive } = {},
) {
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    unlinkSync(p);
  } catch {
    /* consumed either way — a re-readable handoff is worse than a lost one */
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;
  if (expectedOwnerId && rec.ownerId && rec.ownerId !== expectedOwnerId) return null;
  // A LIVE writer means we are not its successor — that host is running and owns
  // the session, and acting on its argv would put a second child behind a live
  // discovery key. No self-exemption: a process is never its own successor, so
  // `fromPid === process.pid` is refused by the same rule rather than waved past
  // it (the exemption also made this guard untestable, which is how it was found).
  if (rec.fromPid && isAlive(rec.fromPid)) return null;
  const age = now() - Date.parse(rec.createdAt ?? '');
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  if (!Array.isArray(rec.args) || rec.args.length === 0) return null;
  return rec;
}

/**
 * WI-38292: read AND consume (unlink) this owner's handoff. Single-shot by
 * construction — the file is removed before its contents are returned, so a
 * successor that crashes mid-boot cannot have the same carry replayed into it on
 * every subsequent launch.
 *
 * Rejects a record that is not ours to act on: a different ownerId (a copied
 * file), one written by a STILL-LIVE host (we are not its successor — that host
 * is running and owns the session), or one older than `maxAgeMs` (a re-exec that
 * never completed, whose argv now names a rotated session id nothing will
 * accept). A rejected record is still consumed: leaving it behind means the next
 * launch re-litigates the same stale orders.
 * @param {string} ownerId
 * @param {{maxAgeMs?: number, now?: () => number, isAlive?: (pid: number) => boolean}} [opts]
 */
export function readHostHandoff(ownerId, opts = {}) {
  return readHostHandoffFile(handoffPathFor(ownerId), ownerId, opts);
}

/**
 * Read the single handoff written by this launcher's parent shim. A host
 * re-exec starts the launcher with the shim's original argv and environment,
 * so the numeric adv id/CODEX_HOME that were resolved after bootstrap are not
 * otherwise available yet. The handoff records the shim pid as a rendezvous
 * key, allowing the launcher to consume its own orders before running a fresh
 * bootstrap and accidentally minting a sibling adv row.
 *
 * Refuse an ambiguous parent match: selecting the newest file would recreate
 * the same cross-session identity split this handoff path is meant to prevent.
 * @param {number} parentPid
 * @param {{maxAgeMs?: number, now?: () => number, isAlive?: (pid: number) => boolean}} [opts]
 */
export function readHostHandoffForParentPid(parentPid, opts = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  let names;
  try {
    names = readdirSync(PSU_PTY_DIR);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.handoff.json')) continue;
    const p = join(PSU_PTY_DIR, name);
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed?.parentPid === parentPid) {
        candidates.push({
          path: p,
          ownerId: typeof parsed.ownerId === 'string' ? parsed.ownerId : null,
        });
      }
    } catch {
      /* a malformed file is not evidence for this parent */
    }
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return readHostHandoffFile(candidate.path, candidate.ownerId, opts);
}

/** Is a pid alive? (signal 0 probe.) */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours (shouldn't happen same-UID); treat as alive.
    return e && e.code === 'EPERM';
  }
}

/** Read a pid's /proc cmdline (NULs → spaces); null when unreadable. Injectable
 *  for tests. Mirrors operator-core psu-pty-discovery's defaultReadCmdline. */
const readPidCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
};

/**
 * Process-IDENTITY check (WI-3455; mirrors operator-core psu-pty-discovery's
 * pidIsPsuHost — keep the two in lockstep): is `pid` actually a psu session
 * host, or an unrelated process that inherited a recycled pid? FAIL-OPEN where
 * identity cannot be read (no /proc ⇒ non-Linux dev: trust pid-alive as
 * before); on Linux an unreadable cmdline means the pid vanished / is a zombie
 * ⇒ not a verifiable live host ⇒ reject.
 */
export function pidLooksLikePsuHost(pid, readCmdline = readPidCmdline) {
  if (!pid) return false;
  const cmdline = readCmdline(pid);
  if (cmdline == null) return !existsSync('/proc');
  return /psu-(launcher|pty-host)/.test(cmdline);
}

/** Parse an ownerId's discovery file, or null (missing / partial / corrupt). */
export function readDiscoveryMeta(ownerId) {
  try {
    return JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The LIVE psu host currently registered for `ownerId`, or null (WI-3455).
 * Self-validating like operator-core's findLiveHost: recorded ownerId must
 * match, the pid must be alive AND actually be a psu host, and the socket must
 * still exist on disk. Used by the launcher's resume-of-live guard — a non-fork
 * resume of a session that is STILL RUNNING in another window would boot a
 * second host on the same discovery key and strand the live one.
 */
export function findLiveHostFor(ownerId, { verifyIdentity = pidLooksLikePsuHost } = {}) {
  const m = readDiscoveryMeta(ownerId);
  if (!m || (m.ownerId && m.ownerId !== ownerId)) return null;
  if (m.sock && existsSync(m.sock) && m.pid && pidAlive(m.pid) && verifyIdentity(m.pid)) return m;
  return null;
}

/**
 * How long a live host has been INERT, from the activity stamps its own
 * discovery record already carries (EI-20289007209260909).
 *
 * `findLiveHostFor` answers "does a process exist?", which is the wrong
 * question to hand a human on its own. Measured 2026-08-12: a headless session
 * whose kickoff said "acknowledge and stop" did exactly that, then sat in the
 * launcher's process tree for 4h15m holding its socket and identity while the
 * CLI waited on a stdin nobody would ever write to. The resume guard read
 * pid-alive, said "STILL LIVE in another window", and told the owner to go use
 * a window where nothing was happening — while `coord:presence` called the same
 * session `ended`. Both surfaces were locally correct and the owner still could
 * not tell what was true, because neither reported the deciding fact: 178
 * minutes with no output.
 *
 * Returns null when NO stamp is readable. That case must not be reported as
 * idle: the guard's dangerous error is the opposite of the composer breaker's
 * — there, absent evidence means break the line; here, absent evidence means
 * keep refusing, because wrongly waving a resume past a genuinely live host
 * boots a second one onto its discovery key and strands it (WI-3455). Same
 * "missing measurement" shape, opposite safe direction, and the direction is a
 * property of what the failure costs, not of the code.
 *
 * Pure (injectable clock, no I/O); exported for tests.
 *
 * @param {{ lastActivityAt?: number, lastOutputAt?: number, lastInputAt?: number, startedAt?: number }} meta
 * @param {number} [now]
 */
export function hostIdleMs(meta, now = Date.now()) {
  const stamps = [meta?.lastActivityAt, meta?.lastOutputAt, meta?.lastInputAt, meta?.startedAt].filter(
    (t) => typeof t === 'number' && Number.isFinite(t) && t > 0,
  );
  if (!stamps.length) return null;
  return Math.max(0, now - Math.max(...stamps));
}

function ensureDir() {
  mkdirSync(PSU_PTY_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(PSU_PTY_DIR, 0o700);
  } catch {
    /* best-effort on a pre-existing dir */
  }
}

/** Read every discovery file; annotate each with `alive`. Skips unreadable. */
export function listHosts() {
  const out = [];
  let names;
  try {
    names = readdirSync(PSU_PTY_DIR);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(PSU_PTY_DIR, f), 'utf8'));
      meta.alive = pidAlive(meta.pid) && !!meta.sock && existsSync(meta.sock);
      meta.metaPath = join(PSU_PTY_DIR, f);
      out.push(meta);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Remove discovery files + sockets whose host process is gone. */
export function pruneDead() {
  for (const m of listHosts()) {
    if (pidAlive(m.pid)) continue;
    for (const p of [m.sock, m.metaPath]) {
      try {
        if (p && existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * owner-presence-human-turn-signal-2026-07-11 P-003: report a human-turn presence
 * signal, throttled to ≤1/60s per host process, when a human types into an agent's
 * terminal. This is the backend-agnostic owner-present signal (claude/codex/omp all
 * route through this pty bridge): stdin bytes here are REAL keystrokes — socket-
 * injected agent wakes take the control-socket path (conn.on('data') → child.write),
 * never stdin — so no human-vs-agent disambiguation is needed. Fire-and-forget: never
 * awaited, never throws into the keystroke path; a wedged operator can't stall typing.
 * The caller additionally gates this on `bridgeTty` (a real terminal), so a headless
 * background session with a piped stdin never reports presence.
 */
const OWNER_PRESENCE_REPORT_THROTTLE_MS =
  Number(process.env.PAPERCUSP_PSU_PTY_OWNER_PRESENCE_THROTTLE_MS) || 60_000;
let lastOwnerPresenceReportAt = 0;
export function reportOwnerHumanTurn(now = Date.now()) {
  if (now - lastOwnerPresenceReportAt < OWNER_PRESENCE_REPORT_THROTTLE_MS) return;
  lastOwnerPresenceReportAt = now;
  try {
    const base = process.env.PAPERCUSP_OPERATOR_URL || 'http://127.0.0.1:3270';
    const ws = process.env.PAPERCUSP_WORKSPACE || 'default';
    const url = `${base}/api/admin/owner-presence/touch?workspace=${encodeURIComponent(ws)}`;
    // 1.5s timeout so a hung operator releases the socket rather than leaking it.
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    if (typeof t.unref === 'function') t.unref();
    fetch(url, { method: 'POST', signal: ac.signal })
      .catch(() => {})
      .finally(() => clearTimeout(t));
  } catch {
    /* presence reporting must never disturb the terminal */
  }
}

/**
 * The mid-keystroke idle gate (P-013). `touch()` on every stdin byte records
 * activity; `waitIdle()` resolves once `idleMs` of quiet has elapsed (or the cap
 * is hit). Pure-ish (uses timers + an injectable clock for tests).
 */
export function makeIdleGate({ idleMs = DEFAULT_IDLE_MS, capMs = DEFAULT_IDLE_WAIT_CAP_MS, now = Date.now } = {}) {
  let lastActivity = 0; // never-typed => immediately idle
  return {
    touch() {
      lastActivity = now();
    },
    /** ms until idle from `t` (0 = idle now). Pure helper, exported for tests. */
    remainingIdleMs(t = now()) {
      const since = t - lastActivity;
      return since >= idleMs ? 0 : idleMs - since;
    },
    /** Resolve once the input line has been idle for idleMs (bounded by capMs). */
    async waitIdle() {
      const deadline = now() + capMs;
      // Re-check in case typing continues during a wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rem = this.remainingIdleMs();
        if (rem <= 0) return { deferred: false };
        if (now() >= deadline) return { deferred: true, reason: 'idle-cap' };
        const wait = Math.min(rem, Math.max(0, deadline - now()));
        await new Promise((r) => setTimeout(r, Math.max(10, wait)));
      }
    },
  };
}

/**
 * ECMA-48 "string" control sequences: an introducer, an arbitrary payload, and
 * a String Terminator (ST = ESC \, or BEL for OSC). Their payloads are TERMINAL
 * DATA — a reply the emulator wrote in answer to a query the TUI made — and are
 * NEVER owner-authored text.
 *
 * This is deliberately the CLOSED ECMA-48 set rather than the families we have
 * been bitten by. Enumerating observed families is what caused this bug to
 * recur: the CSI/OSC/SS3 handling below was added for Codex's cursor-report
 * replies (EI-20199370837439455), which left DCS unhandled — so when the TUI
 * asked gnome-terminal for its version (XTVERSION, `CSI > 0 q`) and VTE replied
 * `ESC P > | VTE(7600) ESC \`, the parser fell through to "ordinary two-byte
 * ESC sequence" and counted `>|VTE(7600)` as ELEVEN characters of owner text.
 * Nothing clears a staged line except CR/LF/Ctrl-C/Ctrl-U, so every bridged
 * host wedged permanently and deferred every wake with `owner-input-cap`
 * (WI-38156: 532 deferrals in 9h; one session sat dead for 2h).
 */
const STRING_SEQUENCE_INTRODUCERS = new Set([
  0x50, // ESC P — DCS (XTVERSION, DA3 and DECRQSS replies)
  0x58, // ESC X — SOS
  0x5d, // ESC ] — OSC (window title, color queries)
  0x5e, // ESC ^ — PM
  0x5f, // ESC _ — APC (kitty graphics)
]);

/**
 * Split a terminal byte stream into ZONES so that "is this byte owner-authored
 * text?" is answered in exactly one place. Stateful across chunks: a reply can
 * be split over two reads, and a stateless classifier would mis-read the tail
 * of a sequence as owner text — the same failure one level up.
 *
 * Each byte is reported as one of:
 *   'text'   — outside any escape sequence (owner keystrokes live here)
 *   'esc'    — a bare ESC whose family is not yet known (the next byte decides)
 *   'csi'    — inside ESC [ … ; also produced by arrow/function keys, so this
 *              zone is AMBIGUOUS: a human pressing Left and a terminal
 *              answering a cursor query are indistinguishable here.
 *   'ss3'    — inside ESC O …; ambiguous for the same reason (keypad keys).
 *   'string' — inside a string sequence; UNAMBIGUOUSLY terminal-authored.
 *
 * Pure (no I/O); exported for tests.
 */
export function makeAnsiZoneScanner() {
  let escapeMode = null;
  return {
    /** Feed a chunk; `onByte(code, zone)` is called once per byte, in order. */
    scan(data, onByte) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (escapeMode === 'esc') {
          if (code === 0x5b) escapeMode = 'csi'; // ESC [
          else if (code === 0x4f) escapeMode = 'ss3'; // ESC O
          else if (STRING_SEQUENCE_INTRODUCERS.has(code)) escapeMode = 'string';
          else escapeMode = null; // ordinary two-byte ESC sequence
          onByte(code, escapeMode === 'string' ? 'string' : escapeMode || 'csi');
          continue;
        }
        if (escapeMode === 'csi') {
          // ECMA-48 CSI: parameter/intermediate bytes, then one final byte.
          if (code >= 0x40 && code <= 0x7e) escapeMode = null;
          onByte(code, 'csi');
          continue;
        }
        if (escapeMode === 'ss3') {
          // SS3 is ESC O plus one final key byte.
          escapeMode = null;
          onByte(code, 'ss3');
          continue;
        }
        if (escapeMode === 'string') {
          if (code === 0x07) escapeMode = null; // BEL terminator (OSC)
          else if (code === 0x1b) escapeMode = 'string-esc';
          onByte(code, 'string');
          continue;
        }
        if (escapeMode === 'string-esc') {
          // The other terminator is ST (ESC \). A non-ST byte keeps the string
          // open; it is still terminal data, never owner-authored text.
          escapeMode = code === 0x5c ? null : 'string';
          onByte(code, 'string');
          continue;
        }
        if (code === 0x1b) {
          escapeMode = 'esc';
          // The family is not known until the NEXT byte, so this one is its own
          // zone. Attributing it to a family here is what made a DCS reply read
          // as owner input: its leading ESC was counted before `P` disclosed
          // that everything following was terminal data.
          onByte(code, 'esc');
          continue;
        }
        onByte(code, 'text');
      }
    },
    /** Drop any half-parsed sequence (used when the composer is force-reset). */
    reset() {
      escapeMode = null;
    },
  };
}

/**
 * Does this stdin chunk contain anything a HUMAN could have produced?
 *
 * Used to keep terminal replies out of the owner-presence signals. It is
 * deliberately conservative: only the unambiguous 'string' zone is treated as
 * definitely-not-human, so arrow keys, function keys and keypad input (CSI/SS3)
 * still count as owner activity exactly as they did before. The one behaviour
 * given up is a LONE Escape keypress followed by nothing else, ever — its
 * family never resolves, and paying that to stop every terminal reply forging
 * owner presence is the right trade.
 *
 * Stateful across chunks — construct one per stdin stream.
 */
export function makeOwnerInputDetector() {
  const scanner = makeAnsiZoneScanner();
  return {
    /** true when the chunk could be owner-authored; false = pure terminal reply. */
    sawOwnerInput(data) {
      let human = false;
      scanner.scan(data, (_code, zone) => {
        if (zone !== 'string' && zone !== 'esc') human = true;
      });
      return human;
    },
  };
}

/**
 * Detect a composer that is no longer tracking a real person (WI-38156).
 *
 * The parser fix above removes the KNOWN phantom source; this exists for the
 * next unknown one. The original incident was silent for hours — 532 deferrals
 * across 9h, one session dead for 2h — because each individual defer is
 * perfectly legitimate ("the owner is mid-line, don't corrupt their input"),
 * and nothing ever asked the follow-up question: has that same untouched line
 * been blocking wakes all morning?
 *
 * The signature that separates a phantom from a person: the staged length
 * never changes AND no owner-authored byte has arrived for a long time. A real
 * person who walked away mid-line trips this too — which is CORRECT. The agent
 * is equally stuck either way, and somebody should be told.
 *
 * Pure (no clock, no I/O — the caller supplies the measurements); exported for
 * tests.
 */
export function makeComposerWedgeDetector({ minDefers = 3, minQuietMs = 5 * 60_000 } = {}) {
  let consecutive = 0;
  let lastLength = -1;
  let reported = false;
  return {
    /**
     * Record one deferral. Returns a report payload the first time a wedge is
     * suspected for a given staged line, otherwise null (so a wedged host logs
     * once per episode instead of once per wake).
     *
     * The param is typed explicitly rather than left to inference: a
     * destructured field with NO default (`pendingLength`) is dropped from the
     * inferred object type entirely, so the generated .d.mts declared a shape
     * without it and every caller that passed it became a type error — while
     * vitest stayed green, because it never typechecks.
     *
     * @param {{ pendingLength: number, ownerQuietMs?: number, pendingAgeMs?: number }} sample
     */
    note(sample) {
      const { pendingLength, ownerQuietMs = Infinity, pendingAgeMs = 0 } = sample ?? {};
      if (pendingLength !== lastLength) {
        // The line moved, so somebody is editing it. Start the count over.
        lastLength = pendingLength;
        consecutive = 1;
        reported = false;
        return null;
      }
      consecutive += 1;
      if (reported || consecutive < minDefers || ownerQuietMs < minQuietMs) return null;
      reported = true;
      return {
        pendingLength,
        consecutiveDefers: consecutive,
        pendingAgeMs,
        ownerQuietMs: ownerQuietMs === Infinity ? null : ownerQuietMs,
        // The single most diagnostic fact, and the one that took a live pty
        // capture to establish the first time: no owner byte was EVER seen.
        ownerBytesEverSeen: ownerQuietMs !== Infinity,
      };
    },
    /**
     * How many consecutive wakes have been deferred against the CURRENT staged
     * length. Exposed because `note()` deliberately reports once per episode —
     * after the first report it returns null forever, so the count it is still
     * maintaining becomes invisible to the caller at exactly the point the
     * episode gets bad. The breaker needs the running value, not the one-shot
     * report: this is the only wedge signal that requires no clock at all, and
     * therefore the only one that survives a host whose measurements are absent.
     */
    consecutiveDefers() {
      return consecutive;
    },
  };
}

/**
 * Decide whether a staged composer line has stopped tracking a person and may
 * be CLEARED so wakes can flow again (WI-38257).
 *
 * makeComposerWedgeDetector above answers "should somebody be TOLD?". This
 * answers "may the host ACT?", and they are deliberately separate questions
 * because the detector's entire remedy is a stderr line reading "press Ctrl-U
 * here to clear it" — which asks the very human whose absence IS the failure. A
 * detector whose only actuator is an absent human is not a recovery path.
 *
 * Measured on the 2026-08-12 incident: a 53-char line sat staged while every
 * wake deferred with `owner-input-cap` for 112s+, the agent took no turn at all,
 * and the episode ended only because the owner typed. The detector never even
 * fired — `owner-composer-wedge-suspected` count was 0 in that ledger, because
 * its default quiet window is 5 min, longer than the strand a human was willing
 * to sit through. A threshold above human patience reports nothing, ever.
 *
 * The predicate is deliberately NOT "no owner byte was ever seen". That reading
 * is the tempting one and it is WRONG: the incident recorded ownerQuietMs=102321
 * — finite, so owner-classified bytes HAD arrived — and a never-saw-a-byte guard
 * would have sat out the very event it was written for. What actually separates
 * a wedge from a person is the pair below: a line whose length has not moved AND
 * which has received no owner byte for the whole window. A person who walked
 * away mid-line trips it too, and that is the correct trade — they lose a line
 * they had already abandoned, where the alternative is an agent dead until
 * somebody notices. ownerQuietMs is Infinity when no owner byte was ever seen,
 * which satisfies any threshold, so a pure phantom clears as soon as it is old
 * enough.
 *
 * Pure (the caller supplies the measurements); exported for tests.
 *
 * The param is typed EXPLICITLY, for the reason its sibling above records: a
 * destructured field with no default (`pending`) is dropped from the inferred
 * object type entirely, so the generated .d.mts would declare a shape without
 * it and every caller passing it becomes a type error — while vitest stays
 * green, because it never typechecks. Same trap, one function down.
 *
 * ## The wake-loss fallback (EI-20287339148365013)
 *
 * Both measurements above are TIMING PROXIES for the harm. The harm itself is
 * "wakes are being thrown away", and `consecutiveDefers` measures that directly
 * — which matters because each proxy has a way to be silently defeated, and one
 * of them already was:
 *
 *  - MEASUREMENTS ABSENT. Measured 2026-08-12: ten hosts deferred every wake for
 *    up to 259 minutes with `pendingAgeMs`/`ownerQuietMs` missing from every
 *    event they emitted (they predated the commit that added the fields). The
 *    destructuring defaults then resolve to `pendingAgeMs = 0`, the age guard
 *    fails, and the breaker CAN NEVER FIRE. A missing measurement must not read
 *    as "nothing is wrong": for a liveness guard, absent evidence is the case
 *    that most needs breaking, not the one that most needs caution.
 *  - QUIET RESET BY A REPEATING EMITTER. `ownerQuietMs` is reset by any byte
 *    classified as text, so a terminal reply family the scanner does not yet
 *    recognise — the exact bug that staged these lines — holds the quiet window
 *    below threshold indefinitely while the line sits there. The proxy reports
 *    "a person is here" precisely when a machine is.
 *
 * The counter is only incremented against an UNCHANGED staged length (see
 * makeComposerWedgeDetector), which is what keeps it off a person: a human's
 * line moves as they type. A human whose line has not moved across N wakes has
 * walked away from it, and the doc above already settles that trade — they lose
 * a line they had abandoned, where the alternative is an agent dead until
 * somebody notices.
 *
 * @param {{ pending: boolean, pendingAgeMs?: number, ownerQuietMs?: number, consecutiveDefers?: number }} sample
 * @param {{ minAgeMs?: number, minQuietMs?: number, maxDefers?: number }} [thresholds]
 */
export function shouldBreakComposerWedge(
  sample,
  { minAgeMs = 90_000, minQuietMs = 90_000, maxDefers = 5 } = {},
) {
  const { pending, pendingAgeMs = 0, ownerQuietMs = Infinity, consecutiveDefers = 0 } = sample ?? {};
  if (!pending) return false;
  // Checked BEFORE the timing rule, and deliberately depending on neither
  // measurement: this is the path that still works on a host whose forensics
  // fields are absent, which is the population that stayed wedged for hours.
  if (consecutiveDefers >= maxDefers) return true;
  if (!(pendingAgeMs >= minAgeMs)) return false;
  return ownerQuietMs >= minQuietMs;
}

/**
 * Track a bridged owner's line-editor state separately from keystroke activity.
 * The idle gate only knows that typing stopped; it cannot tell whether the
 * owner pressed Enter. Injecting a wake into a quiet-but-unsubmitted line
 * appends the machine envelope after owner text, so provenance is then
 * misclassified as owner-typed and the TUI receives a corrupted turn.
 *
 * Escape sequences are ignored as terminal editing controls. The conservative
 * fallback is to keep a line pending until an explicit submit/cancel arrives;
 * a false defer is safe, while appending machine bytes to owner text is not.
 */
export function makeOwnerComposerGate({ capMs = DEFAULT_IDLE_WAIT_CAP_MS, now = Date.now } = {}) {
  let pending = false;
  let lineLength = 0;
  const scanner = makeAnsiZoneScanner();
  const waiters = new Set();
  // Wedge forensics (WI-38156). A staged line that never changes and receives
  // no further owner bytes is the signature of a phantom: a real person either
  // finishes the line or abandons it. Recording WHEN it was staged and when it
  // last moved is what makes "this host is stuck" falsifiable from the event
  // log instead of a 2h silent halt nobody notices.
  let pendingSinceMs = 0;
  let lastOwnerByteMs = 0;

  const setPending = (next) => {
    pending = next;
    if (!pending) {
      pendingSinceMs = 0;
      for (const resolve of waiters) resolve({ deferred: false });
      waiters.clear();
    } else if (!pendingSinceMs) {
      pendingSinceMs = now();
    }
  };

  const observe = (data) => {
    scanner.scan(data, (code, zone) => {
      // Only bytes OUTSIDE an escape sequence can be owner-typed text.
      if (zone !== 'text') return;
      lastOwnerByteMs = now();
      if (code === 0x0d || code === 0x0a || code === 0x03 || code === 0x15) {
        // Enter/newline submits; Ctrl-C and Ctrl-U cancel the current line.
        lineLength = 0;
        setPending(false);
        return;
      }
      if (code === 0x08 || code === 0x7f) {
        lineLength = Math.max(0, lineLength - 1);
        setPending(lineLength > 0);
        return;
      }
      if (code === 0x09 || code >= 0x20) {
        lineLength += 1;
        setPending(true);
      }
    });
  };

  return {
    observe,
    hasPending() {
      return pending;
    },
    pendingLength() {
      return lineLength;
    },
    /** How long the current line has been staged (0 when nothing is pending). */
    pendingAgeMs(t = now()) {
      return pendingSinceMs ? t - pendingSinceMs : 0;
    },
    /** How long since ANY owner-authored byte arrived (Infinity when never). */
    ownerQuietMs(t = now()) {
      return lastOwnerByteMs ? t - lastOwnerByteMs : Infinity;
    },
    markSubmitted() {
      lineLength = 0;
      scanner.reset();
      setPending(false);
    },
    /** Wait for an owner submit/cancel, bounded so a parked line cannot wedge a host. */
    waitClear() {
      if (!pending) return Promise.resolve({ deferred: false });
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters.delete(finish);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ deferred: true, reason: 'owner-input-cap' }), capMs);
        waiters.add(finish);
      });
    },
  };
}

/**
 * Session activity tracker (agent-liveness-heartbeat-hardening-2026-06-12
 * P-006): the OUTPUT-side sibling of makeIdleGate. The pty stream is a true
 * mid-turn signal — a generating agent repaints its TUI constantly — so
 * `lastOutputAt` distinguishes *generating* from *idle-at-prompt*, which
 * process-aliveness alone cannot. ANNOTATE-ONLY by design (plan D-002):
 * this feeds the discovery file / roster display, never the claim-release
 * rule — an attended-but-quiet session keeps its claims.
 * Pure (injectable clock); exported for tests.
 */
export function makeActivityTracker({ now = Date.now } = {}) {
  let lastInputAt = 0;
  let lastOutputAt = 0;
  return {
    touchInput() {
      lastInputAt = now();
    },
    touchOutput() {
      lastOutputAt = now();
    },
    snapshot() {
      return {
        lastInputAt: lastInputAt || null,
        lastOutputAt: lastOutputAt || null,
        lastActivityAt: Math.max(lastInputAt, lastOutputAt) || null,
      };
    },
  };
}

/**
 * How long a SHUTDOWN gives the child to exit on SIGHUP before the host escalates
 * to a whole-process-tree SIGKILL. A claude TUI flushes its transcript on SIGHUP,
 * so the pause is what makes the exit clean rather than lossy.
 */
export const SHUTDOWN_GRACE_MS = Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_GRACE_MS) || 4_000;

/**
 * How long an accepted SHUTDOWN waits before it starts killing, so the control
 * connection's ACK is written and flushed first. Without this the shutdown tears
 * down its own socket mid-ack and the requester reads a SUCCESSFUL shutdown as a
 * transport miss — the exact confusion that makes a caller retry a session that is
 * already on its way out.
 */
export const SHUTDOWN_ACK_DELAY_MS = Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_ACK_DELAY_MS) || 250;

/**
 * PURE: may this host honour a `mode:'shutdown'` request? Returns `null` to
 * proceed, or the REFUSAL REASON string (WI-6638).
 *
 * This is the ONLY thing standing between "close a finished agent's tab" and
 * "close the window the owner is typing in", so it is deliberately strict and
 * fails toward REFUSING. Both human guards are unconditional — `force` waives
 * ONLY the mid-turn check, never them:
 *
 *  1. `launchedBy` — set from `PAPERCUSP_LAUNCHED_BY`, which `injectLaunchedByArg`
 *     (agent-launch-core) stamps onto EVERY tool-driven psu launch and which an
 *     owner-typed `psu` never carries. This is a STRUCTURAL discriminator, not a
 *     heuristic. A structurally headless host bound to a named fleet is the one
 *     equivalent discriminator: it has no human TTY to own and the fleet stamp is
 *     injected by bootstrap. This covers operator-spawned headless members whose
 *     launch path predates `PAPERCUSP_LAUNCHED_BY` without weakening interactive
 *     sessions, which still fail closed when the marker is absent.
 *  2. `lastInputAt` — real stdin bytes on a bridged TTY (makeActivityTracker's
 *     touchInput; socket-injected agent wakes never reach stdin). ANY human
 *     keystroke, ever, makes this session the owner's. A headless member has no
 *     stdin bridge, so this stays 0 and never blocks it.
 *
 * Why not reuse the idle-session reaper's policy instead: measured 2026-08-03,
 * `findIdleLiveSessions()` returns 0 for this whole cohort — every psu session
 * classifies `driveMode:'responsive'` (agent-pane-kind rule 5) and is excluded by
 * the queen-fleet-authority-boundary ruling P-001/D-001 before the window guard is
 * ever consulted. A system reaper may not kill these; only the session itself may
 * exit. Nothing here loosens `terminalWindowAlive`/`cgroupWindowProtects` — this
 * path never signals a process it does not own.
 */
export function shutdownRefusalReason({
  launchedBy = '',
  headless = false,
  fleetSlug = '',
  lastInputAt = 0,
  agentQuietMs = Infinity,
  force = false,
  quietMs = OUTPUT_QUIET_MS,
} = {}) {
  const structurallyAgentOwned =
    Boolean(String(launchedBy || '').trim()) ||
    (headless === true && Boolean(String(fleetSlug || '').trim()));
  if (!structurallyAgentOwned) return 'not-agent-launched';
  if (Number(lastInputAt) > 0) return 'human-attended';
  if (!force && Number(agentQuietMs) < quietMs) return 'agent-busy';
  return null;
}

/**
 * Agent-busy (mid-turn) inject gate (coord-wake-mid-turn-2026-06-30). The
 * OUTPUT-side sibling of makeIdleGate: makeIdleGate defers a `turn` while the
 * HUMAN is mid-keystroke; THIS gate defers it while the AGENT is mid-turn. A
 * `turn` (text + CR) written into a generating TUI wedges it (needs ESC) — so we
 * hold the inject until the agent is back at its prompt, read off the pty output
 * stream (the established mid-turn signal — makeActivityTracker, P-006).
 *
 *   lastOutputAt() → ms epoch of the agent's most recent pty output (0 = none yet,
 *                    treated as "quiet"/at-prompt).
 *   waitAtPrompt() → resolves { deferred:false } once output has been quiet for
 *                    quietMs (agent at prompt → safe to inject), or
 *                    { deferred:true, reason:'agent-busy' } if the agent stays busy
 *                    past capMs (caller SKIPS the live inject; the durable inbox
 *                    message stands for the next natural turn).
 *
 * Pure (injectable clock + getter); exported for tests.
 */
export function makeAgentBusyGate({
  lastOutputAt,
  quietMs = OUTPUT_QUIET_MS,
  capMs = TURN_INJECT_BUSY_CAP_MS,
  now = Date.now,
} = {}) {
  const getLast = typeof lastOutputAt === 'function' ? lastOutputAt : () => 0;
  return {
    /** ms the agent output has been quiet (huge when never seen ⇒ at-prompt).
     *  Pure helper, exported for tests. */
    quietForMs(t = now()) {
      return t - (getLast() || 0);
    },
    /** Resolve once output has been quiet for quietMs (agent at its prompt), or
     *  defer after capMs (agent still mid-turn — drop the live inject).
     *  WI-1872 (1): `overrideCapMs` lets a caller use a DIFFERENT completion
     *  budget than this gate's own construction-time `capMs` without needing a
     *  second gate instance over the same activity tracker. */
    async waitAtPrompt(overrideCapMs, verifiedBoundary = null) {
      const effectiveCapMs = overrideCapMs ?? capMs;
      const deadline = now() + effectiveCapMs;
      // EI-19480099650947832: track the LONGEST quiet window actually observed,
      // and report it on a defer. Without it, "the busy-gate expired" is an
      // unfalsifiable verdict — a carry-respawn can re-poll for 14 minutes and
      // the log says only `busy-gate-expired`, leaving no way to tell a genuinely
      // busy agent (gaps ≈ 0ms, a TUI spinner redrawing) from a near-miss
      // (gaps ≈ quietMs, i.e. the threshold is simply too tight). Those two have
      // OPPOSITE fixes, and reconstructing which one happened after the fact is
      // impossible — measured live on 2026-08-04, where a respawn died with no
      // evidence either way.
      let maxQuietForMs = 0;
      // Re-check in case the agent keeps emitting during the wait.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (verifiedBoundary?.()) {
          await new Promise((resolve) => setImmediate(resolve));
          if (verifiedBoundary()) return { deferred: false, boundary: 'native-turn-complete' };
        }
        const quietFor = this.quietForMs();
        if (quietFor > maxQuietForMs) maxQuietForMs = quietFor;
        if (quietFor >= quietMs) {
          // EI-22806311344295685: an expired timer can run before libuv's poll
          // phase drains an already-buffered node-pty onData callback. Yield to
          // the check phase once, then re-read the output timestamp; otherwise
          // the stale pre-poll value can release an inject into a child that is
          // still emitting. setImmediate is deliberate here: unlike another
          // timer, it runs after the current iteration's poll callbacks.
          await new Promise((resolve) => setImmediate(resolve));
          const confirmedQuietFor = this.quietForMs();
          if (confirmedQuietFor > maxQuietForMs) maxQuietForMs = confirmedQuietFor;
          if (confirmedQuietFor >= quietMs) return { deferred: false };
        }
        if (now() >= deadline) return { deferred: true, reason: 'agent-busy', maxQuietForMs, quietMs };
        const need = quietMs - quietFor;
        const wait = Math.min(need, Math.max(0, deadline - now()));
        await new Promise((r) => setTimeout(r, Math.max(10, wait)));
      }
    },
    /** WI-1872 (2): the START-RACE fix. Resolves as soon as output goes BUSY
     *  (quietForMs drops below quietMs — the agent started emitting), so a
     *  caller can safely gate the NEXT wait (waitAtPrompt, for completion) on
     *  actual activity instead of a fixed delay. Falls back to `{ started:
     *  false }` after `capMs` if busy is never observed — the caller should
     *  treat that exactly like the old fixed-delay behavior (proceed anyway;
     *  the completion-wait's own quiet check still protects against writing
     *  into a truly still-busy TUI). Pure — exported via the gate object. */
    async waitUntilBusy(capMs) {
      const deadline = now() + capMs;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.quietForMs() < quietMs) return { started: true };
        if (now() >= deadline) return { started: false };
        await new Promise((r) => setTimeout(r, Math.max(10, Math.min(50, deadline - now()))));
      }
    },
  };
}

/**
 * Carry-respawn drill RE-ARM controller (EI-12754, the leader-concurred re-arm
 * leg deferred out of the EI-12655 diff). A carry-respawn DRILL refused at the
 * busy-gate bail used to terminally drop on the FIRST refusal — correct for a
 * wake `turn` (the durable inbox stands for the next natural turn) but lossy
 * for a drill, whose whole point is the cut. This schedules exactly ONE
 * deferred retry at the next settled turn:
 *
 *   - same clean-boundary discipline (the retry re-acquires the inject mutex
 *     and re-waits the SAME agent-busy gate — no timer polling of its own, the
 *     gate's quiet check is the settle detector; D-006 never-kill-mid-turn holds);
 *   - once-only per drillId (a permanently-busy session drops LOUD on the
 *     re-armed attempt instead of looping);
 *   - every path emits a durable event: 'carry-drill-rearm-queued' when the
 *     retry is scheduled (non-terminal — op:'report'/'verify' ignore it), then
 *     either recycle()'s own terminal delivered/dropped events, or a terminal
 *     'carry-drill-carry-dropped' { rearmed:true } when the retry also defers
 *     or throws.
 *
 * WI-5368/WI-5530: this ALSO covers the PRODUCTION (non-drill) carry-respawn —
 * the session:request-compaction path every real agent uses, which carries no
 * drillId. It re-queues/retries identically, under a shared non-drill sentinel
 * key, and emits 'respawn-rearm-queued' / 'respawn-carry-dropped' rows (the
 * mode-keyed analogs of the drill rows). Previously schedule()'s `!drillId`
 * early-return made every production respawn report 'duplicate' and silently
 * drop — the busy-gate-deferred real compaction left ZERO durable trace and no
 * retry, even though op:report had already told the caller `respawn:true`.
 *
 * Pure factory (injected deps) in the makeAgentBusyGate style; exported for tests.
 */
// Shared dedupe key for non-drill (production) carry-respawns — they have no
// drillId, so concurrent production respawns collapse to ONE pending retry
// under this sentinel instead of colliding with the old `!drillId` early-return.
const NON_DRILL_REARM_KEY = '__non-drill__';

// WI-5623: anti-spin backstop for the production carry-respawn re-poll loop. A
// production respawn re-polls the busy-gate across successive windows until the
// agent idles (deliver) or the carry goes stale (CARRY_RESPAWN_MAX_AGE_MS is the
// REAL bound — reached first in the live host, where each waitAtPrompt costs a
// full busy cap). This cap only guards a degenerate test/clock where waitAtPrompt
// returns instantly, so it can never spin. Drills are always one-shot.
const PRODUCTION_REARM_MAX_ATTEMPTS = 64;

export function makeCarryRearmController({
  acquireInject, // () => Promise<release()>  — the host's gated-inject mutex
  waitIdle = null, // optional human-keystroke gate (bridged tty only)
  waitAtPrompt, // (capMs?) => Promise<{ deferred }>
  recycle, // (data, { systemPromptAddendum, drillId, sessionClass }) => Promise<void>
  emitEvent, // (kind, extra) => void — writes BOTH the per-owner host log + shared ledger
  capMs = TURN_INJECT_BUSY_CAP_MS * 2,
  // EI-18109211232286833: (msg) => boolean — re-checked right before this
  // retry finally recycles, since the whole point of the retry is that a LOT
  // of wall-clock time (the first busy-gate wait + this re-arm's) may have
  // passed since the message first arrived. Default always-false preserves
  // every existing controller unit test unchanged; the real host wires
  // isCarryRespawnStale at construction (see carryRearm below).
  isStale = () => false,
}) {
  const pending = new Set();
  // EI-18681914950138372: a SEPARATE tracking set, covering the carry-respawn's
  // FIRST delivery attempt — from the moment the host accepts the message
  // through to that attempt's conclusion (delivered / dropped / handed off to
  // a retry). `pending` (above) only covers the RETRY phase, which begins only
  // once `schedule()` runs — i.e. only after the first busy-gate wait has
  // already timed out. shouldDeferWakeForPendingRespawn's whole purpose is to
  // stop a fresh wake `turn` from winning the inject-mutex FIFO race against
  // this carry-respawn, but during that entire first wait (which can run the
  // full busy-gate cap, e.g. minutes) `pending` is still empty — a wake
  // arriving in that window sailed through the guard unfiltered, queued on the
  // mutex BEFORE the eventual retry does, and won it every time (see
  // beginFirstAttempt/endFirstAttempt call sites for the exact mechanics).
  // `inFlight` closes that gap; `pendingCount()` below reports the union.
  const inFlight = new Set();
  // EI-19480099650947832: the FRESHEST carry message per key. A production
  // respawn's re-poll loop re-reads this at the top of every attempt, so a
  // second request-compaction arriving mid-re-poll SUPERSEDES the payload
  // instead of being terminally dropped (see schedule() below).
  const latest = new Map();
  return {
    /** Live count of carry-respawns either awaiting their first delivery
     *  attempt's outcome OR a re-armed retry (diagnostics/tests, and the input
     *  to shouldDeferWakeForPendingRespawn). */
    pendingCount() {
      return pending.size + inFlight.size;
    },
    /** EI-18681914950138372: call the MOMENT a carry-respawn control message is
     *  accepted by the host, before it enters its own busy-gate wait — marks it
     *  in-flight so a wake arriving during that wait is correctly deferred. */
    beginFirstAttempt(msg) {
      const drillId = String(msg?.drillId || '');
      inFlight.add(drillId || NON_DRILL_REARM_KEY);
    },
    /** EI-18681914950138372: call exactly once, when that first attempt has
     *  fully concluded (delivered, dropped, errored, or handed off to
     *  schedule() below) — safe to call unconditionally: schedule() always
     *  adds to `pending` before this fires, so pendingCount() never dips to 0
     *  mid-handoff, and a duplicate/idempotent delete on an already-cleared
     *  key is a no-op. */
    endFirstAttempt(msg) {
      const drillId = String(msg?.drillId || '');
      inFlight.delete(drillId || NON_DRILL_REARM_KEY);
    },
    /**
     * Schedule the one-shot retry for a busy-gate-refused carry-respawn drill.
     * Returns 'queued' when scheduled, 'duplicate' when a retry for this drillId
     * is already pending (the caller should terminally drop instead), or
     * 'superseded' when a PRODUCTION respawn replaced the payload of an
     * already-pending re-poll (EI-19480099650947832 — nothing is dropped).
     */
    schedule(msg) {
      const drillId = String(msg?.drillId || '');
      const isDrill = !!drillId;
      // Drills dedupe per-drillId; a production respawn (no drillId) dedupes
      // under the shared sentinel — so a drill and a production respawn can be
      // pending independently, but two production respawns collapse to one.
      const key = isDrill ? drillId : NON_DRILL_REARM_KEY;
      if (pending.has(key)) {
        // EI-19480099650947832: a SECOND production respawn arriving while the
        // first is still re-polling used to be terminally DROPPED as a
        // duplicate — which KEPT the older carry (already failing, and destined
        // to age out at CARRY_RESPAWN_MAX_AGE_MS) and DISCARDED the fresher one
        // the agent had just built. Measured 2026-08-04 on session
        // su-4a6e2255-…: `respawn-carry-dropped {reason:'busy-gate-expired',
        // capMs:180000, rearmed:true}` at 00:38:29, while the re-poll queued at
        // 00:28:00 ran on fruitlessly for another 14 minutes. The newest
        // request is strictly the better one to deliver (newer carry document,
        // newer receivedAtMs, so it also survives the staleness guard longer),
        // so the in-flight re-poll ADOPTS it. A DRILL still dedupes terminally:
        // a drill is a one-shot test whose whole point is that single shot.
        if (isDrill) return 'duplicate';
        latest.set(key, msg);
        return 'superseded';
      }
      pending.add(key);
      latest.set(key, msg);
      const queuedKind = isDrill ? 'carry-drill-rearm-queued' : 'respawn-rearm-queued';
      const droppedKind = isDrill ? 'carry-drill-carry-dropped' : 'respawn-carry-dropped';
      // Drill rows carry drillId + sessionClass (P-020 correlation); a production
      // respawn row is keyed by `mode` instead — never a fabricated/empty drillId.
      const extra = isDrill
        ? { drillId, sessionClass: msg.sessionClass ?? '', reason: 'busy-gate-expired', capMs }
        : { mode: 'carry-respawn', reason: 'busy-gate-expired', capMs };
      emitEvent(queuedKind, extra);
      void (async () => {
        // WI-5623: a DRILL is a one-shot test — it re-arms ONCE then drops
        // (unchanged, EI-12754). A PRODUCTION (non-drill) carry-respawn is a
        // MUST-DELIVER: the session called session:request-compaction and runs
        // to the hard context wall if it never compacts. An autonomous/headless
        // session rarely presents the 1.5s idle window inside a SINGLE busy-gate
        // window, so a single retry meant 0% delivery (every production respawn
        // dropped 'busy-gate-expired'). Instead it RE-POLLS across successive
        // windows — RELEASING the inject mutex between attempts so coord/loop
        // wakes to this session are never wedged — until the agent idles
        // (deliver), the carry goes stale (CARRY_RESPAWN_MAX_AGE_MS — the real
        // bound, reached first in the live host), or the anti-spin cap is hit.
        const maxAttempts = isDrill ? 1 : PRODUCTION_REARM_MAX_ATTEMPTS;
        // EI-19480099650947832: carried onto every terminal row so a drop says
        // WHY it could never fire — see waitAtPrompt's maxQuietForMs comment.
        let observedMaxQuietMs = 0;
        let attemptsMade = 0;
        try {
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            attemptsMade = attempt + 1;
            const release = await acquireInject();
            // EI-19480099650947832: re-read the payload EVERY attempt — a later
            // request-compaction may have superseded it since the last one, and
            // the freshest carry document is always the right one to deliver.
            const current = latest.get(key) ?? msg;
            let deferred = false;
            try {
              if (waitIdle) await waitIdle();
              const atPrompt = await waitAtPrompt(capMs, current);
              deferred = !!atPrompt.deferred;
              if (Number.isFinite(atPrompt?.maxQuietForMs) && atPrompt.maxQuietForMs > observedMaxQuietMs) {
                observedMaxQuietMs = atPrompt.maxQuietForMs;
              }
              if (!deferred) {
                // EI-19480099650947832: re-read ONCE MORE at the delivery point.
                // `current` was read before the wait, and a supersede can land at
                // ANY await — including the one we just returned from. This is
                // the branch where the carry document is actually consumed, so
                // reading a stale `current` here would cut in the older carry
                // even though a fresher one had already arrived.
                const deliver = latest.get(key) ?? current;
                // EI-18109211232286833: re-check staleness right before the cut —
                // a lot of wall-clock may have passed across these waits, so a
                // message fresh at schedule() time can cross the threshold.
                if (isStale(deliver)) {
                  emitEvent(droppedKind, {
                    ...extra,
                    rearmed: true,
                    reason: 'carry-stale',
                    observedMaxQuietMs,
                    attempts: attemptsMade,
                  });
                  return;
                }
                await recycle(deliver.data, {
                  systemPromptAddendum: deliver.systemPromptAddendum ?? '',
                  drillId,
                  sessionClass: deliver.sessionClass ?? '',
                });
                return;
              }
            } finally {
              // Release BETWEEN attempts — never hold the gated-inject mutex
              // across the re-poll, or this session's wakes would wedge for the
              // whole (potentially many-window) wait.
              release();
            }
            // Deferred: the agent stayed mid-turn past the cap. A now-stale carry
            // is not worth delivering; otherwise a production respawn loops to the
            // next window, a drill falls out after its one shot.
            // EI-19480099650947832: re-read AGAIN here — a supersede that landed
            // DURING this attempt must not be killed off by the staleness of the
            // message this attempt happened to start with. That is the whole
            // point of superseding: the fresher carry resets the clock.
            if (isStale(latest.get(key) ?? current)) {
              emitEvent(droppedKind, {
                ...extra,
                rearmed: true,
                reason: 'carry-stale',
                observedMaxQuietMs,
                attempts: attemptsMade,
              });
              return;
            }
          }
          // A drill's single shot deferred, or a production respawn exhausted the
          // anti-spin cap without ever idling — terminal, loud.
          emitEvent(droppedKind, { ...extra, rearmed: true, observedMaxQuietMs, attempts: attemptsMade });
        } catch (error) {
          emitEvent(droppedKind, {
            ...extra,
            rearmed: true,
            reason: 'rearm-error',
            detail: String(error?.message ?? error).slice(0, 200),
          });
        } finally {
          pending.delete(key);
          latest.delete(key);
        }
      })();
      return 'queued';
    },
  };
}

/**
 * Submit verifier (WI-2930) — the POST-submit sibling of makeAgentBusyGate. The
 * gates above decide when it is safe to WRITE an injected turn; nothing verified
 * the submit actually TOOK (the CR can be swallowed by paste-settle, or land in a
 * briefly-locked TUI right around a compaction). This polls the output activity
 * for a bounded window after the final CR and, at each poll that finds the output
 * quiet (no turn running), writes one bare resubmit CR — capped, and harmless
 * when the composer is empty.
 *
 * Deliberately NO early-exit on a busy observation: around a compaction, "busy"
 * can be residual summarizer/context-restore output resuming after the quiet gap
 * that let the carry through — exactly the trap that strands the text. Polling
 * the full window costs seconds on a rare path and covers it.
 *
 * `quietMs` (WI-2975) is deliberately NOT the busy-gate's OUTPUT_QUIET_MS — that
 * threshold is tuned short, for "has the agent returned to an idle prompt?", a
 * different question. Here it means "did this submit start a turn at all?",
 * and a genuinely-running turn routinely goes silent for a few seconds (network
 * latency / silent thinking) without being stalled — treating that ordinary gap
 * as failure was the WI-2975 bug (spurious resubmit noise on every compaction,
 * including fully successful ones). Default to the caller's own
 * SUBMIT_VERIFY_QUIET_MS, not OUTPUT_QUIET_MS.
 *
 * Human-input abort: any human keystroke after verification starts cancels the
 * remaining polls (never fight a human who is editing the staged line —
 * `lastInputAt` is the same signal makeIdleGate defers on).
 *
 * Pure (injectable clock/sleep + getters); exported for tests.
 */
export function makeSubmitVerifier({
  lastOutputAt,
  writeCr,
  lastInputAt = () => 0,
  isQuotaBlocked = () => false,
  quietMs = SUBMIT_VERIFY_QUIET_MS,
  pollMs = SUBMIT_VERIFY_POLL_MS,
  polls = SUBMIT_VERIFY_POLLS,
  maxResubmits = SUBMIT_VERIFY_MAX_RESUBMITS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onResubmit = () => {},
  onExhausted = () => {},
} = {}) {
  const getOut = typeof lastOutputAt === 'function' ? lastOutputAt : () => 0;
  const getIn = typeof lastInputAt === 'function' ? lastInputAt : () => 0;
  return {
    /** Poll for the verify window; resubmit a bare CR at each quiet observation.
     *  Returns { polls, resubmits, aborted, exhausted } (aborted = 'human-input' | 'quota-blocked' | null;
     *  exhausted = no output was observed after the maximum resubmits). */
    async verify() {
      const inputAtStart = getIn() || 0;
      let resubmits = 0;
      let outputObservedAfterResubmit = false;
      let outputAtLastResubmit = null;
      let exhaustionNotified = false;
      let exhausted = false;
      let i = 0;
      const quotaAbort = () => ({ polls: i, resubmits, aborted: 'quota-blocked', exhausted: false });
      const notifyExhausted = () => {
        // A resubmit can legitimately wake a previously silent turn. Once any
        // output is observed after a resubmit, this verifier must never turn a
        // later quiet interval into a host-killing exhaustion signal.
        if (
          exhaustionNotified ||
          outputObservedAfterResubmit ||
          resubmits < maxResubmits
        ) {
          return;
        }
        exhaustionNotified = true;
        exhausted = true;
        try {
          onExhausted({
            polls: i,
            resubmits,
            outputObservedAfterResubmit,
          });
        } catch {
          /* an exhaustion observer must never break verifier cleanup */
        }
      };
      for (; i < polls; i++) {
        if (isQuotaBlocked()) return quotaAbort();
        await sleep(pollMs);
        // The first submit can itself paint the quota wall. Read the live
        // detector after each wait, before either retrying or declaring failure.
        if (isQuotaBlocked()) return quotaAbort();
        const outputAtPoll = getOut() || 0;
        if (
          outputAtLastResubmit != null &&
          outputAtPoll > outputAtLastResubmit
        ) {
          outputObservedAfterResubmit = true;
        }
        if ((getIn() || 0) > inputAtStart) return { polls: i + 1, resubmits, aborted: 'human-input' };
        const quietFor = now() - outputAtPoll;
        if (quietFor < quietMs) continue; // output flowing — a turn is running
        if (resubmits >= maxResubmits) {
          notifyExhausted();
          break;
        }
        resubmits++;
        const outputBeforeResubmit = getOut() || 0;
        try {
          writeCr();
        } catch {
          /* child may have exited mid-verify */
        }
        const outputAfterResubmit = getOut() || 0;
        if (outputAfterResubmit > outputBeforeResubmit) {
          outputObservedAfterResubmit = true;
        }
        outputAtLastResubmit = outputAfterResubmit;
        onResubmit(resubmits);
      }
      // If the bounded poll window ends on the final resubmit, there is no
      // following iteration to observe a quiet poll. Treat the window itself as
      // exhausted, but keep the same output-after-resubmit suppression rule.
      if (isQuotaBlocked()) return quotaAbort();
      if (i >= polls) notifyExhausted();
      return { polls: i, resubmits, aborted: null, exhausted };
    },
  };
}

/** WI-1378748: may a verifier exhaustion for THIS submit label kill the host?
 *
 *  WI-41044 made every exhaustion host-fatal. That is defensible for a STARTUP
 *  submit (a launch kickoff / recycle carry-note / session-port seed that never
 *  took leaves a session that exists but can never work — tearing it down frees
 *  the discovery key, socket and child subtree, and the launcher records a
 *  nonzero outcome). It is NOT defensible for a WAKE inject, and the difference
 *  is the whole bug:
 *
 *  A `turn`/`reset` inject is a NOTIFICATION delivered into a session that is
 *  usually alive and mid-work. The verifier's sole evidence is "the pty stayed
 *  quiet", and it cannot see WHY. Quiet has causes other than a swallowed CR —
 *  the one that bit us is a RATE-LIMITED agent: a Claude Code sitting on a
 *  weekly/5h quota wall repaints nothing at all, so a wake injected into it can
 *  never take, and the host answered by SIGTERMing a live agent mid-edit.
 *  Measured 2026-08-30: 160 hosts killed this way since WI-41044 landed, 102 of
 *  them on a `turn inject`, arriving in mass clusters (6 sessions inside 3s at
 *  20:22, 3 more at 21:04) because ONE coord broadcast wakes every session at
 *  once and every quota-silent recipient dies together.
 *
 *  The costs are wildly asymmetric. Not killing loses at most one coord wake —
 *  and loses nothing silently, because the delivery failure is still recorded
 *  (`submit-verify-unconfirmed`) and the sender already has to verify pickup.
 *  Killing destroys in-flight work and respawns the session straight back into
 *  the same wall. So a wake inject may never be host-fatal; only a startup
 *  submit may.
 *
 *  Deliberately the DEFAULT (not a per-call-site flag): a future caller that
 *  forgets the argument gets the safe behaviour for a wake label. Pure;
 *  exported for tests. */
export function submitExhaustionTerminatesHost(label) {
  const normalized = String(label ?? '')
    .trim()
    .toLowerCase();
  return !(normalized === 'turn inject' || normalized === 'reset inject');
}

/** Translate the submit verifier's semantic negative outcomes into the stable
 * delivery reasons consumed by launch/recycle callers. A human-input abort is
 * not proof that the injected turn landed, so it must remain distinguishable
 * from both success and bounded exhaustion. Pure; exported for tests. */
export function submitVerificationFailureReason(result) {
  if (result?.exhausted) return 'submit-verification-exhausted';
  if (result?.aborted) return `submit-verification-aborted-${result.aborted}`;
  return null;
}

/** WI-1386682 (1): does this pty screen text show Claude Code's OWN
 *  usage-wall copy (weekly or 5-hour)? This is the missing half of
 *  WI-1378748's fix — that item stopped a wake exhaustion from being
 *  host-fatal; it did not stop the host from reading "the pty is quiet" as
 *  "the agent is at its prompt" when the true cause is "the agent is alive
 *  but rate-limited and cannot generate at all".
 *
 *  ⚠ THE PATTERNS ARE PER-AGENT, AND THAT IS LOAD-BEARING (WI-2140984). These
 *  are CLAUDE CODE's copy, and the original code matched them against EVERY
 *  pty. A codex child ships ordinary, non-wall chrome that hits them — its
 *  slash-command list alone carries "view account usage or use a usage limit
 *  reset", plus " Consumes usage limits faster" and "Goal hit usage limits
 *  (/goal resume)" — so a perfectly healthy codex member was read as walled.
 *
 *  That also FALSIFIES the original cost model ("a false POSITIVE costs at
 *  most one deferred wake, recoverable"). That is true only of a STATIC
 *  banner, which is what the ring buffer below assumes. Chrome is REPAINTED,
 *  so it refills the window as fast as it is evicted, `isBlocked()` never
 *  clears, and every turn/reset is deferred FOREVER — the session boots
 *  healthy, reports fresh, and can never take a single turn. Measured
 *  2026-09-02: two headless codex fleet members logged one
 *  quota-block-detected at boot then 110 straight turn-deferred-quota-blocked
 *  with zero clears, ~52min unbroken, while the account read util7d 0.03 with
 *  no 429s. So a false positive is the FAR more expensive direction here, and
 *  an agent we have no captured wall copy for gets NO patterns rather than a
 *  guess borrowed from a different product.
 *
 *  Matches survive ANSI styling because the caller strips it first. Pure;
 *  exported for tests. */
const CLAUDE_QUOTA_LIMIT_BANNER_PATTERNS = [
  /weekly limit/i,
  /5-hour limit/i,
  /usage limit/i,
  /\blimit\b[^\n]{0,60}\breset(?:s|ting)?\b/i,
];

/** Codex's OWN wall copy, read off the shipped binary's strings (2026-09-02).
 *  Anchored on WHOLE SENTENCES on purpose: codex renders the bare phrase
 *  "usage limit" as routine chrome, so any looser pattern reproduces
 *  WI-2140984. Widen only against captured raw text from a REAL codex wall,
 *  and re-check the new pattern against `codex`'s own strings first. */
const CODEX_QUOTA_LIMIT_BANNER_PATTERNS = [
  /you'?ve hit your usage limit/i,
  /usage limit reached/i,
  /you'?ve reached your workspace credit limit/i,
  /your workspace is out of credits/i,
];

/** Claude's ROUTINE USAGE ADVISORY, which shares its wall's vocabulary:
 *    "You've used 75% of your weekly limit · resets Sep 17, 7am (America/New_York)"
 *  That is a progress notice with quota REMAINING — the opposite of a block — but it
 *  contains "weekly limit", and "limit … resets", so TWO of the claude patterns above
 *  fire on it. The detector then latches blocked=true and `injectTurnAtPrompt` drops
 *  every gated injection with `submit-verification-aborted-quota-blocked`, so the
 *  session is never compacted or carry-respawned and instead runs past its context
 *  ceiling until it dies. Measured 2026-09-11T16:51:45Z on
 *  su-cb1f92db-…: matchedPattern /weekly limit/i, excerpt exactly the line above, at
 *  75% used — an account with a quarter of its week left, blocked for the rest of a
 *  ~35min session (WI-10000288's own compaction was one of the casualties).
 *
 *  This is WI-2140984 again, one product over: the CODEX set immediately above was
 *  anchored to WHOLE SENTENCES precisely because codex renders "usage limit" as
 *  routine chrome, and that lesson was never carried across to the claude set, which
 *  is still bare phrases. Anchoring claude's patterns the same way is the deeper fix,
 *  but it needs captured raw text from a REAL claude wall to do safely (widening on a
 *  guess risks the far worse failure: missing a real wall and hammering it). A
 *  precise NEGATIVE guard needs no such sample and cannot mask a real wall, because
 *  it is applied PER MATCH-LINE, not to the whole screen.
 *
 *  Keep this list to the percentage-used advisory shape only. Anything that states
 *  exhaustion ("limit reached", "you've hit") must keep matching. */
const QUOTA_USAGE_ADVISORY_PATTERNS = [
  /\bused\s+\d{1,3}\s*%\s+of\s+your\b/i,
  /\b\d{1,3}\s*%\s+of\s+your\s+(?:weekly|5-hour|usage)\b/i,
];

/** Is THIS line a usage advisory rather than a wall? Scoped to the single line
 *  carrying the match so an advisory cannot suppress a real wall elsewhere on the
 *  same screen. Pure; exported for tests. */
/**
 * A quota detector is intentionally fail-closed for a real usage wall, but a
 * latched detector can otherwise turn every future gated injection into a
 * silent no-op. Keep a separate, outcome-driven liveness guard so a wall that
 * lasts long enough without one successful gated injection becomes a loud
 * health signal. The guard does not inspect PTY bytes: callers feed it the
 * detector level and the result of an actual gated delivery.
 *
 * The threshold is deliberately bounded by an attempted delivery. A quiet
 * session with no pending wake has no starvation to report; the first queued
 * wake after the threshold makes the stuck episode observable. A successful
 * gated injection during the episode suppresses the zero-success verdict.
 * Pure except for the injected onStarvation callback; exported for tests.
 */
export const QUOTA_BLOCK_STARVATION_THRESHOLD_MS = 5 * 60_000;

export function makeQuotaBlockStarvationGuard({
  thresholdMs = QUOTA_BLOCK_STARVATION_THRESHOLD_MS,
  now = Date.now,
  onStarvation = () => {},
} = {}) {
  const threshold = positiveNumber(thresholdMs, QUOTA_BLOCK_STARVATION_THRESHOLD_MS);
  let blockedSinceMs = null;
  let attemptedGatedInjections = 0;
  let successfulGatedInjections = 0;
  let alerted = false;
  let lastSignal = null;

  const clock = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const reset = () => {
    blockedSinceMs = null;
    attemptedGatedInjections = 0;
    successfulGatedInjections = 0;
    alerted = false;
    lastSignal = null;
  };

  /**
   * Observe the current detector level and, optionally, one completed gated
   * injection. gatedInjection.successful must mean the host has a positive
   * delivery/submit result; an early socket ACK is not sufficient.
   */
  const observe = ({
    quotaBlocked = false,
    observedBlockedSinceMs = null,
    gatedInjection = null,
  } = {}) => {
    const atMs = clock();
    if (!quotaBlocked) {
      reset();
      return null;
    }

    const suppliedSince = Number(observedBlockedSinceMs);
    if (blockedSinceMs == null) {
      blockedSinceMs = Number.isFinite(suppliedSince) ? suppliedSince : atMs;
    }

    const attempted = gatedInjection?.attempted === true || gatedInjection?.successful === true;
    if (attempted) attemptedGatedInjections += 1;
    if (gatedInjection?.successful === true) successfulGatedInjections += 1;

    const ageMs = Math.max(0, atMs - blockedSinceMs);
    if (
      !alerted &&
      attemptedGatedInjections > 0 &&
      successfulGatedInjections === 0 &&
      ageMs >= threshold
    ) {
      alerted = true;
      lastSignal = {
        reason: 'quota-block-starvation',
        blockedSinceMs,
        ageMs,
        thresholdMs: threshold,
        attemptedGatedInjections,
        successfulGatedInjections,
      };
      try {
        onStarvation(lastSignal);
      } catch {
        // A health signal must never break the delivery path it diagnoses.
      }
      return lastSignal;
    }
    return null;
  };

  return {
    observe,
    snapshot() {
      const atMs = clock();
      return {
        quotaBlocked: blockedSinceMs != null,
        blockedSinceMs,
        blockedAgeMs: blockedSinceMs == null ? null : Math.max(0, atMs - blockedSinceMs),
        thresholdMs: threshold,
        attemptedGatedInjections,
        successfulGatedInjections,
        alerted,
        lastSignal,
      };
    },
    reset,
  };
}

export function quotaLineIsUsageAdvisory(line) {
  const text = String(line ?? '');
  return QUOTA_USAGE_ADVISORY_PATTERNS.some((re) => re.test(text));
}

/** The banner set for one agent. An UNKNOWN agent gets [] — never another
 *  product's copy (see the cost model above). An unset agent keeps the
 *  historical claude behaviour, matching how the rest of this host reads
 *  PAPERCUSP_AGENT (it only branches on an EXPLICIT non-claude value).
 *  Pure; exported for tests. */
export function quotaBannerPatternsForAgent(agent = '') {
  const a = String(agent ?? '')
    .trim()
    .toLowerCase();
  if (!a || a === 'claude') return CLAUDE_QUOTA_LIMIT_BANNER_PATTERNS;
  if (a === 'codex') return CODEX_QUOTA_LIMIT_BANNER_PATTERNS;
  return [];
}

/** The matching half of `quotaLimitBannerVisible`, returning WHICH pattern hit
 *  and a short excerpt around it. A bare `quota-block-detected` row is what
 *  made WI-2140984 cost a fleet leader an escalation and a full investigation:
 *  the event recorded that a wall was seen but nothing about what was seen, so
 *  a false positive was indistinguishable from a real wall. Pure; exported for
 *  tests. */
export function quotaLimitBannerMatch(text, agent = '') {
  const visible = stripAnsi(String(text ?? ''));
  for (const re of quotaBannerPatternsForAgent(agent)) {
    // Scan EVERY occurrence, not just the first: a usage advisory and a real wall can
    // share one screen, and returning on the first hit would let whichever came first
    // decide. Skipping an advisory line must never skip the wall below it.
    const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (let m = scan.exec(visible); m; m = scan.exec(visible)) {
      const at = m.index ?? 0;
      const lineStart = visible.lastIndexOf('\n', at) + 1;
      const lineEndRaw = visible.indexOf('\n', at);
      const lineEnd = lineEndRaw === -1 ? visible.length : lineEndRaw;
      if (quotaLineIsUsageAdvisory(visible.slice(lineStart, lineEnd))) {
        // Zero-length matches cannot happen with these patterns, but a guard here keeps
        // a future pattern edit from spinning this loop forever.
        if (scan.lastIndex <= at) scan.lastIndex = at + 1;
        continue;
      }
      return {
        matched: true,
        pattern: String(re),
        excerpt: visible.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return { matched: false, pattern: null, excerpt: null };
}

export function quotaLimitBannerVisible(text, agent = '') {
  return quotaLimitBannerMatch(text, agent).matched;
}

/** How large a recent-screen window quotaBlockDetector keeps. Bounded (like
 *  makeOutputTap's capBytes) but deliberately smaller than
 *  childStartupOutput's 32_768-char window: the whole point is that the
 *  window EVICTS the banner once genuine new output resumes, so a smaller
 *  cap means "quota-blocked" clears after a modest amount of real churn
 *  rather than requiring many KB of it. */
const QUOTA_BLOCK_BUFFER_CHARS = 8_192;

/** WI-1386682 (1): quota-wall detector. Feed it the SAME raw pty bytes the
 *  activity tracker sees (child.onData); `isBlocked()` reports whether
 *  Claude Code's own usage-limit banner is currently visible in the recent
 *  screen. Deliberately a bounded ring buffer, not an edge-triggered
 *  one-shot: a session truly sitting on a wall emits NOTHING further (the
 *  banner is a static paint, not a redrawing spinner), so the buffer simply
 *  stops growing and stays blocked; once genuine new output resumes — the
 *  wall lifted, a recycle replaced the child, a human intervened — the
 *  detector does not need to know which; enough of that new text evicts the
 *  banner from the window and `isBlocked()` clears on its own. This is the
 *  "clear-on-output rule" the parent item asks for: not an immediate
 *  single-byte clear (which would be wrong — a redraw is routinely split
 *  across several small writes) but a level check against the current
 *  screen. Pure (no timers, no I/O); exported for tests. */
export function makeQuotaBlockDetector({
  capBytes = QUOTA_BLOCK_BUFFER_CHARS,
  agent = '',
  now = Date.now,
  deferUntilSubmit = false,
} = {}) {
  let buffer = '';
  let blocked = false;
  let awaitingSubmit = deferUntilSubmit;
  /** @type {number | null} */
  let blockedSinceMs = null;
  let lastMatch = { matched: false, pattern: null, excerpt: null };
  return {
    /** Feed one raw pty chunk. Returns the transition ('detected' | 'cleared')
     *  or null when the level didn't change, so a caller can log transitions
     *  without re-deriving state on every chunk. */
    observe(chunk) {
      // A resumed Codex TUI replays old provider errors before its first new
      // request. Those bytes are history, not a current account measurement.
      if (awaitingSubmit) return null;
      buffer = `${buffer}${String(chunk ?? '')}`;
      if (buffer.length > capBytes) buffer = buffer.slice(-capBytes);
      const hit = quotaLimitBannerMatch(buffer, agent);
      if (hit.matched) lastMatch = hit;
      if (hit.matched === blocked) return null;
      blocked = hit.matched;
      blockedSinceMs = blocked ? now() : null;
      return blocked ? 'detected' : 'cleared';
    },
    /** Arm once per child at the standalone submit keystroke. Pasted history
     * and terminal probes cannot arm it; later submits cannot clear a wall. */
    observeInput(input) {
      if (awaitingSubmit && /^[\r\n]+$/.test(String(input))) awaitingSubmit = false;
    },
    isBlocked: () => blocked,
    snapshot: () => ({ quotaBlocked: blocked, quotaBlockedSinceMs: blockedSinceMs }),
    /** WI-2140984: WHICH pattern last matched, and the text around it — so a
     *  `quota-block-detected` row says what was actually on screen and a false
     *  positive is diagnosable from the event log alone. */
    lastMatch: () => lastMatch,
    /** Reset to a fresh, un-walled state. Call on recycle: a fresh child has
     *  no screen history and cannot inherit the old child's wall. */
    reset() {
      buffer = '';
      blocked = false;
      awaitingSubmit = deferUntilSubmit;
      blockedSinceMs = null;
      lastMatch = { matched: false, pattern: null, excerpt: null };
    },
  };
}

/** How often the discovery file's activity fields are refreshed. Coarse on
 *  purpose — the consumer question is "active or idle for minutes?", and a
 *  per-byte rewrite would turn the pty bridge into an fs hot loop. */
export const ACTIVITY_PERSIST_MS = 15_000;

/**
 * Control-socket wire protocol (v1). A connector writes ONE UTF-8 payload then
 * half-closes. If it parses as a `{ v:1, mode, data }` envelope we act on the
 * mode; otherwise the whole payload is treated as a legacy idle-gated turn (so
 * the psupty spike's raw `text\r` inject still works).
 *
 *   mode:'turn' → a wake turn: idle-gated (P-013), then `data` + CR submits it.
 *   mode:'raw'  → verbatim + IMMEDIATE (bypasses the idle gate): force-interrupt
 *                 control bytes (Ctrl-C '\x03' / Esc '\x1b') for the
 *                 operator-mediated `turn:interrupt` (Phase 4, D-007). data is
 *                 written exactly, no CR appended.
 *
 * The read side (host server below) and the operator's connectors
 * (wake-executor + turn:interrupt) share this format — mirrored in
 * operator-core/lib/events/await/psu-pty-discovery.ts. Pure — exported for tests.
 */
export function encodeControl({ mode, data, ...extra }) {
  return JSON.stringify({ v: 1, mode, data, ...extra });
}

/** Parse `{ fireNumber, routineId }` off a raw envelope object, or `{}` when
 *  either is absent/malformed — the WI-5510 fire-identity fields threaded onto
 *  a loop-wake delivery (turn/reset/recycle/carry-respawn) so the STALE-FIRE
 *  GUARD below can tell a superseded delivery from a fresh one. Both fields
 *  travel together: `routineId` names WHICH loop instance (a fresh loop after
 *  loop:end + re-arm gets a new id, so its fire #1 is never confused with a
 *  prior loop's higher fire count), `fireNumber` is that loop's 1-based fire
 *  count at DECIDE time (loop-fire.ts). Absent on any pre-WI-5510 sender or a
 *  non-loop wake ⇒ the guard is a no-op for that message (unchanged behavior).
 *  Pure — exported for tests. */
function decodeFireIdentity(o) {
  const fireNumber =
    typeof o?.fireNumber === 'number' && Number.isFinite(o.fireNumber) && o.fireNumber > 0
      ? o.fireNumber
      : undefined;
  const routineId =
    typeof o?.routineId === 'string' && o.routineId.length > 0 ? o.routineId.slice(0, 200) : undefined;
  const out = {};
  if (fireNumber !== undefined) out.fireNumber = fireNumber;
  if (routineId !== undefined) out.routineId = routineId;
  return out;
}

/** Parse `{ ownerId }` off a raw envelope object, or `{}` when absent/malformed
 *  (EI-153: the sender's addressed-recipient assertion — see injectIntoHost's
 *  `ownerId` doc in psu-pty-discovery.ts). Absent on any pre-EI-153 sender or a
 *  legacy non-envelope payload ⇒ the receiver's identity check below is a no-op
 *  for that message (unchanged behavior) — mirrors decodeFireIdentity exactly.
 *  Pure — exported for tests. */
export function decodeOwnerIdentity(o) {
  const ownerId = typeof o?.ownerId === 'string' && o.ownerId.length > 0 ? o.ownerId.slice(0, 200) : undefined;
  return ownerId !== undefined ? { ownerId } : {};
}

/** Parse `{ deliveryId }` off a raw envelope object, or `{}` when absent/malformed
 *  (EI-19311270129974785: the sender's `event_wake_deliveries.id` for this wake,
 *  when the message represents one — see injectIntoHostWithConfirmation's
 *  `deliveryId` doc in psu-pty-discovery.ts). Absent on any pre-fix sender, a
 *  legacy non-envelope payload, or a one-shot raw/osc/compact/mcp-reconnect call
 *  (no delivery row) ⇒ the receiver's dedup check below is a no-op for that
 *  message (unchanged behavior) — mirrors decodeOwnerIdentity exactly.
 *  Pure — exported for tests. */
export function decodeDeliveryId(o) {
  const deliveryId =
    typeof o?.deliveryId === 'string' && o.deliveryId.length > 0 ? o.deliveryId.slice(0, 200) : undefined;
  return deliveryId !== undefined ? { deliveryId } : {};
}

/** Parse the additive quota-recovery descriptor carried only by a durable
 * mode:recycle wake. Every identity is repeated and cross-checked here: a
 * mutated operation id or owner must degrade to an ordinary recycle, never
 * gain permission to kill/restart a different session. Pure for mutation tests. */
export function decodeQuotaRecovery(o) {
  const q = o?.quotaRecovery;
  if (!q || typeof q !== 'object') return {};
  const operationId =
    typeof q.operationId === 'string' && q.operationId.length > 0
      ? q.operationId.slice(0, 200)
      : undefined;
  const recoveryOwnerId =
    typeof q.ownerId === 'string' && q.ownerId.length > 0
      ? q.ownerId.slice(0, 200)
      : undefined;
  const startedAtMs =
    typeof q.startedAtMs === 'number' && Number.isFinite(q.startedAtMs) && q.startedAtMs > 0
      ? q.startedAtMs
      : undefined;
  if (
    operationId === undefined ||
    recoveryOwnerId === undefined ||
    startedAtMs === undefined ||
    operationId !== o?.deliveryId ||
    recoveryOwnerId !== o?.ownerId
  ) return {};
  return { quotaRecovery: { operationId, ownerId: recoveryOwnerId, startedAtMs } };
}

/** Parse a control payload into { mode, data, gated }. A non-envelope payload is
 *  a legacy idle-gated turn. Pure — exported for tests. */
export function decodeControl(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  try {
    const o = JSON.parse(text);
    if (
      o &&
      o.v === 1 &&
      (o.mode === 'turn' ||
        o.mode === 'raw' ||
        o.mode === 'osc' ||
        o.mode === 'reset' ||
        o.mode === 'recycle' ||
        o.mode === 'carry-respawn' ||
        o.mode === 'compact' ||
        o.mode === 'shutdown' ||
        o.mode === 'mcp-reconnect')
    ) {
      // SHUTDOWN (WI-6638): wind this session down and EXIT. psu is `exec`'d
      // inside `gnome-terminal --wait`, so the host exiting IS the tab closing —
      // which is the whole point: an agent session whose work is finished closes
      // its own window instead of idling in an open tab forever.
      //
      // UNGATED at decode (the handler applies its OWN guards, which are stricter
      // than the turn gates and must run even when the agent is quiet): a shutdown
      // must never queue behind the coalescer or the wake gates, because the
      // request is precisely "there is no more work".
      if (o.mode === 'shutdown')
        return {
          mode: 'shutdown',
          data: String(o.data ?? ''),
          force: o.force === true,
          gated: false,
          ...decodeOwnerIdentity(o),
        };
      if (o.mode === 'raw')
        return { mode: 'raw', data: String(o.data ?? ''), gated: false, ...decodeOwnerIdentity(o) };
      // osc = recolor escape bytes for the terminal DISPLAY (not the agent) —
      // ungated + immediate, routed to the host stdout (see the handler sink).
      if (o.mode === 'osc')
        return { mode: 'osc', data: String(o.data ?? ''), gated: false, ...decodeOwnerIdentity(o) };
      // reset (RESET-CONTEXT) / recycle — the cold-auto verbs (su-cold-auto-mode
      // P-004). Both are GATED like a turn (P-006 clean-boundary: fire ONLY at a
      // settled turn, never mid-turn) — the host's idle + agent-busy gates defer
      // them exactly as they defer a wake turn. `data` is the carry-note the fresh
      // context opens on. reset = in-place `/clear` (drop transcript, keep the
      // process + MCP warm); recycle = kill + respawn the child in this same host.
      // Both also carry the WI-5510 fire identity (decodeFireIdentity) so the
      // STALE-FIRE GUARD applies to them exactly like a warm turn, and the EI-153
      // addressed-recipient assertion (decodeOwnerIdentity) so the MISDELIVERY
      // guard below applies to them too.
      if (o.mode === 'reset')
        return {
          mode: 'reset',
          data: String(o.data ?? ''),
          gated: true,
          ...decodeFireIdentity(o),
          ...decodeOwnerIdentity(o),
          ...decodeDeliveryId(o),
        };
      if (o.mode === 'recycle')
        return {
          mode: 'recycle',
          data: String(o.data ?? ''),
          gated: true,
          ...decodeFireIdentity(o),
          ...decodeOwnerIdentity(o),
          ...decodeDeliveryId(o),
          ...decodeQuotaRecovery(o),
        };
      // carry-respawn (deterministic-context-carry P-018): a clean-boundary
      // RECYCLE whose fresh Claude child receives the deterministic carry as a
      // system-prompt addendum. `data` is the optional successor first prompt.
      if (o.mode === 'carry-respawn')
        return {
          mode: 'carry-respawn',
          data: String(o.data ?? ''),
          systemPromptAddendum: String(o.systemPromptAddendum ?? ''),
          ...(typeof o.sourceTranscriptPath === 'string' && o.sourceTranscriptPath
            ? { sourceTranscriptPath: o.sourceTranscriptPath.slice(0, 4096) } : {}),
          // P-020 drill correlation is additive on the v1 envelope. An ordinary
          // P-018 carry-respawn omits both fields and stays byte-for-byte inert.
          drillId: o.drillId != null ? String(o.drillId).slice(0, 200) : '',
          sessionClass: o.sessionClass != null ? String(o.sessionClass).slice(0, 200) : '',
          gated: true,
          ...decodeFireIdentity(o),
          ...decodeOwnerIdentity(o),
          ...decodeDeliveryId(o),
        };
      // compact — RETIRED (P-022): still DECODED so a stale pre-cutover sender's
      // message reaches the handler's loud drop instead of falling through to the
      // legacy path below, which would TYPE the raw envelope at the agent as a turn.
      if (o.mode === 'compact')
        return {
          mode: 'compact',
          data: String(o.data ?? ''),
          focus: o.focus != null ? String(o.focus) : '',
          gated: true,
          ...decodeOwnerIdentity(o),
        };
      // mcp-reconnect (mcp-transport-resilience P-003, 2026-07-13): drive the
      // claude TUI's /mcp dialog to reconnect a dead HTTP-MCP server IN PLACE
      // (headed sessions keep their terminal — the owner-mandated alternative
      // to kill+resume). GATED like a turn (never mid-turn, never over a
      // half-typed owner line). `data` = the target server name (default
      // 'papercusp-su' applied by the handler).
      if (o.mode === 'mcp-reconnect')
        return { mode: 'mcp-reconnect', data: String(o.data ?? ''), gated: true, ...decodeOwnerIdentity(o) };
      return {
        mode: 'turn',
        data: String(o.data ?? ''),
        gated: true,
        ...decodeFireIdentity(o),
        ...decodeOwnerIdentity(o),
        ...decodeDeliveryId(o),
      };
    }
  } catch {
    /* not an envelope — fall through to legacy */
  }
  return { mode: 'turn', data: text, gated: true };
}

/** The full logical bytes a decoded control message represents (raw: verbatim;
 *  turn: text + CR). Pure — kept for tests / one-shot external callers. NOTE the
 *  host no longer writes a turn in one shot; see controlWrites. */
export function controlBytes(decoded) {
  return decoded.mode === 'raw' ? decoded.data : `${decoded.data}\r`;
}

// ── mcp-reconnect macro (mcp-transport-resilience P-003, 2026-07-13) ─────────
//
// A Claude Code self-re-exec (auto-update relaunch / TUI fullscreen switch)
// severs the session's HTTP-MCP transport: tools vanish, and the armed loop's
// events:await registration dies with it — the session runs DARK until a human
// types /mcp (the su-39f07 5h incident). There is no scriptable reconnect in
// the CLI (verified 2.1.208: `claude mcp` manages config only), so the host —
// the one process that owns the pty and SEES the TUI's output — drives the
// /mcp dialog itself: closed-loop (parse → keypress → re-parse), never blind
// keystrokes. Truth of the heal is judged OPERATOR-side (presence beat
// advancing, mcp-dark-watchdog P-005); the host result is advisory. Every step
// is bounded and fail-soft: any unmet expectation → Esc Esc + a durable host
// event — worst case is exactly the pre-macro status quo.

/** Strip ANSI escapes (CSI / OSC / simple ESC pairs) + normalize \r so a TUI
 *  byte stream reads as plain lines. Pure — exported for tests. */
export function stripAnsi(s) {
  return String(s ?? '')
    // OSC: ESC ] … terminated by BEL or ST (ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ params intermediates final
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '')
    // remaining simple ESC pairs (charset selects, keypad modes, bare ESC)
    .replace(/\x1b[@-Z\\-_]?/g, '')
    // carriage returns are line-rewrites in a TUI — treat as newlines
    .replace(/\r\n?/g, '\n')
    // drop other control chars except newline/tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Bounds for the diagnostic companion log. A PTY frame can contain an
 * arbitrarily long carriage-return redraw, so line boundaries alone are not
 * enough: a frame with no newline must be chunked before it reaches disk.
 */
export const HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES = 16 * 1024;
export const HEADLESS_NORMALIZED_LOG_MAX_BYTES = 4 * 1024 * 1024;
const HEADLESS_NORMALIZED_LOG_MAX_WRITE_BYTES = 64 * 1024;

/**
 * Normalize a PTY stream without making chunk boundaries observable.
 *
 * The Codex TUI emits ANSI paint sequences and carriage-return redraw frames.
 * Applying {@link stripAnsi} independently to each `onData` chunk is not
 * sufficient: an escape sequence or CRLF pair may be split across two chunks.
 * This small state machine carries only those incomplete protocol fragments,
 * strips terminal controls, turns CR redraws into physical lines, and chunks
 * a line at a bounded UTF-8 byte size while preserving its visible text.
 *
 * @param {{maxLineBytes?: number}} [options]
 * @returns {{push:(chunk?: any)=>string, flush:()=>string, reset:()=>void}}
 */
export function makeHeadlessLogNormalizer({
  maxLineBytes = HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES,
} = {}) {
  const lineLimit =
    Number.isFinite(Number(maxLineBytes)) && Number(maxLineBytes) > 0
      ? Math.floor(Number(maxLineBytes))
      : HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES;
  let ansiState = 'normal';
  let line = '';
  let lineBytes = 0;
  let suppressLf = false;
  let emitted = [];

  const emitLine = () => {
    emitted.push(`${line}\n`);
    line = '';
    lineBytes = 0;
  };

  const appendVisible = (char) => {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (lineBytes > 0 && lineBytes + bytes > lineLimit) emitLine();
    line += char;
    lineBytes += bytes;
  };

  const consume = (chunk) => {
    for (const char of String(chunk ?? '')) {
      const code = char.codePointAt(0) ?? 0;

      if (ansiState === 'escape') {
        if (char === '[' || char === '\u009b') ansiState = 'csi';
        else if (char === ']' || char === '\u009d') ansiState = 'osc';
        else ansiState = 'normal'; // simple ESC pair: drop both bytes
        continue;
      }
      if (ansiState === 'csi') {
        // CSI final bytes are in the inclusive @–~ range. Parameters and
        // intermediates are all discarded until that final byte arrives.
        if (code >= 0x40 && code <= 0x7e) ansiState = 'normal';
        continue;
      }
      if (ansiState === 'osc') {
        if (char === '\x07') ansiState = 'normal';
        else if (char === '\x1b') ansiState = 'osc-escape';
        continue;
      }
      if (ansiState === 'osc-escape') {
        ansiState = char === '\\' ? 'normal' : 'osc';
        continue;
      }

      // A CR is a logical frame boundary. Consume the LF in a subsequent CRLF
      // pair exactly once, even when the pair straddles two PTY chunks.
      if (suppressLf) {
        suppressLf = false;
        if (char === '\n') continue;
      }
      if (char === '\r') {
        emitLine();
        suppressLf = true;
        continue;
      }
      if (char === '\n') {
        emitLine();
        continue;
      }
      if (char === '\x1b') {
        ansiState = 'escape';
        continue;
      }
      // Keep tabs for readable command output; discard all other C0/DEL
      // controls. Visible Unicode is iterated by code point, so the byte bound
      // never splits a surrogate pair.
      if (char === '\t' || (code >= 0x20 && code !== 0x7f)) {
        appendVisible(char);
      }
    }
  };

  const drain = () => {
    const result = emitted.join('');
    emitted = [];
    return result;
  };

  return {
    push(chunk) {
      consume(chunk);
      return drain();
    },
    flush() {
      // A dangling escape/control sequence is not visible text. Flush the
      // visible line at a child/recycle boundary, then reset all protocol state
      // so a successor child cannot inherit a partial sequence.
      ansiState = 'normal';
      suppressLf = false;
      if (line.length > 0) emitLine();
      return drain();
    },
    reset() {
      ansiState = 'normal';
      line = '';
      lineBytes = 0;
      suppressLf = false;
      emitted = [];
    },
  };
}

/**
 * Open the normalized companion log for a headless PTY host.
 *
 * Writes are synchronous and bounded because this path is a diagnostic
 * side-channel: a failed or full companion log must never interrupt the
 * managed PTY. The file is retained as a tail-bounded, newline-delimited
 * artifact; raw PTY bytes still travel through the original stdout fd.
 *
 * @param {string} path
 * @param {{maxLineBytes?: number, maxBytes?: number, maxWriteBytes?: number}} [options]
 * @returns {{path:string, enabled:boolean, push:(chunk?:any)=>void, flush:()=>void, close:()=>void}}
 */
export function createHeadlessNormalizedLogWriter(path, {
  maxLineBytes = HEADLESS_NORMALIZED_LOG_MAX_LINE_BYTES,
  maxBytes = HEADLESS_NORMALIZED_LOG_MAX_BYTES,
  maxWriteBytes = HEADLESS_NORMALIZED_LOG_MAX_WRITE_BYTES,
} = {}) {
  const target = typeof path === 'string' ? path.trim() : '';
  const maxFileBytes =
    Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Math.floor(Number(maxBytes))
      : HEADLESS_NORMALIZED_LOG_MAX_BYTES;
  const maxChunkBytes =
    Number.isFinite(Number(maxWriteBytes)) && Number(maxWriteBytes) > 0
      ? Math.floor(Number(maxWriteBytes))
      : HEADLESS_NORMALIZED_LOG_MAX_WRITE_BYTES;
  const normalizer = makeHeadlessLogNormalizer({ maxLineBytes });
  let fd = null;
  let fileBytes = 0;

  const disabled = {
    path: target,
    enabled: false,
    push() {},
    flush() {},
    close() {},
  };
  if (!target) return disabled;

  try {
    mkdirSync(dirname(target), { recursive: true });
    // Read access is required by the tail-trim path below. `a` is write-only
    // on POSIX, so its fd makes readSync throw as soon as the cap is crossed,
    // disabling the sidecar exactly when it needs bounding most.
    fd = openSync(target, 'a+', 0o600);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* best-effort permissions; the host still owns the diagnostic path */
    }
    fileBytes = fstatSync(fd).size;
  } catch {
    try {
      if (fd != null) closeSync(fd);
    } catch {
      /* ignore */
    }
    return disabled;
  }

  const disable = () => {
    try {
      if (fd != null) closeSync(fd);
    } catch {
      /* ignore */
    }
    fd = null;
  };

  const trimFileIfNeeded = () => {
    if (fd == null || fileBytes <= maxFileBytes + maxChunkBytes) return;
    const keep = Math.min(fileBytes, maxFileBytes);
    const buffer = Buffer.alloc(keep);
    const read = readSync(fd, buffer, 0, keep, Math.max(0, fileBytes - keep));
    let body = buffer.subarray(0, read);
    if (fileBytes > keep) {
      const firstLine = body.indexOf(0x0a);
      if (firstLine >= 0) body = body.subarray(firstLine + 1);
    }
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, body, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      closeSync(fd);
      fd = openSync(target, 'a', 0o600);
      fileBytes = body.length;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        /* ignore */
      }
      // Keep the existing fd if the atomic trim failed. A diagnostic side
      // channel is allowed to grow until the next successful trim, but must
      // never take down the pty host.
    }
  };

  const writeBounded = (text) => {
    if (fd == null || !text) return;
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(maxChunkBytes, bytes.length - offset);
      const written = writeSync(fd, bytes, offset, length);
      if (!(written > 0)) break;
      offset += written;
      fileBytes += written;
    }
    trimFileIfNeeded();
  };

  const writeNormalized = (text) => {
    try {
      writeBounded(text);
    } catch {
      disable();
    }
  };

  return {
    path: target,
    enabled: true,
    push(chunk) {
      if (fd == null) return;
      writeNormalized(normalizer.push(chunk));
    },
    flush() {
      if (fd == null) return;
      writeNormalized(normalizer.flush());
    },
    close() {
      if (fd == null) return;
      writeNormalized(normalizer.flush());
      disable();
    },
  };
}

/**
 * Claude can still show its first-run wizard to a headless launch even when
 * the persisted config says onboarding is complete. A human can press Enter
 * through that wizard; a headless managed pty cannot. Keep the recovery
 * deliberately narrow: only the explicit headless Claude launch mode gets
 * these two startup answers, and only while the child is in its bounded boot
 * window.
 */
export const HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS = 30_000;
const HEADLESS_CLAUDE_ONBOARDING_BUFFER_CHARS = 32_768;
const HEADLESS_CLAUDE_THEME_PROMPT_RE =
  /(?:\b(?:choose|select|pick)\b[\s\S]{0,160}\btheme\b|\btheme\b[\s\S]{0,160}\b(?:dark|light|system)\b)/i;
const HEADLESS_CLAUDE_SECURITY_PROMPT_RE =
  /(?:\bsecurity\s+notes?\b[\s\S]{0,800}\bpress\s+enter\b|\bpress\s+enter\b[\s\S]{0,800}\bsecurity\s+notes?\b)/i;

/** The onboarding actuator is never enabled for an interactive or non-Claude
 * launch. Pure and exported so the environment gate cannot silently broaden. */
export function headlessClaudeOnboardingEnabled(env = process.env) {
  return (
    String(env?.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1' &&
    String(env?.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'claude'
  );
}

/** Read the bounded startup window from the launch environment. */
export function headlessClaudeOnboardingStartupMs(env = process.env) {
  return positiveNumber(
    env?.PAPERCUSP_PSU_HEADLESS_ONBOARDING_STARTUP_MS,
    HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS,
  );
}

/**
 * Decide whether one startup output chunk warrants the next onboarding Enter.
 *
 * The pty may split a prompt anywhere (including inside an ANSI sequence), so
 * raw chunks accumulate before ANSI stripping and matching. The theme match
 * advances to the security phase and clears that buffer: output that happened
 * to contain both screens cannot cause the second Enter before the first one
 * has been consumed by Claude. The returned `submit` action is intentionally
 * just a decision; the host owns the child.write('\r') side effect.
 *
 * @param {{enabled?: boolean, startupMs?: number, now?: () => number}} [options]
 */
export function makeHeadlessClaudeOnboardingStateMachine({
  enabled = true,
  startupMs = HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const windowMs = positiveNumber(startupMs, HEADLESS_CLAUDE_ONBOARDING_STARTUP_MS);
  const startedAt = clock();
  let phase = enabled ? 'theme' : 'disabled';
  let observed = '';

  const snapshot = (action = 'none', prompt = null) => ({
    action,
    prompt,
    phase,
    active: phase === 'theme' || phase === 'security',
    complete: phase === 'complete',
    expired: phase === 'expired',
  });

  const expire = (at = clock()) => {
    if (phase !== 'theme' && phase !== 'security') return snapshot();
    phase = 'expired';
    observed = '';
    return { ...snapshot('expired'), expiredAt: at };
  };

  const observe = (chunk, at = clock()) => {
    if (phase === 'disabled' || phase === 'complete' || phase === 'expired') return snapshot();
    if (at - startedAt >= windowMs) return expire(at);

    observed = `${observed}${String(chunk ?? '')}`;
    if (observed.length > HEADLESS_CLAUDE_ONBOARDING_BUFFER_CHARS) {
      observed = observed.slice(-HEADLESS_CLAUDE_ONBOARDING_BUFFER_CHARS);
    }
    const visible = stripAnsi(observed);

    if (phase === 'theme' && HEADLESS_CLAUDE_THEME_PROMPT_RE.test(visible)) {
      phase = 'security';
      observed = '';
      return snapshot('submit', 'theme');
    }
    if (phase === 'security' && HEADLESS_CLAUDE_SECURITY_PROMPT_RE.test(visible)) {
      phase = 'complete';
      observed = '';
      return snapshot('submit', 'security');
    }
    return snapshot();
  };

  return {
    observe,
    expire,
    isActive: () => phase === 'theme' || phase === 'security',
    isComplete: () => phase === 'complete',
    status: () => ({
      phase,
      active: phase === 'theme' || phase === 'security',
      complete: phase === 'complete',
      expired: phase === 'expired',
      startedAt,
      expiresAt: startedAt + windowMs,
      bufferedChars: observed.length,
    }),
  };
}

/**
 * Scripted Claude resumes can open an interactive recovery choice instead of
 * the composer when the saved transcript is too large for the current context:
 *
 *   Autocompact is thrashing
 *   1. Resume from summary (recommended)
 *   2. Resume full session as-is
 *   3. Don't ask again
 *
 * A quiet TUI is not a prompt in this state. Keep the recovery separate from
 * the ordinary startup/readiness heuristic so the kickoff cannot be pasted
 * into the menu, and accept the safe default exactly once. The raw output is
 * accumulated before ANSI stripping because pty chunks may split both an ANSI
 * sequence and the menu text itself. Pure and exported for tests.
 */
export const CLAUDE_RESUME_COMPACTION_STARTUP_MS = 30_000;
export const CLAUDE_RESUME_COMPACTION_RECOVERY_MS = 30_000;
const CLAUDE_RESUME_COMPACTION_BUFFER_CHARS = 32_768;
const CLAUDE_RESUME_COMPACTION_MENU_RE =
  /autocompact\s+is\s+thrashing/i;
const CLAUDE_RESUME_COMPACTION_SUMMARY_RE =
  /resume\s+from\s+summary\b/i;
const CLAUDE_RESUME_COMPACTION_FULL_RE =
  /resume\s+full\s+session\s+as[\s-]*is\b/i;
const CLAUDE_RESUME_COMPACTION_DONT_ASK_RE =
  /don['’]t\s+ask\s+again\b/i;

function claudeStandaloneComposerPromptVisible(visible) {
  return String(visible ?? '')
    .split('\n')
    .map((line) => line.trim())
    .some((line) => /^(?:❯|>|╰─>)\s*$/u.test(line));
}

function claudeResumeCompactionMenuVisible(visible) {
  const text = String(visible ?? '');
  return (
    CLAUDE_RESUME_COMPACTION_MENU_RE.test(text) &&
    CLAUDE_RESUME_COMPACTION_SUMMARY_RE.test(text) &&
    CLAUDE_RESUME_COMPACTION_FULL_RE.test(text) &&
    CLAUDE_RESUME_COMPACTION_DONT_ASK_RE.test(text)
  );
}

/** Session-env tunable detection window for the scripted Claude resume menu. */
export function claudeResumeCompactionStartupMs(env = process.env) {
  return positiveNumber(
    env.PAPERCUSP_PSU_PTY_RESUME_COMPACTION_STARTUP_MS,
    CLAUDE_RESUME_COMPACTION_STARTUP_MS,
  );
}

/** Session-env tunable bounded recovery window after the menu is selected. */
export function claudeResumeCompactionRecoveryMs(env = process.env) {
  return positiveNumber(
    env.PAPERCUSP_PSU_PTY_RESUME_COMPACTION_RECOVERY_MS,
    CLAUDE_RESUME_COMPACTION_RECOVERY_MS,
  );
}

/**
 * @param {{enabled?: boolean, startupMs?: number, recoveryMs?: number, now?: () => number}} [options]
 */
export function makeClaudeResumeCompactionRecoveryStateMachine({
  enabled = true,
  startupMs = CLAUDE_RESUME_COMPACTION_STARTUP_MS,
  recoveryMs = CLAUDE_RESUME_COMPACTION_RECOVERY_MS,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const detectionWindowMs = positiveNumber(startupMs, CLAUDE_RESUME_COMPACTION_STARTUP_MS);
  const recoveryWindowMs = positiveNumber(recoveryMs, CLAUDE_RESUME_COMPACTION_RECOVERY_MS);
  const startedAt = clock();
  let phase = enabled ? 'watching' : 'disabled';
  let recoveryStartedAt = 0;
  let observed = '';

  const snapshot = (action = 'none') => ({
    action,
    phase,
    recoveryStarted: recoveryStartedAt > 0,
    selectedSummary: recoveryStartedAt > 0,
    awaitingPrompt: phase === 'awaiting-prompt',
    ready:
      phase === 'disabled' ||
      phase === 'watching' ||
      phase === 'watch-expired' ||
      phase === 'ready',
    timedOut: phase === 'timed-out',
    active: phase === 'watching' || phase === 'awaiting-prompt',
  });

  const expireIfNeeded = (at = clock()) => {
    if (phase === 'watching' && at - startedAt >= detectionWindowMs) {
      phase = 'watch-expired';
      observed = '';
      return snapshot('expired');
    }
    if (phase === 'awaiting-prompt' && at - recoveryStartedAt >= recoveryWindowMs) {
      phase = 'timed-out';
      observed = '';
      return snapshot('expired');
    }
    return snapshot();
  };

  const observe = (chunk, at = clock()) => {
    const expiration = expireIfNeeded(at);
    if (expiration.action === 'expired') return expiration;
    if (phase === 'disabled' || phase === 'watch-expired' || phase === 'ready' || phase === 'timed-out') {
      return snapshot();
    }

    observed = `${observed}${String(chunk ?? '')}`;
    if (observed.length > CLAUDE_RESUME_COMPACTION_BUFFER_CHARS) {
      observed = observed.slice(-CLAUDE_RESUME_COMPACTION_BUFFER_CHARS);
    }
    const visible = stripAnsi(observed);

    if (phase === 'watching' && claudeResumeCompactionMenuVisible(visible)) {
      // Clear the menu paint before waiting for a post-selection repaint. This
      // prevents its selected-row `❯` from being mistaken for the composer.
      phase = 'awaiting-prompt';
      recoveryStartedAt = at;
      observed = '';
      return snapshot('select-summary');
    }
    if (phase === 'awaiting-prompt' && claudeStandaloneComposerPromptVisible(visible)) {
      phase = 'ready';
      observed = '';
      return snapshot('ready');
    }
    return snapshot();
  };

  const expire = (at = clock()) => {
    if (phase === 'watching') {
      phase = 'watch-expired';
      observed = '';
      return snapshot('expired');
    }
    if (phase === 'awaiting-prompt') {
      phase = 'timed-out';
      observed = '';
      return snapshot('expired');
    }
    return snapshot();
  };

  return {
    observe,
    expire,
    tick: expireIfNeeded,
    isReady: () => snapshot().ready,
    isAwaitingPrompt: () => phase === 'awaiting-prompt',
    isTimedOut: () => phase === 'timed-out',
    recoveryStarted: () => recoveryStartedAt > 0,
    status: () => ({
      ...snapshot(),
      startedAt,
      detectionExpiresAt: startedAt + detectionWindowMs,
      recoveryExpiresAt: recoveryStartedAt ? recoveryStartedAt + recoveryWindowMs : null,
      bufferedChars: observed.length,
    }),
  };
}

/** WI-41386 — the SCROLLBACK GUARD on the child → terminal bridge.
 *
 *  `ESC[3J` (ED param 3, "erase saved lines") deletes the TERMINAL'S SCROLLBACK
 *  outright — not the visible screen, the owner's history. No agent TUI has a
 *  legitimate reason to issue it: a CLI that wants a clean canvas has `ESC[2J`
 *  (visible screen) and the alternate screen buffer, neither of which touches
 *  what has already scrolled away. So we drop it on the way to the real
 *  terminal, for every backend.
 *
 *  MEASURED (2026-08-24): omp emits `ESC[3J` at byte offset 20 of its boot
 *  stream — ~25,000 bytes BEFORE it switches to the alternate screen at offset
 *  25,242 — so it erases the PRIMARY buffer's history on every single boot. In
 *  a 40-row pane holding 60 marker lines, an omp boot destroyed 25 of them;
 *  with this guard, 0. That is a different failure from the claude/codex cursor
 *  overwrite (see respawnTerminalHandoffBytes) and no host-side cursor anchoring
 *  can prevent it, because the CHILD is issuing the erase.
 *
 *  Deliberately narrow: `2J`/`1J`/`0J` are visible-screen erases every TUI needs
 *  and are passed through untouched. Only param 3 (and its private `?3J` spelling)
 *  is dropped.
 *
 *  Chunk-boundary safe: a pty delivers arbitrary byte runs, so an escape can be
 *  split across two `onData` chunks. A tail that could still become one is held
 *  back and prepended to the next chunk; the hold is bounded so a stream that
 *  simply ends on a stray ESC cannot strand output.
 *
 *  Stateful per child — build a fresh one each time the bridge is (re)wired.
 *  Pure factory — exported for tests.
 */
export const SCROLLBACK_ERASE_RE = /\x1b\[\??3J/g;
/** Longest tail we will hold waiting for the rest of a possible `ESC[…3J`. */
const SCROLLBACK_GUARD_MAX_CARRY = 8;
export function makeScrollbackGuard() {
  let carry = '';
  return {
    /** @param {string} chunk @returns {string} bytes safe to write to the terminal */
    filter(chunk) {
      let s = carry + String(chunk ?? '');
      carry = '';
      // Hold back only a tail that is still a PREFIX of an erase sequence —
      // never arbitrary trailing bytes, which would reorder normal output.
      const m = s.match(/\x1b(?:\[\??[0-9;]*)?$/);
      if (m && m[0].length <= SCROLLBACK_GUARD_MAX_CARRY) {
        carry = m[0];
        s = s.slice(0, s.length - carry.length);
      }
      return s.replace(SCROLLBACK_ERASE_RE, '');
    },
    /** Flush whatever is held (child exit / teardown) so nothing is swallowed. */
    flush() {
      const held = carry;
      carry = '';
      return held.replace(SCROLLBACK_ERASE_RE, '');
    },
  };
}

/** A launch seed must not reach a TUI before its editor exists. Most backends
 * are ready for the existing quiet-window check after their first output byte,
 * but OMP emits terminal capability probes before it paints any UI, and Codex
 * animates a multi-second character-by-character "Tip: ..." onboarding line
 * (plus, occasionally, an MCP-startup warning typed the same way) before its
 * composer ever paints — a mid-animation pause can look "quiet at a prompt"
 * to the ordinary quiescence gate even though the real editable prompt has not
 * installed yet (WI-4943: a live Claude→Codex port wrote its managed seed
 * during this animation, the submit CR landed as inert paste text, and native
 * persistence correctly failed). OMP's stable `omp vN` banner is the earliest
 * backend-owned proof that startup reached the dashboard; Codex's own stable
 * proof is its composer footer's live context-budget readout ("NN% context
 * left"), which is chrome the TUI only paints once the input line is
 * installed — verified against the shipped `codex` binary's embedded UI
 * strings (`@openai/codex-linux-x64`). The ordinary output-quiescence gate
 * still runs after either marker. Pure and exported so backend readiness
 * cannot regress into timing folklore. */
export function startupOutputReady(agent, output) {
  const visible = stripAnsi(output);
  const normalized = String(agent ?? '').toLowerCase();
  if (normalized === 'omp') return /\bomp\s+v\d/i.test(visible);
  if (normalized === 'codex') return /\d{1,3}%\s*context left/i.test(visible);
  return String(output ?? '').length > 0;
}

/** Terminate the entire process group created by forkpty, not only its leader.
 * OMP launches a descendant process; signalling only node-pty's immediate child
 * can let that target survive after the host exits. The direct child signal is
 * retained as a cross-platform fallback (negative group pids are POSIX-only). */
/**
 * node-pty's NUMERIC signal -> its name ('SIGHUP'), or null when there was no signal.
 *
 * WI-38054. node-pty reports a signal death as `{ exitCode: 0, signal: N }`; the number
 * alone is unreadable in a database row, and `0`/undefined must map to null rather than
 * to a spurious signal name — a session that exited normally must not acquire one.
 *
 * Resolved from `os.constants.signals` rather than a hardcoded table so it stays correct
 * across platforms (the numbers differ) instead of confidently naming the wrong signal.
 */
export function signalNameFromCode(signal) {
  if (typeof signal !== 'number' || !Number.isFinite(signal) || signal <= 0) return null;
  for (const [name, num] of Object.entries(osConstants.signals)) {
    if (num === signal) return name;
  }
  // An unrecognised number is still positive evidence of a KILL, so never discard it —
  // returning null here would silently restore the "looks like a clean exit" bug.
  return `SIG${signal}`;
}

export function killPtyProcessTree(child, signal = 'SIGKILL', kill = process.kill) {
  const pid = Number(child?.pid);
  let killed = false;
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 1) {
    try {
      kill(-pid, signal);
      killed = true;
    } catch {
      /* the group may already be gone; try the direct child below */
    }
  }
  try {
    child?.kill?.(signal);
    killed = true;
  } catch {
    /* already gone */
  }
  return killed;
}

/**
 * A forkpty process-group kill is not a lifetime boundary for a descendant that
 * called `setsid(2)`: it leaves the pgid but remains in the terminal's cgroup.
 * That exact shape left a 70 GiB diagnostic Hono host running for 12 hours after
 * its agent session ended (EI-20349478936631977).
 *
 * Reap only scopes that are structurally one-session containers. In particular,
 * never sweep a `.service` cgroup: operator/checkpoint services host unrelated
 * work and killing their other members would cross the session boundary. VTE
 * allocates one `vte-spawn-*.scope` per terminal; console-spawn's headless and
 * console scopes carry the same one-session invariant. Enrolled headless launches
 * use a task-manager `pc-*.scope`; that scope is accepted only when the caller has
 * explicitly proved the current host is headless.
 */
const DEDICATED_PSU_SCOPE_RE = /^(?:vte-spawn-[^/]+|papercup-(?:headless|console)-[^/]+|pc-[0-9a-z]{4,64}(?:--[A-Za-z0-9._-]+)?)\.scope$/;
const CGROUP_ROOT = '/sys/fs/cgroup';

function procParentPid(pid, readText) {
  let stat;
  try {
    stat = String(readText(`/proc/${pid}/stat`));
  } catch {
    return null;
  }
  // comm is parenthesised and may itself contain spaces or `)`, so split after
  // the LAST close-paren. The remaining fields begin with state, then ppid.
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) return null;
  const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : null;
}

function protectedAncestorChain(selfPid, readText) {
  const protectedPids = new Set();
  let pid = selfPid;
  for (let depth = 0; depth < 128; depth++) {
    if (!(Number.isSafeInteger(pid) && pid > 0) || protectedPids.has(pid)) {
      return { complete: false, protectedPids };
    }
    protectedPids.add(pid);
    if (pid === 1) return { complete: true, protectedPids };
    const parent = procParentPid(pid, readText);
    if (!parent) return { complete: false, protectedPids };
    pid = parent;
  }
  return { complete: false, protectedPids };
}

function dedicatedScopeDirForPid(pid, readText, { allowManagedScope = false } = {}) {
  let raw;
  try {
    raw = String(readText(`/proc/${pid}/cgroup`));
  } catch {
    return null;
  }
  const unified = raw.split('\n').find((line) => line.includes('::'));
  const rel = unified?.slice(unified.indexOf('::') + 2).trim();
  if (!rel || rel.includes('..')) return null;
  const parts = rel.split('/').filter(Boolean);
  const scopeIndex = parts.findLastIndex((part) => part.endsWith('.scope'));
  if (scopeIndex < 0) return null;
  const scopeLeaf = parts[scopeIndex];
  if (!DEDICATED_PSU_SCOPE_RE.test(scopeLeaf)) return null;
  // A `pc-*.scope` is normally an independently-managed task. Only the explicit
  // headless launch path may sweep it; without this gate, generic PTY cleanup
  // could kill a sibling task merely because it shares the task-manager naming
  // convention.
  if (scopeLeaf.startsWith('pc-') && !allowManagedScope) return null;
  return `${CGROUP_ROOT}/${parts.slice(0, scopeIndex + 1).join('/')}`;
}

function collectScopePids(scopeDir, readText, readDir) {
  const pids = new Set();
  const visit = (dir) => {
    let raw;
    try {
      raw = String(readText(`${dir}/cgroup.procs`));
    } catch {
      return false;
    }
    for (const token of raw.split(/\s+/)) {
      const pid = Number(token);
      if (Number.isSafeInteger(pid) && pid > 1) pids.add(pid);
    }
    try {
      for (const entry of readDir(dir)) {
        if (entry?.isDirectory?.()) visit(`${dir}/${entry.name}`);
      }
    } catch {
      // The root membership read is authoritative for the incident class. A
      // disappearing or unreadable child cgroup is best-effort and retried by
      // the next pass if it remains visible.
    }
    return true;
  };
  return visit(scopeDir) ? pids : null;
}

/**
 * Kill residual members of THIS host's exact dedicated session scope while
 * protecting the host and its full ancestor chain. The cgroup filesystem is the
 * authority even when systemd reports the transient unit `inactive/dead`: unlike
 * `systemctl stop`, membership remains readable until the last child exits.
 *
 * All IO is injectable so the inactive/dead-with-live-child regression is
 * reproducible without putting a real process in the test runner's cgroup.
 */
export function reapDetachedPtyScopeResidue({
  selfPid = process.pid,
  platform = process.platform,
  readText = (path) => readFileSync(path, 'utf8'),
  readDir = (path) => readdirSync(path, { withFileTypes: true }),
  kill = process.kill,
  maxPasses = 3,
  allowManagedScope = false,
} = {}) {
  const empty = (skippedReason, scopeDir = null, protectedPids = []) => ({
    scopeDir,
    protectedPids,
    killedPids: [],
    failedPids: [],
    skippedReason,
  });
  if (platform !== 'linux') return empty('non-linux');

  const scopeDir = dedicatedScopeDirForPid(selfPid, readText, { allowManagedScope });
  if (!scopeDir) return empty('not-in-dedicated-session-scope');

  const ancestors = protectedAncestorChain(selfPid, readText);
  const protectedPids = [...ancestors.protectedPids].sort((a, b) => a - b);
  // Fail toward preserving processes if we cannot identify every ancestor. The
  // alternative could kill the terminal/shim that is still serialising exit.
  if (!ancestors.complete) return empty('ancestor-chain-unreadable', scopeDir, protectedPids);

  const attempted = new Set();
  const killedPids = [];
  const failedPids = [];
  const passes = Math.max(1, Math.min(10, Number(maxPasses) || 1));
  for (let pass = 0; pass < passes; pass++) {
    const members = collectScopePids(scopeDir, readText, readDir);
    if (!members) return empty('scope-membership-unreadable', scopeDir, protectedPids);
    const targets = [...members]
      .filter((pid) => !ancestors.protectedPids.has(pid) && !attempted.has(pid))
      .sort((a, b) => a - b);
    if (targets.length === 0) break;
    for (const pid of targets) {
      attempted.add(pid);
      try {
        kill(pid, 'SIGKILL');
        killedPids.push(pid);
      } catch {
        failedPids.push(pid);
      }
    }
  }
  return { scopeDir, protectedPids, killedPids, failedPids, skippedReason: null };
}

/** Only a genuine end of an agent-launched session owns the scope. */
export function shouldReapDetachedPtyScopeResidue({
  bridgeTty,
  headless = false,
  launchedBy,
  reexecRequested,
} = {}) {
  const ownedLaunch = Boolean(String(launchedBy ?? '').trim() && !reexecRequested);
  return Boolean(ownedLaunch && (bridgeTty || headless === true));
}

/** Status of the /mcp dialog row naming `name`: 'connected' | 'not-connected' |
 *  'unknown' | null (row doesn't name it). Negative markers are checked FIRST;
 *  note \bconnected\b does NOT match inside "disconnected" (no word boundary
 *  after "dis"), but explicit negatives keep this robust to copy drift. Pure —
 *  exported for tests. */
export function mcpServerRowStatus(line, name) {
  const l = String(line ?? '');
  if (!l.includes(name)) return null;
  if (/\b(disconnected|failed|error|needs authentication|connecting|pending|retrying)\b/i.test(l))
    return 'not-connected';
  if (/\bconnected\b/i.test(l)) return 'connected';
  return 'unknown';
}

/** Does the freshest paint read as "`name` is connected"? Two shapes exist:
 *  the LIST view puts name + status on ONE row (mcpServerRowStatus decides);
 *  the DETAIL view shows the name as a header and `Status: … connected` on its
 *  OWN line — so a bare status line is decisive there (the detail view shows
 *  only one server). Scans freshest-line-first; the first decisive row wins.
 *  Pure — exported for tests. */
export function mcpConnectedVerdict(visible, name) {
  const lines = String(visible ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const rowSt = mcpServerRowStatus(l, name);
    if (rowSt) return rowSt === 'connected';
    if (/\bstatus\b/i.test(l)) {
      if (/\b(disconnected|failed|error|connecting|pending|retrying|needs authentication)\b/i.test(l)) return false;
      if (/\bconnected\b/i.test(l)) return true;
    }
  }
  return false;
}

/** Is the ❯ selection cursor on the (freshest) dialog row matching `test`?
 *  Parses an ANSI-stripped visible chunk; the LAST matching line reflects the
 *  most recent repaint. Pure — exported for tests. */
export function mcpDialogRowSelected(visible, test) {
  const lines = String(visible ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const row = [...lines].reverse().find((l) => test(l));
  if (!row) return false;
  // the cursor glyph precedes the row text; require it BEFORE the matched content
  const m = row.search(/❯|›/u);
  return m >= 0 && m < row.length && test(row.slice(m));
}

/**
 * Drive the claude TUI's /mcp dialog to reconnect `serverName` — the P-003
 * closed-loop macro. All IO is injected (write = child stdin bytes; readTap /
 * resetTap = the rolling child-output tap) so the walker unit-tests against a
 * scripted fake TUI. Steps (each bounded, each verified off the screen):
 *   1. type `/mcp`, settle, CR (separate keystroke — paste-detector, WI-2930).
 *   2. wait for the dialog to paint (target server name visible).
 *      Already-connected ⇒ close + ok('already-connected') — the benign-misfire
 *      no-op the watchdog relies on.
 *   3. arrow-down until the ❯ cursor sits on the target row (re-parse after
 *      every keypress; bounded), then Enter.
 *   4. if a reconnect action row paints, cursor onto it the same way + Enter
 *      (some versions reconnect straight off step 3's Enter — then this is
 *      skipped by the connected-wait below).
 *   5. wait for the target row to read connected; Esc Esc out either way.
 * Returns { ok, step, detail } — the caller appendHostEvent()s it durably.
 */
export async function runMcpReconnectMacro({
  serverName,
  write,
  readTap,
  resetTap,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  crDelayMs = 150,
  settleMs = 300,
  paintBudgetMs = 8_000,
  reconnectBudgetMs = 20_000,
  maxArrows = 40,
}) {
  const ESC = '\x1b';
  const DOWN = '\x1b[B';
  const CR = '\r';
  const visible = () => stripAnsi(readTap());
  const closeOut = async () => {
    write(ESC);
    await sleep(150);
    write(ESC);
  };
  const waitFor = async (test, budgetMs) => {
    const until = Date.now() + budgetMs;
    for (;;) {
      const v = visible();
      if (test(v)) return v;
      if (Date.now() >= until) return null;
      await sleep(150);
    }
  };
  const targetRowStatus = (v) => {
    const lines = v.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const st = mcpServerRowStatus(lines[i], serverName);
      if (st) return st;
    }
    return null;
  };

  // (1) open the dialog
  resetTap();
  write('/mcp');
  await sleep(crDelayMs);
  write(CR);

  // (2) painted?
  const painted = await waitFor((v) => v.includes(serverName), paintBudgetMs);
  if (!painted) {
    await closeOut();
    return { ok: false, step: 'open-dialog', detail: `'${serverName}' never painted within ${paintBudgetMs}ms` };
  }
  if (targetRowStatus(painted) === 'connected') {
    await closeOut();
    return { ok: true, step: 'already-connected', detail: 'target row reads connected — nothing to heal' };
  }

  // (3) cursor onto the target row
  const onTarget = () => mcpDialogRowSelected(visible(), (l) => l.includes(serverName));
  let selected = onTarget();
  for (let i = 0; !selected && i < maxArrows; i++) {
    resetTap();
    write(DOWN);
    await sleep(settleMs);
    selected = onTarget();
  }
  if (!selected) {
    await closeOut();
    return { ok: false, step: 'select-server', detail: `cursor never reached '${serverName}' in ${maxArrows} downs` };
  }
  resetTap();
  write(CR);
  await sleep(settleMs);

  // (4) a reconnect action row (if this version paints one)
  if (/\breconnect\b/i.test(visible())) {
    const onReconnect = () => mcpDialogRowSelected(visible(), (l) => /\breconnect\b/i.test(l));
    let sel = onReconnect();
    for (let i = 0; !sel && i < maxArrows; i++) {
      resetTap();
      write(DOWN);
      await sleep(settleMs);
      sel = onReconnect();
    }
    if (sel) {
      resetTap();
      write(CR);
    }
    // not found selected ⇒ fall through — the connected-wait below still judges it
  }

  // (5) did it connect? (list-row OR detail-status shape — mcpConnectedVerdict)
  const done = await waitFor((v) => mcpConnectedVerdict(v, serverName), reconnectBudgetMs);
  await closeOut();
  return done
    ? { ok: true, step: 'done', detail: 'connected verdict observed' }
    : { ok: false, step: 'await-connected', detail: `no connected marker within ${reconnectBudgetMs}ms` };
}

// ── Same-source turn coalescing (compaction-continuity-hardening-2026-07-07 P-001a) ──
//
// Every control-socket connection runs its OWN async handler, and a gated 'turn'
// waits at the idle + agent-busy gates before writing. So N wakes arriving while
// the agent is busy all queue at the gates and ALL inject back-to-back the moment
// the prompt returns — measured live: the same loop wake delivered up to 9×, each
// a full template copy (~3KB), straight into the woken session's context. The
// upstream layers are NOT the leak (loop fires park at infinity while a turn is in
// flight; the await store's pump already coalesces per-subscriber deliveries) —
// only injects that stack up INSIDE this host between gate-wait and pty-write.
//
// The coalescer folds same-source turns while one is still waiting: the FIRST
// arrival becomes the waiter; later same-key arrivals just update it to the newest
// text and bump a fold counter, then return. When the waiter finally passes the
// gates it claims the newest text + fold count and delivers ONE turn annotated
// with how many duplicates folded in. Keyed by the turn text's first non-empty
// line: a loop wake's first line carries the loop marker + goal (stable across
// wakes of the same loop), while distinct sources (owner messages, other loops)
// differ — those still deliver independently.

/** Coalesce key for an injected turn: a loop's stable instance id when present,
 *  otherwise its first non-empty line, trimmed+capped. Loop short-form wakes
 *  lead with `Loop wake #<fireNumber>`, so text-only keys treat every fire as a
 *  different source and let a queued backlog spend one turn per fire. The
 *  envelope's routineId is the stable identity we actually want to coalesce.
 *
 *  WI-2141436 hole #4: `routineId` alone has no owner component. In the normal
 *  case this is safe — `makeTurnCoalescer()` is instantiated once per host
 *  PROCESS and one process serves exactly one ownerId's control socket, so its
 *  `pending` Map is already owner-scoped by construction. The residual gap is
 *  a socket-identity collision one layer down (the EI-153 comment's own
 *  "sanitizeKey collision at some OTHER layer") COMBINED with an unaddressed
 *  arrival (msg.ownerId omitted — the same latent hole as #1-#3): that pair
 *  can reach the coalescer without ever hitting the `msg.ownerId !== ownerId`
 *  mismatch guard, because the guard is a no-op when ownerId is absent. Taking
 *  `ownerId` here and folding it into the key is defense-in-depth for exactly
 *  that combination — it costs nothing in the common case (every call site
 *  passes the HOST's own ownerId, so same-host keys are unaffected) and
 *  guarantees two different owners' pending turns can never fold into one
 *  another even if their sockets ever did collide.
 *  Pure — exported for tests.
 *  @param {string} [data]
 *  @param {string} [routineId]
 *  @param {string} [ownerId] */
export function turnCoalesceKey(data, routineId, ownerId) {
  const ownerPrefix = String(ownerId ?? '').trim() ? `owner:${String(ownerId).trim()}|` : '';
  const loopId = String(routineId ?? '').trim();
  if (loopId) return `${ownerPrefix}loop-fire:${loopId}`;
  const first = String(data ?? '')
    .split('\n')
    .find((l) => l.trim().length > 0);
  return `${ownerPrefix}${(first ?? '').trim().slice(0, 300)}`;
}

/** Render the delivered turn text, annotating how many duplicates folded in.
 *  Pure — exported for tests. */
export function renderCoalescedTurn(data, folded) {
  if (!folded || folded < 1) return data;
  return (
    `${data}\n(${folded} duplicate queued wake${folded === 1 ? ' was' : 's were'} coalesced ` +
    'into this ONE delivery while your session was busy — treat this as a single wake, not ' +
    `${folded + 1} separate ones)`
  );
}

/** The per-host coalescer state machine. admit() returns true when the arrival was
 *  FOLDED into an already-waiting inject (the caller must NOT proceed); false when
 *  the caller became the waiter and must claim() at delivery — or on ANY early exit
 *  (defer/error), so folded wakes never black-hole behind a dead waiter. */
export function makeTurnCoalescer() {
  const pending = new Map(); // key -> { data, folded, metadata? }
  return {
    admit(key, data, metadata) {
      const p = pending.get(key);
      if (p) {
        p.data = data; // newest wins — it carries the freshest checkpoint splice
        if (metadata !== undefined) p.metadata = metadata;
        p.folded += 1;
        return true;
      }
      pending.set(key, metadata === undefined ? { data, folded: 0 } : { data, folded: 0, metadata });
      return false;
    },
    /** Replace the text/metadata of an EXISTING waiter without counting another
     *  logical fire. A retry of the SAME durable delivery id is not a folded wake,
     *  but its executor-side delivery re-check may have rebuilt the envelope from a
     *  newer loop:checkpoint while the first attempt was still behind this host's
     *  busy gate (EI-21428742689578243). Returning false when the waiter already
     *  claimed its slot keeps this best-effort and never resurrects a delivered turn. */
    refresh(key, data, metadata) {
      const p = pending.get(key);
      if (!p) return false;
      // A newer DISTINCT fire may already have folded into this same routine
      // waiter after the original delivery was accepted. A late retry of the
      // older delivery still carries its older fireNumber: it may refresh its
      // own checkpoint snapshot, but it must not roll the logical fire backward.
      if (
        p.metadata?.routineId &&
        metadata?.routineId === p.metadata.routineId &&
        Number.isFinite(p.metadata.fireNumber) &&
        Number.isFinite(metadata.fireNumber) &&
        p.metadata.fireNumber > metadata.fireNumber
      ) {
        return false;
      }
      p.data = data;
      if (metadata !== undefined) p.metadata = metadata;
      return true;
    },
    claim(key) {
      const p = pending.get(key) ?? null;
      pending.delete(key);
      return p;
    },
    size() {
      return pending.size;
    },
  };
}

/** Default TTL a delivery id is remembered as "already accepted" (EI-19311270129974785).
 *  Sized comfortably above the client's own retry envelope — `markDeliveryFailed`'s
 *  backoff caps at 10min and the pump gives up after a bounded attempt count — so a
 *  legitimate late retry of an already-accepted delivery is always still deduped, while
 *  the map cannot grow unbounded on a long-lived host. Exported for tests. */
export const DELIVERY_DEDUP_TTL_MS = 30 * 60_000;

/**
 * The per-host delivery-id dedup memory (EI-19311270129974785): once a delivery has
 * been ACK'd 'accepted' (see the conn.on('end') handler's early-ack fast path), the
 * host is unstoppably committed to eventually running the gated pipeline for it —
 * but the CLIENT cannot always tell that happened. Its own ack-wait can time out, or
 * the host's ack write-back can fail (both explicitly documented as best-effort, see
 * the "the client's own timeout is the backstop" comment below) — either way looks to
 * the client exactly like a miss, and it retries with an IDENTICAL delivery id. Without
 * this memory, a retry arriving after the original waiter already cleared (delivered or
 * dropped) reads as a brand-new, unrelated request and gets a SECOND real turn written
 * into the pty — the turnCoalescer above only folds concurrent duplicates still parked
 * at the gate, and has no notion of "this exact delivery already ran to completion."
 * `isDuplicate` opportunistically sweeps expired entries on every call (bounded cost —
 * only iterates while there is something to evict); pure factory, exported for tests. */
export function makeDeliveryDedup({ ttlMs = DELIVERY_DEDUP_TTL_MS, now = Date.now } = {}) {
  const entries = new Map(); // deliveryId -> { state: 'pending'|'completed', at }
  const sweep = (t) => {
    for (const [k, entry] of entries) {
      if (t - entry.at > ttlMs) entries.delete(k);
    }
  };
  const getState = (id) => {
    if (!id) return null;
    const t = now();
    sweep(t);
    return entries.get(id)?.state ?? null;
  };
  return {
    /** Return the live state for `id`, or null when it is new/expired. */
    state(id) {
      return getState(id);
    },
    /** True when `id` is pending or completed within the TTL. `id` may be
     *  undefined/empty (a message with no delivery row) — always false then, so
     *  callers can pass it through unconditionally. */
    isDuplicate(id) {
      return getState(id) !== null;
    },
    /** Record the early ACK commitment while the detached gated pipeline runs. */
    markPending(id) {
      if (!id) return;
      const current = entries.get(id);
      if (current?.state === 'completed') return;
      entries.set(id, { state: 'pending', at: now() });
    },
    /** Record the point at which the gated pipeline committed its delivery. */
    markCompleted(id) {
      if (!id) return;
      entries.set(id, { state: 'completed', at: now() });
    },
    /** A terminal failed/deferred pipeline is eligible for a later retry. */
    clearPending(id) {
      if (!id) return;
      if (entries.get(id)?.state === 'pending') entries.delete(id);
    },
    /** Backward-compatible name for callers that already have a committed delivery. */
    markAccepted(id) {
      this.markCompleted(id);
    },
    size() {
      sweep(now());
      return entries.size;
    },
  };
}

/**
 * A minimal FIFO async mutex serializing the GATED-inject critical section within
 * a single host (EI-8822). Each control-socket connection runs its OWN async
 * handler, and a gated inject waits at the idle + agent-busy gates before it
 * writes. Without this, two gated injects freed at the SAME clean boundary — a
 * coord wake `turn` and a session:request-compaction `/compact`, both released the
 * instant the agent returns to its prompt — both pass the at-prompt gate and
 * interleave their bytes into the SAME pty input line. The second's text lands
 * CONCATENATED after the first ("<wake payload>…/compact <focus>"), so the CLI
 * reads it as one prose message, not a command, and the compaction silently never
 * runs (the agent keeps working at 90%+ context believing it compacted). The
 * coalescer above only folds SAME-source turns; it gives no mutual exclusion
 * between a wake and a compact. Holding this mutex across the whole
 * gate-wait-through-write sequence guarantees every gated inject is written as an
 * isolated, uninterrupted input line. Ungated raw/osc injects never acquire it (a
 * force-interrupt byte must land immediately, mid-turn; an osc recolor targets the
 * terminal display, not the agent's input line). `acquire()` resolves to a
 * `release` fn once the lock is free; the holder MUST call it (a `finally`). A
 * throwing/deferred critical section still releases via that finally, so one
 * inject's failure never wedges the queue.
 *
 * EI-22123519641932348: `await prev` alone has NO bound — every gate/verify
 * step downstream of acquire() is independently time-capped (confirmed by
 * reading each one: the idle/composer/busy gates, the submit verifier,
 * recycleChild's kill+respawn+carry sequence), but if a holder's critical
 * section fails to reach its `finally` release for a reason none of those
 * caps cover, every later gated inject queues behind it silently and
 * forever — this is the ONE unbounded wait in the whole gated-delivery
 * pipeline, and matches a live incident: ~6h of TOTAL SILENCE in a host's
 * event log (zero rows of any kind) spanning 4 stacked wake fires that all
 * reported `delivered` yet started no turn. `acquire()` now races `prev`
 * against a two-stage watchdog: past `warnMs` it fires `onStuck({phase:
 * 'warn', waitedMs})` (loud, side-effect-free — see the wiring at this
 * mutex's construction site for the durable host-event it becomes) while
 * still waiting for `prev`; past `forceReleaseMs` it fires `onStuck({phase:
 * 'force-release', waitedMs})` and lets this acquirer proceed AS IF the
 * wedged holder had released. `prev` itself is never resolved by the
 * watchdog — only THIS waiter stops awaiting it. If the original holder
 * eventually does call its own release(), that resolves a promise nothing
 * awaits any more (every later acquire() chains off THIS waiter's own tail,
 * never off `prev`) — a harmless no-op, never a second wedge. Both windows
 * default far above the slowest legitimate hold (a carry-respawn recycle,
 * ~11min worst case — see the INJECT_MUTEX_WARN_MS doc comment) so a
 * healthy, merely-slow delivery never trips either one. Pure factory
 * (`now`/`onStuck` injected, matching this file's other gate factories);
 * exported for tests. */
export function makeInjectMutex({
  now = Date.now,
  warnMs = INJECT_MUTEX_WARN_MS,
  forceReleaseMs = INJECT_MUTEX_FORCE_RELEASE_MS,
  onStuck = () => {},
} = {}) {
  let tail = Promise.resolve();
  return {
    /** Resolve to a release() fn once the lock is free (FIFO), or once the
     *  watchdog force-releases a wedged holder (see the doc block above).
     *  Caller MUST call the returned release(). */
    async acquire() {
      const prev = tail;
      /** The `resolve` of `tail`, captured synchronously by the executor below.
       *  Annotated, and initialised to the explicit `undefined` that a bare
       *  `let release;` already meant — so this is a ZERO runtime change. It
       *  exists because declaration emit cannot see that a Promise executor
       *  runs synchronously: without it `release` infers as `undefined`, this
       *  method is emitted as `acquire(): Promise<undefined>`, and every
       *  correct `const r = await m.acquire(); r();` caller is a type error
       *  against code that works fine at runtime (17 such errors in
       *  psu-pty-host.test.ts alone, which is what put apps/operator over its
       *  tsc baseline and held the green-checkpoint gate red).
       *  @type {(value?: any) => void} */
      let release = /** @type {any} */ (undefined);
      tail = new Promise((resolve) => {
        release = resolve;
      });
      const waitStartedAt = now();
      await new Promise((resolveAcquire) => {
        let settled = false;
        let warnTimer = null;
        let forceTimer = null;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (warnTimer) clearTimeout(warnTimer);
          if (forceTimer) clearTimeout(forceTimer);
          resolveAcquire();
        };
        prev.then(settle); // the ordinary, unstuck path
        const reportStuck = (phase) => {
          try {
            onStuck({ phase, waitedMs: now() - waitStartedAt });
          } catch {
            /* a diagnostic callback must never itself wedge the mutex */
          }
        };
        // Finite, positive windows only — a disabled/misconfigured watchdog
        // (0/NaN/Infinity) must never spend a real timer on it, and must
        // never change ordinary (unstuck) behavior.
        if (Number.isFinite(warnMs) && warnMs > 0) {
          warnTimer = setTimeout(() => {
            if (settled) return; // prev already resolved between tick and here
            reportStuck('warn');
          }, warnMs);
          warnTimer.unref?.();
        }
        if (Number.isFinite(forceReleaseMs) && forceReleaseMs > 0) {
          forceTimer = setTimeout(() => {
            if (settled) return;
            reportStuck('force-release');
            settle(); // proceed as though the wedged holder had released
          }, forceReleaseMs);
          forceTimer.unref?.();
        }
      });
      return release; // caller releases → frees the next FIFO waiter
    },
  };
}

// ── WI-5510: delivery-side STALE-FIRE GUARD ──────────────────────────────────
//
// Follow-up to EI-15799 (whose fix was cosmetic — renderColdWakeInjection just
// LABELS a cold-wake delivery with its fire number so a receiving agent can
// notice a lag; it explicitly did NOT drop a superseded delivery, and said so
// in its own doc comment). The root cause EI-15799 left open: the FIRE-time
// decision (loop-fire.ts, which computes `fireNumber = priorFires + 1` and
// stamps it on the wake payload) and the DELIVERY-time execution (the control-
// socket connection handler below, an EXTERNAL process from loop-fire.ts's
// point of view) are two separate stages with NO shared state between them.
// A fire can be decided/queued, gate-wait here (the idle + agent-busy gates can
// hold a delivery for minutes), and THEN a LATER fire for the SAME loop is
// decided, wins its own gate race, and delivers FIRST — so when the earlier
// delivery's wait finally clears, writing it flushes a stale, already-
// superseded wake mid-turn into the live session (this is exactly the failure
// EI-15799 was filed against, live-witnessed again during this very fix — see
// WI-5510's repro comment).
//
// makeStaleFireGuard is the shared state loop-fire.ts and the delivery path
// were missing: "the last fire number this host has committed to deliver, per
// loop instance". Keyed by `routineId` (the loop's stable `routines` row id,
// stamped into the wake payload by loop-fire.ts alongside `wakeCount`) rather
// than a bare fire number, so a loop that was `loop:end`ed and later re-armed
// (fire numbers restart at 1) is never mistaken for a stale delivery of the
// OLD loop's higher fire count — a fresh routineId always admits.
export function makeStaleFireGuard() {
  const lastByRoutine = new Map();
  return {
    /**
     * Decide + COMMIT in one call (mirrors makeTurnCoalescer's admit/claim
     * commit-at-delivery style): a message with no `routineId`/`fireNumber`
     * (not a loop-fire wake, or a pre-WI-5510 sender) always admits and never
     * touches the map — this guard is opt-in per-message, not a new
     * requirement on every control-socket write. When both are present,
     * admits (and records `fireNumber` as the new high-water mark) only when
     * `fireNumber` is STRICTLY NEWER than the last one committed for this
     * `routineId`; an equal-or-older fire number is a stale/duplicate
     * delivery and must be DROPPED (admit:false) without updating state.
     */
    admit(routineId, fireNumber) {
      if (routineId == null || fireNumber == null) return { admit: true, lastDelivered: null };
      const lastDelivered = lastByRoutine.get(routineId) ?? 0;
      if (fireNumber <= lastDelivered) return { admit: false, lastDelivered };
      lastByRoutine.set(routineId, fireNumber);
      return { admit: true, lastDelivered };
    },
    /** Live count of distinct loop instances tracked (diagnostics/tests). */
    size() {
      return lastByRoutine.size;
    },
  };
}

/** EI-18109211232286833: is a `carry-respawn` control message too stale to
 *  deliver? `receivedAtMs` is the moment this host first decoded the message
 *  (stamped once in `conn.on('end')`, reused unchanged across the one
 *  `makeCarryRearmController` retry), so this measures TOTAL elapsed wait —
 *  original busy-gate wait plus the re-arm's — not a per-attempt window.
 *  Pure + injectable clock (matches this file's style, e.g. makeStaleFireGuard
 *  above); exported for unit tests. A message with no `receivedAtMs` (a
 *  pre-fix sender, or any non-carry-respawn caller) is never considered stale
 *  — this guard is opt-in per-message, same convention as the stale-fire
 *  guard's opt-in `routineId`/`fireNumber`. */
export function isCarryRespawnStale(receivedAtMs, { maxAgeMs = CARRY_RESPAWN_MAX_AGE_MS, now = Date.now() } = {}) {
  if (receivedAtMs == null) return false;
  return now - receivedAtMs > maxAgeMs;
}

/** EI-18665672258948707: is a `carry-respawn` control message SUPERSEDED — has a
 *  LATER respawn already fired on THIS host since the message first arrived?
 *  Distinct from age-based staleness (isCarryRespawnStale above): the reported
 *  failure was a queued carry-respawn whose CLIENT-side injectIntoHost() write
 *  appeared to time out (a momentarily busy host lost the client's 2s
 *  socket-close race) even though the server had already durably received +
 *  queued the envelope. The calling agent, seeing `ok:false`, retried
 *  session:request-compaction — the second attempt built a FRESH carry document
 *  and delivered promptly, spawning a real successor that went on to do real
 *  work. The FIRST envelope, still gate-waiting (or pending its one
 *  carryRearm retry), was well within the 30-minute staleness cap and so was
 *  delivered anyway 28 minutes later — killing the live, already-progressed
 *  successor and replacing it with a stale snapshot from before that successor
 *  ever existed. A superseded carry-respawn can never be the right one to
 *  deliver, independent of its age, so this check is unconditional (no maxAgeMs
 *  knob) and orthogonal to isCarryRespawnStale — a caller applies BOTH. Pure;
 *  exported for unit tests. */
export function isCarryRespawnSuperseded(receivedAtMs, lastRespawnAtMs) {
  if (receivedAtMs == null || !lastRespawnAtMs) return false;
  return lastRespawnAtMs > receivedAtMs;
}

/** EI-18679681961154136 / EI-18681914950138372: should an incoming control
 *  message be DEFERRED because a carry-respawn is currently in flight for this
 *  host — either awaiting its FIRST delivery attempt's outcome, or a re-armed
 *  RETRY?
 *
 *  makeCarryRearmController's production re-poll loop RELEASES the inject
 *  mutex between busy-gate-defer attempts on purpose (so ordinary wakes are
 *  never wedged waiting on it) — but that same release lets a ready-to-fire
 *  `mode:'turn'` wake win the race for every idle window the rearm loop is
 *  polling for: it opens a fresh turn, the agent goes busy again, and the
 *  rearm's own next attempt misses the window it was waiting for. Repeated
 *  indefinitely (a busy, well-connected agent keeps receiving wakes), the
 *  queued carry-respawn is starved forever — observed + diagnosed end-to-end
 *  on 2026-07-26 (EI-18679681961154136). The original fix covered only the
 *  RETRY phase (`pending`, populated inside `schedule()`) — which starts only
 *  once the FIRST busy-gate wait has already timed out. During that entire
 *  first wait (up to the full busy-gate cap), a wake arriving sailed through
 *  this check unfiltered, queued on the inject mutex BEFORE the eventual
 *  retry did, and won every time (mutex is FIFO) — the same starvation, one
 *  layer earlier (EI-18681914950138372, also 2026-07-26). `pendingRespawnCount`
 *  now covers BOTH phases (see makeCarryRearmController's `inFlight` set +
 *  beginFirstAttempt/endFirstAttempt), closing the gap end-to-end. Only
 *  `mode:'turn'` is deferred here: reset/recycle/mcp-reconnect are explicit
 *  operator/owner actions, not routine wakes, and stay unaffected. The
 *  deferred wake loses nothing — it is already durable mail (coord/loop
 *  redeliver it) and is picked up on the next natural turn, exactly like an
 *  ordinary busy-gate refusal. Pure — exported for tests. */
export function shouldDeferWakeForPendingRespawn(mode, pendingRespawnCount) {
  return mode === 'turn' && pendingRespawnCount > 0;
}

/** The ordered write STEPS the host performs against the pty for a decoded
 *  message. raw → ONE immediate verbatim write (force-interrupt byte). turn →
 *  TWO writes: the line text, then the submit Enter (CR) as a SEPARATE keystroke
 *  `crDelayMs` later — because a single `text + CR` burst is swallowed by the
 *  Claude Code TUI's paste detector (the CR becomes a literal newline and the
 *  turn never submits). Pure — exported for tests. */
export function controlWrites(decoded, crDelayMs = TURN_SUBMIT_CR_DELAY_MS) {
  // raw (force-interrupt byte) and osc (recolor bytes) are both ONE immediate
  // verbatim write — no idle gate, no submit CR.
  if (decoded.mode === 'raw' || decoded.mode === 'osc') return [{ data: decoded.data, delayMs: 0 }];
  return [
    { data: decoded.data, delayMs: 0 },
    { data: '\r', delayMs: crDelayMs },
  ];
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The submit delay is backend-specific because each interactive TUI has its
 *  own paste/compose handling. Keep the wire protocol backend-neutral; the
 *  hosting psu process already knows its child agent via PAPERCUSP_AGENT.
 *  @param {EnvironmentMap} [env]
 */
export function turnSubmitCrDelayForAgent(agent, env = process.env) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') {
    return positiveNumber(env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS, CODEX_TURN_SUBMIT_CR_DELAY_MS);
  }
  return positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS, TURN_SUBMIT_CR_DELAY_MS);
}

function codexTurnResubmitCrDelay(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS, CODEX_TURN_RESUBMIT_CR_DELAY_MS);
}

function ompTurnResubmitCrDelay(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_OMP_RESUBMIT_CR_MS, CODEX_TURN_RESUBMIT_CR_DELAY_MS);
}

/** Backend-aware write plan for an injected turn. Codex and OMP receive one
 *  redundant delayed submit CR because the first CR can be consumed as input,
 *  leaving the turn text visible but unsent. OMP used to receive LF instead of
 *  the terminal Enter byte; a real OMP 16.x session acknowledged the control
 *  write but persisted no user message and produced no transcript at all.
 *  A `reset` (RESET-CONTEXT) is a turn PREFIXED by the backend's context-clear
 *  command (see resetWritesForAgent).
 *  @param {EnvironmentMap} [env]
 */
export function controlWritesForAgent(decoded, agent, env = process.env) {
  if (decoded.mode === 'raw' || decoded.mode === 'osc') return controlWrites(decoded);
  if (decoded.mode === 'reset') return resetWritesForAgent(decoded, agent, env);
  const normalized = String(agent || '').trim().toLowerCase();

  if (normalized === 'omp') {
    const crDelayMs = turnSubmitCrDelayForAgent(agent, env);
    return [
      { data: decoded.data, delayMs: 0 },
      { data: '\r', delayMs: crDelayMs },
      { data: '\r', delayMs: ompTurnResubmitCrDelay(env) },
    ];
  }

  if (normalized !== 'codex') {
    return controlWrites(decoded, turnSubmitCrDelayForAgent(agent, env));
  }
  return [
    { data: decoded.data, delayMs: 0 },
    { data: '\r', delayMs: turnSubmitCrDelayForAgent(agent, env) },
    { data: '\r', delayMs: codexTurnResubmitCrDelay(env) },
  ];
}

/** WI-41386 — the RESPAWN TERMINAL HANDOFF: bytes the HOST writes to its own
 *  stdout (the real terminal) between a dying child and its successor.
 *
 *  WHY. Every recycle puts two CLI processes in one terminal back to back, and
 *  nothing re-anchored the cursor between them. Both primary-buffer backends
 *  draw wherever the cursor happens to be:
 *    - claude renders with the rewind idiom `\r ESC[<N>A` + rewrite, where N is
 *      the live frame height. Killed INSIDE that window — which a mid-turn
 *      SIGHUP usually is — the cursor is left up to a whole frame above the last
 *      drawn row. Its successor's first bytes carry NO newline, NO CUP and NO
 *      ED (measured on a captured stream), so the boot banner lands there and
 *      overwrites the predecessor's final frame: the owner loses the last
 *      screenful of history at every restart (measured ~40-50 lines on
 *      su-4b48f, 2026-08-24).
 *    - codex is the same class and asks the terminal where it is (`ESC[6n`),
 *      so it anchors to exactly the position we leave it at.
 *    - omp is the exception: it runs on the ALTERNATE screen (`?1049h`), so it
 *      never writes the primary scrollback at all and cannot lose it this way.
 *
 *  So the anchor below is written for every backend rather than branching on
 *  one: it is a no-op for a well-behaved child, and it is the only thing that
 *  helps a badly-behaved one. Two parts:
 *
 *  1. RESTORE — undo terminal modes a killed child never got to reset. A
 *     SIGKILLed omp never emits `?1049l`, stranding the terminal on the
 *     alternate screen where the successor then paints invisibly; a child
 *     killed mid-frame can leave the cursor hidden, SGR mid-colour, mouse
 *     reporting on (which makes the terminal spew on every mouse move), or a
 *     scroll region set. Each reset is idempotent, so this costs nothing when
 *     the predecessor exited cleanly.
 *  2. ANCHOR — park on the LAST screen row and emit CRLF. That forces a scroll
 *     rather than an overwrite: whatever the predecessor drew moves up into
 *     scrollback intact, and the successor is guaranteed a virgin line. This is
 *     the half that fixes the history loss, and it is deliberately expressed in
 *     terminal primitives rather than in anything the CLIs do, so it cannot rot
 *     against a backend version bump.
 *
 *  NEVER use `ESC c` (RIS) here — a full reset ERASES scrollback, which is the
 *  very thing this exists to preserve.
 *
 *  Pure — exported for tests.
 *  @param {{ rows?: number, separator?: boolean }} [opts]
 *  @returns {string} the bytes to write, or '' when disabled
 */
export function respawnTerminalHandoffBytes({ rows, separator = true } = {}) {
  const lastRow = Number.isFinite(rows) && rows >= 2 ? Math.floor(rows) : null;
  const restore =
    '\x1b[?1049l' + // leave the alternate screen if a dead child stranded us there
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse reporting off
    '\x1b[?2004l' + // bracketed paste off
    '\x1b[?7h' + // autowrap back on
    '\x1b[r' + // full-height scroll region
    '\x1b[0m' + // SGR reset — no inherited colour/bold
    '\x1b[?25h'; // cursor visible
  // Without a known height, a bare CRLF still guarantees a fresh line; the
  // absolute park is what additionally protects rows BELOW a mid-frame cursor.
  const anchor = (lastRow ? `\x1b[${lastRow};1H` : '') + '\r\n';
  const marker = separator ? '\x1b[2m── session restarted ──\x1b[0m\r\n' : '';
  return restore + anchor + marker;
}

/** The in-place context-clear command for a backend (su-cold-auto-mode P-004a).
 *  RESET-CONTEXT drops the grown transcript while keeping the process + MCP
 *  connections warm — the cheap per-wake cold path. Each interactive CLI exposes
 *  this as a slash command: Claude Code / OMP `/clear`; Codex starts a fresh
 *  conversation with `/new`. Pure — exported for tests. */
export function contextClearCommandForAgent(agent) {
  const normalized = String(agent || '').trim().toLowerCase();
  if (normalized === 'codex') return '/new';
  return '/clear';
}

/** Backend-aware cold-reset delivery. Claude and OMP can clear their context in
 * place, but Codex's `/new` command only changes the visible TUI state; the
 * long-lived Codex process still retains the context that the cold boundary is
 * meant to discard. Route Codex reset envelopes through the existing hard
 * recycle path so a fresh child process is guaranteed. Pure — exported for
 * tests. */
export function coldResetModeForAgent(agent) {
  const normalized = String(agent || '').trim().toLowerCase();
  return normalized === 'codex' ? 'recycle' : 'reset';
}

/** The RESET-CONTEXT settle window (repaint budget after the clear submits).
 *  Session-env tunable, module default as fallback.
 *  @param {EnvironmentMap} [env]
 */
export function clearSettleMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS, CLEAR_SETTLE_MS);
}

/** The submit-verifier's OWN "is a turn genuinely running" quiet threshold
 *  (WI-2975) — deliberately independent of OUTPUT_QUIET_MS (the busy-gate's
 *  short "back at an idle prompt" threshold; see SUBMIT_VERIFY_QUIET_MS above
 *  for the false-positive this decoupling fixes). Session-env tunable, module
 *  default as fallback. Pure — exported for tests.
 *  @param {EnvironmentMap} [env]
 */
export function submitVerifyQuietMs(env = process.env) {
  return positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS, SUBMIT_VERIFY_QUIET_MS);
}

/** Absolute path to the session-compacted emit CLI (a sibling script, built by the
 *  event-await-discoverability plan / P-103). The host resolves it relative to itself so
 *  the same path works from the staging AND release checkouts. */
export const SESSION_COMPACTED_EMIT_ENTRY = join(HOST_SCRIPT_DIR, 'emit-session-compacted.ts');

/**
 * Fire the server-side `session:compacted:<owner>` event (event-await-discoverability
 * P-103) after a server-requested compaction COMPLETES, so a peer can
 * `events:await { event: "session:compacted:<owner>" }` instead of polling.
 *
 * THE BRIDGE: this host is a deliberately-minimal standalone process — it has NO PG pool
 * and NO operator HTTP client (see the imports: node fs/net/pty only), so it CANNOT emit
 * the event in-process. Instead it spawns a short-lived DETACHED `tsx` CLI
 * (SESSION_COMPACTED_EMIT_ENTRY) that DOES reach org-PG — the connection resolves via
 * ~/.papercusp/embedded-pg.json (or the native :5432 fallback), independent of this host's
 * env, so the CLI needs no DATABASE_URL handed to it. Compaction is rare, so the tsx
 * cold-start cost is acceptable.
 *
 * `opts.nativeId` is the exact successor native session this completed cut
 * spawned. The detached CLI uses it to refuse a context-estimate refresh while
 * the owner mapping still points at the predecessor (EI-21567375926533125).
 *
 * FAIL-SOFT + fire-and-forget: if the entry does not exist yet (CLI not landed), or tsx /
 * PG fail, nothing touches the live session. Only the CALLER's real-completion path invokes
 * this (never the done.deferred drop). Pure side-effect; returns the spawned child or null.
 */
export function fireSessionCompactedEvent(ownerId, focus, opts = {}) {
  const entry = opts.entry ?? SESSION_COMPACTED_EMIT_ENTRY;
  const spawnFn = opts.spawnFn ?? spawn;
  const exists = opts.existsFn ?? existsSync;
  if (!ownerId) return null;
  // Don't spawn a doomed process before the CLI has landed — a missing entry is the
  // expected state until the event-await plan's P-103 CLI ships.
  if (!exists(entry)) return null;
  try {
    const child = spawnFn(
      'npx',
      ['tsx', entry, String(ownerId), String(focus ?? ''), String(opts.nativeId ?? '')],
      {
        cwd: join(HOST_SCRIPT_DIR, '..', '..', '..'), // checkout root — where npx finds tsx
        env: process.env,
        detached: true,
        stdio: 'ignore',
      },
    );
    // A spawn error (npx/tsx missing) must never surface into the session.
    child.on?.('error', () => {});
    child.unref?.();
    return child;
  } catch {
    return null; // best-effort — the awaiter falls back to its own timeout / next signal
  }
}

/** The ordered write STEPS for a RESET-CONTEXT (su-cold-auto-mode P-004a): submit
 *  the backend's context-clear command, wait `clearSettleMs` for the TUI to
 *  repaint a fresh prompt, then type + submit the carry-note as the opening turn
 *  of the fresh context (the SAME per-agent paste-safe turn plan, its first write
 *  delayed by the settle). An empty carry ⇒ a bare clear (no opening turn). Pure —
 *  exported for tests.
 *  @param {EnvironmentMap} [env]
 */
export function resetWritesForAgent(decoded, agent, env = process.env) {
  const clearCmd = contextClearCommandForAgent(agent);
  const steps = [
    { data: clearCmd, delayMs: 0 },
    { data: '\r', delayMs: turnSubmitCrDelayForAgent(agent, env) },
  ];
  if (!decoded.data) return steps; // bare clear — no carry turn to open on
  // The carry turn reuses the normal per-agent turn plan; its FIRST write waits
  // for the clear to settle so the text lands on the fresh prompt, not mid-clear.
  const turnPlan = controlWritesForAgent({ mode: 'turn', data: decoded.data }, agent, env);
  turnPlan[0] = { ...turnPlan[0], delayMs: clearSettleMs(env) };
  steps.push(...turnPlan);
  return steps;
}

/**
 * The OSC recolor bytes for a fleet-bound session, from the PAPERCUSP_FLEET_BG /
 * PAPERCUSP_FLEET_FG / PAPERCUSP_FLEET_CURSOR env vars bootstrap-su resolves from
 * the fleet's bound scheme — or null when the session has no fleet (leave the
 * terminal's profile default untouched). OSC 10 (fg) / 11 (bg) / 12 (cursor),
 * each BEL-terminated. This is the launch-time twin of operator-core
 * console-color-schemes.oscRecolorSequence (the runtime fleet:join path emits the
 * same bytes over the 'osc' control mode); inlined here so this plain-mjs host
 * needs no cross-package import — keep the OSC format in lockstep. Pure;
 * exported for tests + psu-launcher's no-pty fallback.
 * @param {EnvironmentMap} [env]
 */
export function fleetOscFromEnv(env = process.env) {
  const bg = env.PAPERCUSP_FLEET_BG;
  if (!bg) return null;
  const fg = env.PAPERCUSP_FLEET_FG;
  const cursor = env.PAPERCUSP_FLEET_CURSOR;
  let s = '';
  if (fg) s += `\x1b]10;${fg}\x07`;
  s += `\x1b]11;${bg}\x07`;
  if (cursor) s += `\x1b]12;${cursor}\x07`;
  return s;
}

/**
 * Connect to a live host's control socket and inject `text` as a submitted turn
 * (idle-gated). Used by tooling/tests; the OPERATOR's wake-executor implements
 * its own connect (it's TS in operator-core) to the SAME contract. Resolves true
 * on a clean write, false on connect error.
 *
 * WI-2141436 hole #1: this had NO ownerId param at all — an envelope-less write
 * with no addressed-recipient assertion, so the receiver's EI-153 misdelivery
 * guard (decodeOwnerIdentity / the `msg.ownerId !== ownerId` check) silently
 * no-ops for every call. Currently dead-code-shaped (no production caller), but
 * it is an exported path, so it gets the same identity binding as every other
 * writer: pass the TARGET session's ownerId and it rides in the envelope,
 * exactly like injectKickoffAfterResume's `{ mode:'turn', data, ownerId }`.
 * `ownerId` is optional only so an unaddressed legacy call still no-ops instead
 * of throwing — always pass it from a real caller.
 * @param {string} sock
 * @param {string} text
 * @param {string} [ownerId] the target session's coord ownerId (PAPERCUSP_SID) —
 *   checked by the receiving host against its own identity before it acts.
 */
export function injectTurn(sock, text, ownerId) {
  return new Promise((resolve) => {
    const c = net.connect(sock, () => {
      c.write(encodeControl({ mode: 'turn', data: text, ...(ownerId ? { ownerId } : {}) }));
      c.end();
    });
    c.on('error', () => resolve(false));
    c.on('close', () => resolve(true));
  });
}

/**
 * Host `command args` through a managed pty, bridging the user's TTY and
 * exposing the control socket. Returns a Promise that resolves with the child's
 * exit code (the caller maps that to its own exit). The pty + socket live in
 * THIS process (D-006).
 *
 * @param {object} o
 * @param {string} o.command            binary to launch (the *-su wrapper / raw CLI)
 * @param {string[]} [o.args]           its args
 * @param {string} [o.cwd]              launch dir
 * @param {EnvironmentMap} [o.env]      child env (must carry PAPERCUSP_SID = ownerId)
 * @param {string} o.ownerId            coord ownerId (PAPERCUSP_SID) — the discovery key
 * @param {number|string} [o.advSessionId]  adv_sessions row id, when known
 * @param {{stdin?: any, stdout?: any}} [o.io] { stdin, stdout } override (tests); default process.*
 * @param {(code:number, killedBySignal:string|null)=>void} [o.onExit]  exit handler;
 *   default process.exit. `killedBySignal` is the signal NAME when the child was killed
 *   (WI-38054) and null on a voluntary exit — it is the only thing distinguishing the
 *   two, because node-pty reports a signal death with exitCode 0.
 * @param {()=>any} [o.onSpawn] lifecycle callback invoked immediately after
 *   the initial pty.spawn succeeds; this is concrete resume-finalization evidence.
 * @param {boolean} [o.bridgeTty]       force the TTY bridge on/off; default = stdin.isTTY
 * @param {string | null} [o.kickoff]   first-turn text for a scripted launch
 * @param {string} [o.kickoffFile]      server-owned session-port seed (never a CLI arg)
 * @param {{renderedHash?: string}} [o.sessionPort] { renderedHash } for the managed seed
 * @param {(proof:any)=>Promise<void>} [o.onKickoffPersisted] lifecycle acknowledgement
 * @param {object} [o.signalSource]      process-like on/off signal source (tests)
 * @param {()=>object} [o.reapScopeResidue] exact-session-cgroup cleanup (tests)
 * @param {string} [o.normalizedLogPath] optional headless grep-safe log path; normally
 *   supplied through {@link HEADLESS_NORMALIZED_LOG_ENV} in `o.env`
 * @param {(args:string[])=>any} [o.mintRecycleArgs] mint argv for an ordinary recycle
 * @param {(args:string[])=>any} [o.mintCarryRespawnArgs] mint argv for a carry respawn
 * @param {()=>Promise<any>} [o.refreshPersonaFile] refresh the rendered persona before respawn
 * @param {(...args:any[])=>any} [o.onRespawn] lifecycle callback after a respawn
 * @param {((...args:any[])=>any) | null} [o.onReexec] handoff callback for host re-exec
 * @param {()=>any} [o.hostCodeStalenessFn] injectable loaded-vs-disk probe
 * @param {()=>number} [o.parentPidFn] injectable parent-pid probe
 * @param {number} [o.activityPersistMs] discovery activity refresh interval
 * @param {number} [o.nativePersistenceTimeoutMs] managed kickoff persistence deadline
 */
export function hostThroughPty(o) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    ownerId,
    advSessionId = null,
    // WI-1980: injected by the launcher so the host stays launcher-agnostic
    // (launcher imports host → importing back would cycle). `mintRecycleArgs`
    // rewrites the argv for a RECYCLE respawn (fresh --session-id); `onRespawn`
    // re-anchors that fresh native id → coord ownerId. Defaults keep the
    // standalone host + existing tests behavior-identical (same args, no anchor).
    mintRecycleArgs = (a) => ({ args: a, nativeId: null }),
    mintCarryRespawnArgs = (a) => mintRecycleArgs(a),
    // stale-prompt-render-in-live-sessions-2026-08-02 P-002: re-render this
    // session's base persona from CURRENT prompt sources before a respawn mints the
    // successor's argv. Injected by the launcher (which owns the operator call) for
    // the same reason as the mints — the host must stay launcher-agnostic. The
    // default returns no file, which reproduces the pre-fix behaviour exactly: the
    // successor inherits the predecessor's rendered prompt.
    refreshPersonaFile = async () => ({
      promptFile: null,
      reason: "not-wired",
    }),
    onRespawn = () => {},
    // WI-38292: hand the session to a FRESH launcher process instead of respawning
    // the CLI child inside this stale one. Injected like the mints, and for a
    // second reason beyond launcher-agnosticism: only the launcher knows whether
    // anything will re-run it (the psu shim's re-exec loop advertises itself in
    // env) and only the launcher owns the supervisor beat it must stop first.
    // null ⇒ adoption is unavailable and every respawn takes the in-process path,
    // which is the pre-WI-38292 behaviour exactly.
    onReexec = null,
    // WI-38292: injectable staleness probe, same role as parentPidFn above. The
    // real one compares this module's load-time hash against the file on disk, so
    // a test running the module it is testing can NEVER observe staleness without
    // rewriting the shared checkout mid-run — which git-sync would sweep into a
    // commit. Injecting it is what makes the adopting path testable at all.
    hostCodeStalenessFn = hostCodeStaleness,
    // WI-3141: injectable parent-pid probe for the orphan watchdog, so a test can
    // drive a fake reparent-to-init without a real fork. Defaults to the live ppid.
    parentPidFn = () => process.ppid,
    // WI-3455: injectable activity/self-heal tick period so tests can exercise
    // the discovery re-assert without waiting the real 15s cadence.
    activityPersistMs = ACTIVITY_PERSIST_MS,
    // agent-launch-resume-primitives P-011/D-008: the first-turn text to inject
    // once the child settles at its prompt. Set by the launcher for a SCRIPTED
    // resume/fork (the fresh-launch path seeds its kickoff as a CLI positional
    // instead). null ⇒ the session opens idle, exactly as before.
    kickoff = null,
    kickoffFile = null,
    sessionPort = null,
    onKickoffPersisted = async () => {},
    onSpawn = () => {},
    nativePersistenceTimeoutMs = Number(
      env.PAPERCUSP_SESSION_PORT_PERSIST_TIMEOUT_MS,
    ) || 30_000,
    signalSource = process,
    reapScopeResidue = reapDetachedPtyScopeResidue,
  } = o;
  if (kickoff && kickoffFile) throw new Error('plain kickoff and managed kickoff file are mutually exclusive');
  const managedKickoff = kickoffFile
    ? (() => {
        const read = readManagedKickoffFile(kickoffFile, sessionPort?.renderedHash);
        return { ...read, text: tagSessionPortTurn(read.text, ownerId, env) };
      })()
    : null;
  const nativeCaptureAfterMs = Date.now();
  let managedKickoffDisposition = null;
  const acknowledgeManagedKickoff = (proof) => {
    if (!managedKickoff) return Promise.resolve();
    if (!managedKickoffDisposition) {
      // First terminal outcome wins. Child exit and persistence verification can
      // race; sharing one promise prevents delivered→failed double transitions.
      managedKickoffDisposition = Promise.resolve().then(() => onKickoffPersisted(proof));
    }
    return managedKickoffDisposition;
  };
  // WI-38292: the exit code that hands this session to a fresh launcher, or null
  // when nothing would re-run us. Read from `env` (the launch environment the
  // shim exported into), never assumed — see reexecExitCodeFrom.
  const reexecCode = reexecExitCodeFrom(env);
  const stdin = o.io?.stdin ?? process.stdin;
  const stdout = o.io?.stdout ?? process.stdout;
  const onExit = o.onExit ?? ((code) => process.exit(code ?? 0));
  const bridgeTty = o.bridgeTty ?? !!(stdin.isTTY && typeof stdin.setRawMode === 'function');
  const normalizedLogPath =
    String(o.normalizedLogPath ?? env[HEADLESS_NORMALIZED_LOG_ENV] ?? '').trim() || null;
  const normalizedLog = normalizedLogPath
    ? createHeadlessNormalizedLogWriter(normalizedLogPath)
    : null;

  let pty;
  try {
    pty = require('@lydell/node-pty');
  } catch (e) {
    process.stderr.write(
      `psu: failed to load @lydell/node-pty (${e.message}); falling back to a plain launch is the caller's job.\n`,
    );
    throw e;
  }

  ensureDir();
  pruneDead();
  const sock = socketPathFor(ownerId);
  const metaPath = metaPathFor(ownerId);
  // A stale socket from a crashed prior session of the SAME owner would block
  // bind; remove it (pruneDead already cleared dead ones, but be defensive).
  // WI-3455: but never SILENTLY — if the prior key holder is STILL a live psu
  // host (a resume of a live session, an env-inherited SID), taking the key
  // strands that session's injection path (wake / turn:interrupt / /compact →
  // no_live_pty_host, the 2026-07-08 su-a8f52 stranding). The launcher's
  // resume-of-live guard refuses the common case up front; if we still get
  // here, say so loudly — and the older host's self-heal tick reclaims the key
  // once this host ends, so the takeover is convergent, not permanent.
  const priorMeta = readDiscoveryMeta(ownerId);
  if (
    priorMeta &&
    priorMeta.pid &&
    priorMeta.pid !== process.pid &&
    pidAlive(priorMeta.pid) &&
    pidLooksLikePsuHost(priorMeta.pid)
  ) {
    process.stderr.write(
      `psu: ⚠ another LIVE psu host already serves ${ownerId} (pid ${priorMeta.pid}) — ` +
        `taking over its discovery key; that session keeps running but cannot receive ` +
        `wakes//compact injection until this one ends (it self-heals afterwards).\n`,
    );
  }
  for (const p of [sock]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  const ptyName = env.TERM || process.env.TERM || 'xterm-256color';
  // WI-3278: the WSL console bridge can report a BOGUS terminal size (131072x1
  // seen live on the Windows VM) — a 1-row pty makes the claude TUI misbehave
  // (fullscreen-switch re-exec). Out-of-range dims fall back to the default.
  const sanePtyDim = (v, fallback, max) =>
    Number.isFinite(v) && v >= 2 && v <= max ? v : fallback;
  /** Spawn the child agent under a fresh pty in THIS host. Reused on RECYCLE
   *  (su-cold-auto-mode P-004b): same command/args/cwd/env means PAPERCUSP_SID,
   *  locks, hooks, and the control socket all survive — only the process is new.
   *  Reads the CURRENT terminal size each spawn. */
  const spawnChild = (spawnArgs = args) =>
    pty.spawn(command, spawnArgs, {
      name: ptyName,
      cols: sanePtyDim(stdout.columns, 80, 1000),
      rows: sanePtyDim(stdout.rows, 24, 500),
      cwd,
      env,
    });
  let child;
  try {
    child = spawnChild();
  } catch (e) {
    process.stderr.write(`psu: failed to spawn '${command}' under a pty: ${e.message}\n`);
    throw e;
  }
  try {
    const acknowledgement = onSpawn();
    void Promise.resolve(acknowledgement).catch((error) => {
      process.stderr.write(
        `psu: child spawned under pty, but its resume finalization report failed: ${error?.message ?? error}\n`,
      );
    });
  } catch (error) {
    process.stderr.write(
      `psu: child spawned under pty, but its resume finalization callback failed: ${error?.message ?? error}\n`,
    );
  }
  // RECYCLE state (su-cold-auto-mode P-004b). `recycling` guards the child-exit
  // handler so an intended kill+respawn does NOT tear the host down. The three
  // fns are (re)assigned below — declared here so the control-socket handler
  // (created before the teardown Promise) can close over them; they stay no-ops
  // until assigned, and a recycle cannot arrive before the socket is listening.
  let recycling = false;
  // WI-6638 SHUTDOWN state: set once a shutdown is accepted, so a duplicate/retried
  // request is an idempotent ok instead of a second kill. Unlike `recycling` this is
  // terminal — nothing clears it, because the host is on its way out.
  let shuttingDown = false;
  // EI-18665672258948707: the moment (Date.now()) THIS host last successfully
  // spawned a fresh child via recycleChild — the supersession clock a queued
  // carry-respawn is checked against right before delivery (isCarryRespawnSuperseded).
  // 0 = never respawned yet, so nothing can be superseded.
  let lastRespawnAtMs = 0;
  let wireChildData = () => {};
  let wireChildExit = () => {};
  let recycleChild = async () => {};
  // WI-41044: submit verification is created per injected turn, but exhaustion
  // is terminal for this host. Keep the guard at host scope so a detached
  // verifier cannot let later injections create another unbounded CR window.
  let submitVerifyExhausted = false;
  let terminateSubmitVerifyExhaustion = () => false;

  // Output taps (mcp-transport-resilience P-003): live subscribers to the
  // child's raw output bytes — the mcp-reconnect macro reads the TUI screen
  // through one. Fed by wireChildData below (so a tap survives a RECYCLE's
  // re-wire); a tap's lifetime is its caller's (add → close), and a throwing
  // tap can never break the stdout bridge.
  const outputTaps = new Set();
  const makeOutputTap = (capBytes = 65_536) => {
    let buf = '';
    const fn = (d) => {
      buf += d;
      if (buf.length > capBytes) buf = buf.slice(-(capBytes >> 1));
    };
    outputTaps.add(fn);
    return {
      read: () => buf,
      reset: () => {
        buf = '';
      },
      close: () => outputTaps.delete(fn),
    };
  };

  // P-006: activity annotation rides the SAME discovery file — additive
  // fields only (the read-side contract in operator-core psu-pty-discovery.ts
  // tolerates their absence for files written by older hosts).
  const activity = makeActivityTracker();
  // Only actual owner input advances this epoch; terminal capability replies
  // cannot invalidate an untouched successor's first-prompt readiness.
  let ownerInputGeneration = 0;
  // WI-1386682 (1): quota-wall detector, fed the same raw bytes as `activity`
  // (wireChildData below). A stable object with its own reset() — unlike
  // childStartupOutput/childStartupReady this is not reassigned per recycle,
  // just reset in place at the same recycle site.
  // WI-2140984: scoped to THIS child's agent — the banner patterns are
  // per-product, and matching claude's copy against a codex pty read healthy
  // members as permanently walled.
  const quotaBlockDetector = makeQuotaBlockDetector({
    agent: env.PAPERCUSP_AGENT,
    // EI-22609012864215464 / EI-22800121604015331: both native resume and
    // fork repaint the source transcript's old quota errors. Do not block the
    // first new submission on that replay; subsequent errors still block wakes.
    deferUntilSubmit: env.PAPERCUSP_AGENT === 'codex' &&
      args.some((arg) => arg === 'resume' || arg === 'fork'),
  });
  const quotaBlockStarvationGuard = makeQuotaBlockStarvationGuard({
    thresholdMs: positiveNumber(
      env.PAPERCUSP_PSU_PTY_QUOTA_STARVATION_MS,
      QUOTA_BLOCK_STARVATION_THRESHOLD_MS,
    ),
    onStarvation: (signal) => {
      const extra = {
        ...signal,
        agent: String(env.PAPERCUSP_AGENT ?? '') || null,
      };
      appendHostEvent(ownerId, 'quota-block-starvation', extra);
      try {
        process.stderr.write(
          `psu-pty-host: QUOTA BLOCK STARVATION for ${ownerId} — ` +
            `${signal.ageMs}ms blocked with ${signal.attemptedGatedInjections} gated ` +
            `injection attempt(s) and zero successful deliveries; health signal recorded\n`,
        );
      } catch {
        /* diagnostics must never break delivery */
      }
    },
  });
  const observeQuotaBlockStarvation = (gatedInjection = null) => {
    const snapshot = quotaBlockDetector.snapshot();
    return quotaBlockStarvationGuard.observe({
      quotaBlocked: snapshot.quotaBlocked,
      observedBlockedSinceMs: snapshot.quotaBlockedSinceMs,
      gatedInjection,
    });
  };
  // Output-quiet alone is not a startup-ready signal: before a backend-owned
  // marker, terminal probes can read as "quiet at prompt" even though a slow
  // TUI has not installed its editor yet (live Codex/OMP ports WI-4943/WI-4947).
  // Reset on recycle.
  let childStartupOutput = '';
  let childStartupReady = false;
  let childStartupFirstOutputAt = 0;
  let headlessClaudeOnboardingExpiryTimer = null;
  // A scripted resume/fork kickoff is the only path that can encounter Claude's
  // interactive "Autocompact is thrashing" recovery menu. Keep this detector
  // alive before wireChildData() attaches the first listener so the menu cannot
  // win a race against injectTurnAtPrompt(). Fresh launches seed their first
  // turn as a CLI positional argument and do not pass through this gate.
  const launchKickoff = managedKickoff?.text ?? kickoff;
  const claudeResumeCompactionEnabled =
    Boolean(launchKickoff) && String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase() === 'claude';
  const claudeResumeCompaction = makeClaudeResumeCompactionRecoveryStateMachine({
    enabled: claudeResumeCompactionEnabled,
    startupMs: claudeResumeCompactionStartupMs(env),
    recoveryMs: claudeResumeCompactionRecoveryMs(env),
  });
  let claudeResumeCompactionTimeoutReported = false;
  const reportClaudeResumeCompactionTimeout = () => {
    if (claudeResumeCompactionTimeoutReported) return;
    claudeResumeCompactionTimeoutReported = true;
    appendHostEvent(ownerId, 'claude-resume-compaction-timed-out', {
      recoveryMs: claudeResumeCompactionRecoveryMs(env),
    });
    try {
      process.stderr.write(
        `psu-pty-host: Claude resume compaction recovery timed out for ${ownerId}; ` +
          `the scripted kickoff will be dropped rather than written into an unresolved menu.\n`,
      );
    } catch {
      /* diagnostics are best-effort */
    }
  };
  const baseMeta = {
    ownerId,
    advSessionId: advSessionId != null ? String(advSessionId) : null,
    pid: process.pid,
    ptyPid: child.pid,
    sock,
    command,
    args,
    startedAt: Date.now(),
    // Interactive-vs-headless advertisement (deterministic-context-carry P-021;
    // ADDITIVE — absent on files written by older hosts). `bridgeTty:false` = a
    // headless/piped host (no human TTY bridged) — the only value that classifies
    // the session 'claude-headless'; absent/true fail-soft to 'claude-interactive'
    // (psu-pty-discovery.sessionClassForHost) — the SAFE direction, since the
    // interactive class additionally requires the no-recent-human-input guard
    // before any cold-by-default wake.
    bridgeTty,
    // Control-socket capabilities beyond the v1 base set (WI-1804). The operator reads
    // this (psu-pty-discovery.hostSupports) to decide whether to send mode:'compact'
    // (post-compaction auto-continuation) or fall back to a plain /compact turn on an
    // older host that has no `caps` field. Additive — grow this as new modes land.
    // 'mcp-reconnect' (P-003, 2026-07-13): the in-place /mcp dialog heal; an old
    // host without it makes the watchdog fall back to notify-only.
    // P-022: 'compact' is no longer advertised — a pre-cutover sender that
    // caps-gates on hostSupports(host, 'compact') now skips cleanly instead of
    // sending a message the handler will loudly drop.
    // 'shutdown' (WI-6638): wind down + exit, closing this session's terminal tab.
    // 'quota-recovery' (measured-agent-productivity P-004): the operator may
    // convert one durable, headless account:auto wake into the existing recycle
    // path and then verify pickup by delivery id. Older hosts lack the cap and
    // therefore retain the old defer-only behavior.
    caps: ['carry-respawn', 'mcp-reconnect', 'shutdown', 'quota-recovery'],
    // WI-6638: WHO launched this session — `injectLaunchedByArg` (agent-launch-core)
    // stamps `--launched-by=<caller ownerId>` onto every tool-driven psu launch, and
    // bootstrap-su re-exports it as PAPERCUSP_LAUNCHED_BY. An owner-typed `psu` never
    // carries one, which is what makes this a STRUCTURAL agent-vs-human discriminator
    // rather than a heuristic. Advertised so a would-be shutdown requester can see the
    // verdict BEFORE sending (the host re-checks it authoritatively either way).
    // ADDITIVE — absent on files written by older hosts; consumers must fail-soft to
    // "human-launched" (the refusing direction).
    launchedBy: String(env.PAPERCUSP_LAUNCHED_BY || '').trim() || null,
    // WI-38292: WHICH psu-pty-host BUILD this live host is running — the sha256 of
    // the module source as loaded, frozen at import. A carry-respawn replaces only
    // the CLI child, so a host that booted before a fix keeps executing the old code
    // indefinitely; without this field there is no way to ask a RUNNING session
    // whether it carries a given fix, and a correctly-shipped fix looks broken
    // instead of merely un-adopted. Advertised here because discovery is already the
    // host's public record, so every reader gets the answer without a new channel.
    // ADDITIVE — absent on files written by older hosts; consumers must fail-soft to
    // "unknown version", never to "up to date".
    hostCodeVersion: LOADED_HOST_CODE_VERSION,
  };
  const writeMeta = () => {
    try {
      // WI-3455: ATOMIC (tmp + rename). A plain in-place writeFileSync gives a
      // reader a window on a truncated/partial document — and the operator-side
      // janitor (pruneDeadDiscoveryFiles) DELETES a file it reads as corrupt,
      // i.e. a lost race here used to cost a LIVE host its discovery key.
      // rename(2) on the same fs is atomic, so readers only ever see a complete
      // json. The tmp name is pid-scoped so two hosts racing the same key never
      // corrupt each other's staging file.
      const tmp = `${metaPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...baseMeta, ...activity.snapshot(), ...quotaBlockDetector.snapshot() }));
      renameSync(tmp, metaPath);
    } catch {
      /* best-effort — discovery degrades to the base contract */
    }
  };
  writeMeta();
  // Fleet color at launch (fleet-color-schemes): if bootstrap-su bound this
  // session to a fleet (PAPERCUSP_FLEET_BG/FG/CURSOR from the fleet's scheme),
  // recolor THIS window now by writing the OSC straight to our stdout (= the
  // visible terminal), so the window opens in the fleet color instead of the
  // gnome profile default. No fleet ⇒ no write (profile default stands). The
  // runtime fleet:join path reuses the same bytes via the 'osc' control mode.
  const launchOsc = fleetOscFromEnv(env);
  if (launchOsc) {
    try {
      stdout.write(launchOsc);
    } catch {
      /* best-effort — a recolor must never break the session */
    }
  }
  let lastPersisted = 0;
  // WI-3455 SELF-HEAL: the discovery key (json + sock) can be deleted out from
  // under a LIVE host — a duplicate same-owner host's boot/exit, the operator
  // janitor pruning a file it mis-read mid-write, a manual rm. Instead of
  // guarding every possible deleter, each tick re-asserts the invariant "a live
  // host is discoverable": if the json no longer records THIS pid (missing /
  // corrupt / pointing at a DEAD or non-psu pid) rewrite it; if the sock path
  // vanished from disk (we'd still be listening on the unlinked inode —
  // unreachable) re-bind it. ONE exception prevents key flapping: when the json
  // points at a DIFFERENT pid that is a genuinely LIVE psu host, that newer
  // host owns the key — stand down (persist nothing) until it dies, then
  // reclaim. Returns whether WE currently own the key, which also gates the
  // ordinary activity persist below (pre-WI-3455 an old host's activity write
  // would silently trample a live successor's registration).
  let rebindControlSocket = () => {}; // assigned after the server exists below
  let lastHealNoticeAt = 0;
  const selfHealTick = () => {
    const m = readDiscoveryMeta(ownerId);
    if (m && m.pid && m.pid !== process.pid && pidAlive(m.pid) && pidLooksLikePsuHost(m.pid)) {
      return false; // a newer LIVE host owns the key — stand down, don't fight
    }
    const metaMine = !!(m && m.pid === process.pid);
    const sockOnDisk = existsSync(sock);
    if (metaMine && sockOnDisk) return true;
    writeMeta();
    if (!sockOnDisk) rebindControlSocket();
    const now = Date.now();
    if (now - lastHealNoticeAt > 60_000) {
      lastHealNoticeAt = now;
      try {
        process.stderr.write(
          `psu-pty-host: discovery re-asserted for ${ownerId} ` +
            `(json ${metaMine ? 'ok' : 'rewritten'}, sock ${sockOnDisk ? 'ok' : 'rebound'}) — ` +
            `it was removed while this host was live\n`,
        );
      } catch {
        /* never let a diagnostic write break the host */
      }
    }
    return true;
  };
  const activityTimer = setInterval(() => {
    let ownKey = true;
    try {
      ownKey = selfHealTick();
    } catch {
      /* self-heal is best-effort — never break the activity persist */
    }
    const snap = activity.snapshot();
    if (ownKey && (snap.lastActivityAt ?? 0) > lastPersisted) {
      lastPersisted = snap.lastActivityAt ?? 0;
      writeMeta();
    }
  }, activityPersistMs);
  if (typeof activityTimer.unref === 'function') activityTimer.unref();

  const idleGate = makeIdleGate();
  // A quiet terminal line can still contain unsubmitted owner text. Keep that
  // state separate from the mid-keystroke clock so a wake never appends its
  // provenance envelope to a staged human line.
  const ownerComposerGate = makeOwnerComposerGate({
    capMs: positiveNumber(env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS, DEFAULT_IDLE_WAIT_CAP_MS),
  });
  // Separate scanner over the SAME stdin stream (WI-38156). It must be fed every
  // chunk unconditionally — including while a machine turn queues owner input —
  // so its escape state machine stays in step with the real byte stream; a
  // classifier that misses chunks mis-reads the tail of a split reply as text.
  const ownerInputDetector = makeOwnerInputDetector();

  const wedgeDetector = makeComposerWedgeDetector({
    minDefers: positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_MIN_DEFERS, 3),
    minQuietMs: positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_QUIET_MS, 5 * 60_000),
  });
  const noteOwnerInputDefer = (pendingLength) => {
    const wedge = wedgeDetector.note({
      pendingLength,
      ownerQuietMs: ownerComposerGate.ownerQuietMs(),
      pendingAgeMs: ownerComposerGate.pendingAgeMs(),
    });
    if (!wedge) return;
    appendHostEvent(ownerId, 'owner-composer-wedge-suspected', wedge);
    try {
      process.stderr.write(
        `psu-pty-host: COMPOSER WEDGE SUSPECTED for ${ownerId} — ${wedge.consecutiveDefers} consecutive ` +
          `wake deferrals against an unchanged ${pendingLength}-char staged line, ` +
          `${
            wedge.ownerBytesEverSeen
              ? `idle ${Math.round(wedge.ownerQuietMs / 1000)}s`
              : 'and NO owner keystroke has ever been seen here'
          }. ` +
          `This agent is NOT receiving wakes. If nobody is typing in this window it is a phantom ` +
          `staged line (WI-38156) — press Ctrl-U here to clear it.\n`,
      );
    } catch {
      /* diagnostic only */
    }
  };
  // WI-38257: the ACTUATOR the wedge detector never had. Thresholds are
  // env-tunable because the right value is a property of the deployment, not of
  // the code: an attended desktop wants a longer grace than a headless fleet
  // member nobody is typing into.
  const wedgeBreakAgeMs = positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_BREAK_MS, 90_000);
  const wedgeBreakQuietMs = positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_BREAK_QUIET_MS, 90_000);
  // EI-20287339148365013: the clock-free backstop. Bounds the damage in the
  // unit that actually hurts — wakes thrown away — so it still fires on a host
  // where the timing measurements are absent or are being reset by a repeating
  // machine emitter, which is how ten hosts stayed wedged for up to 259 minutes.
  const wedgeBreakMaxDefers = positiveNumber(env.PAPERCUSP_PSU_PTY_WEDGE_BREAK_MAX_DEFERS, 5);
  /**
   * Clear a staged line that has stopped tracking a person, so a gated write can
   * proceed instead of deferring forever. Returns true when it cleared one.
   *
   * Ctrl-U goes to the CHILD (the TUI owns the composer), and our own model is
   * then resynced explicitly: the gate observes the OWNER's stdin, so it would
   * never see a clear the host itself performed and would go on reporting the
   * line as pending forever — re-wedging on the state we just fixed.
   */
  const breakComposerWedgeIfConfirmed = () => {
    const pendingLength = ownerComposerGate.pendingLength();
    const pendingAgeMs = ownerComposerGate.pendingAgeMs();
    const ownerQuietMs = ownerComposerGate.ownerQuietMs();
    const consecutiveDefers = wedgeDetector.consecutiveDefers();
    if (
      !shouldBreakComposerWedge(
        { pending: ownerComposerGate.hasPending(), pendingAgeMs, ownerQuietMs, consecutiveDefers },
        {
          minAgeMs: wedgeBreakAgeMs,
          minQuietMs: wedgeBreakQuietMs,
          maxDefers: wedgeBreakMaxDefers,
        },
      )
    ) {
      return false;
    }
    // Which rule fired is the first question asked of a break in the field, and
    // reconstructing it later from thresholds and timings is exactly the archaeology
    // whose absence made the original episode undiagnosable. Record it.
    const brokenBy = consecutiveDefers >= wedgeBreakMaxDefers ? 'wake-loss' : 'idle-timing';
    try {
      // \u0015 = Ctrl-U (kill line). Written as an ESCAPE on purpose: a literal
      // control byte here is invisible in review and is exactly what a patch, an
      // editor or a copy-paste silently drops. If it ever degraded to an empty
      // write, markSubmitted() below would still clear our MODEL while the real
      // composer kept its text — so the next injected turn would append to owner
      // text, which is the precise corruption this gate exists to prevent,
      // reintroduced by the code meant to fix it.
      child?.write('\u0015');
    } catch {
      /* the child may have exited under us; the resync below still applies */
    }
    ownerComposerGate.markSubmitted();
    appendHostEvent(ownerId, 'owner-composer-wedge-cleared', {
      pendingLength,
      pendingAgeMs,
      ownerQuietMs: ownerQuietMs === Infinity ? null : ownerQuietMs,
      ownerBytesEverSeen: ownerQuietMs !== Infinity,
      brokenBy,
      consecutiveDefers,
    });
    try {
      process.stderr.write(
        `psu-pty-host: COMPOSER WEDGE CLEARED for ${ownerId} — discarded a ${pendingLength}-char staged ` +
          (brokenBy === 'wake-loss'
            ? `line after ${consecutiveDefers} consecutive wakes were thrown away against it. `
            : `line unchanged for ${Math.round(pendingAgeMs / 1000)}s with no owner keystroke for ` +
              `${ownerQuietMs === Infinity ? 'the whole session' : `${Math.round(ownerQuietMs / 1000)}s`}. `) +
          `It was blocking EVERY wake. If that text was yours, retype it — this agent was dead until now.\n`,
      );
    } catch {
      /* diagnostic only */
    }
    return true;
  };
  let machineTurnActive = false;
  // Latest owner-visible machine submit into THIS child. The ordinary Codex
  // native-boundary probe rejects any older task_complete record, preventing a
  // previous turn from certifying a new turn that has only just been submitted.
  let lastMachineTurnSubmittedAtMs = 0;
  let queuedOwnerInput = [];
  // Mid-turn inject gate (coord-wake-mid-turn-2026-06-30): reads the SAME
  // lastOutputAt the activity tracker records on every `child.onData` below, so a
  // wake `turn` is held until the agent is back at its prompt (output quiescent)
  // — never written into a live, mid-turn TUI (which wedges it, needs ESC). The
  // windows are read from the SESSION env (per-call, like turnSubmitCrDelayForAgent)
  // with the module-level defaults as fallback, so a launch can tune them.
  const turnInjectBusyCapMs = positiveNumber(env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS, TURN_INJECT_BUSY_CAP_MS);
  const agentBusyGate = makeAgentBusyGate({
    lastOutputAt: () => activity.snapshot().lastOutputAt ?? 0,
    quietMs: positiveNumber(env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS, OUTPUT_QUIET_MS),
    capMs: turnInjectBusyCapMs,
  });
  // WI-1941: recycle carry-inject retry budget + backoff (per-session tunable,
  // like the busy cap above). The fresh cold child gets this long to reach its
  // prompt across retried waitAtPrompt() attempts before the carry is dropped.
  const recycleCarryInjectBudgetMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS,
    RECYCLE_CARRY_INJECT_BUDGET_MS,
  );
  const recycleCarryRetryBackoffMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS,
    RECYCLE_CARRY_RETRY_BACKOFF_MS,
  );
  const startupMarkerFallbackMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS,
    STARTUP_MARKER_FALLBACK_MS,
  );

  // Claude may pause at an interactive resume-choice menu after it has already
  // emitted ordinary startup bytes. This gate is deliberately separate from the
  // output-quiet busy gate: a quiet menu is not a composer prompt. It returns
  // immediately for non-Claude/non-scripted launches and for ordinary resumes
  // whose bounded detection window expires without the menu.
  const waitForClaudeResumeCompaction = async (deadline) => {
    if (!claudeResumeCompactionEnabled) return { ready: true };
    while (true) {
      const state = claudeResumeCompaction.tick();
      if (state.timedOut) {
        reportClaudeResumeCompactionTimeout();
        return { ready: false, reason: 'resume-compaction-timeout' };
      }
      if (!claudeResumeCompaction.isAwaitingPrompt()) return { ready: true };
      if (Date.now() >= deadline) {
        reportClaudeResumeCompactionTimeout();
        return { ready: false, reason: 'resume-compaction-timeout' };
      }
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  };

  // WI-2930: verify every injected submit actually started a turn — resubmit a
  // bare CR at each quiet observation in a bounded post-submit window (see
  // makeSubmitVerifier). writeCr reads the live `child` closure so it survives a
  // recycle; a fresh verifier per call keeps the human-input abort baseline fresh.
  const verifySubmitted = async (
    label,
    // WI-1378748: default by LABEL, not a blanket `true` — a wake inject
    // (turn/reset) must never be host-fatal. See submitExhaustionTerminatesHost.
    { terminateOnExhaustion = submitExhaustionTerminatesHost(label) } = {},
  ) => {
    const verifier = makeSubmitVerifier({
      lastOutputAt: () => activity.snapshot().lastOutputAt ?? 0,
      lastInputAt: () => activity.snapshot().lastInputAt ?? 0,
      isQuotaBlocked: () => quotaBlockDetector.isBlocked(),
      writeCr: () => child.write('\r'),
      // WI-2975: NOT OUTPUT_QUIET_MS (that's the busy-gate's short "back at an
      // idle prompt" threshold) — the verifier's own, deliberately-larger quiet
      // bar, so an ordinary post-submit thinking/latency gap is never mistaken
      // for a swallowed CR. See SUBMIT_VERIFY_QUIET_MS above.
      quietMs: submitVerifyQuietMs(env),
      pollMs: positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS, SUBMIT_VERIFY_POLL_MS),
      polls: positiveNumber(env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS, SUBMIT_VERIFY_POLLS),
      maxResubmits: positiveNumber(
        env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR,
        SUBMIT_VERIFY_MAX_RESUBMITS,
      ),
      onResubmit: (n) => {
        try {
          process.stderr.write(
            `psu-pty-host: ${label} submit not confirmed for ${ownerId} — resubmit CR #${n} (WI-2930)\n`,
          );
        } catch {
          /* never let a diagnostic write break the session */
        }
      },
      // A managed session-port kickoff has a stronger, independent proof:
      // waitForNativeTranscriptMarker below. Its target can persist the marker
      // after the TUI goes quiet, so WI-41044's generic host teardown would race
      // the authoritative native-persistence acknowledgement. Startup submits
      // otherwise retain the host-fatal exhaustion behavior; WAKE injects never
      // do (WI-1378748).
      onExhausted: ({ polls, resubmits, outputObservedAfterResubmit }) => {
        const details = {
          label,
          polls,
          resubmits,
          maxResubmits: positiveNumber(
            env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR,
            SUBMIT_VERIFY_MAX_RESUBMITS,
          ),
          outputObservedAfterResubmit,
        };
        if (terminateOnExhaustion && !quotaBlockDetector.isBlocked()) {
          terminateSubmitVerifyExhaustion(details);
          return;
        }
        // WI-1378748: NOT fatal — but never silent either. Trading a loud kill
        // for a silent drop would just swap one invisible failure for another,
        // so the undelivered wake is recorded on the same event log the kill
        // used to write, and says plainly that the session was left running.
        appendHostEvent(ownerId, 'submit-verify-unconfirmed', {
          ...details,
          reason: 'max-resubmits-without-output',
          terminated: false,
        });
        try {
          process.stderr.write(
            `psu-pty-host: ${label} submit unconfirmed for ${ownerId} after ` +
              `${resubmits} resubmit CRs — wake not delivered, session left running (WI-1378748)\n`,
          );
        } catch {
          /* diagnostic only */
        }
      },
    });
    const result = await verifier.verify();
    if (result.aborted === 'quota-blocked') {
      appendHostEvent(ownerId, 'submit-verify-unconfirmed', {
        label,
        polls: result.polls,
        resubmits: result.resubmits,
        reason: 'quota-blocked',
        terminated: false,
      });
    }
    return result;
  };

  /**
   * Deliver `text` as a TURN once the child is back at its prompt — GUARANTEED
   * or LOUDLY DROPPED, never silently. Retries `waitAtPrompt` across a
   * wall-clock budget (a cold/replaying child can stay busy past one agent-busy
   * cap and THEN settle), writes the per-agent paste-safe turn plan, and
   * verifies the submit actually started a turn (WI-2930). Bails if a recycle
   * supersedes the child mid-flight.
   *
   * Two callers: the RECYCLE carry-note (WI-1941) and the launch KICKOFF
   * (agent-launch-resume-primitives-2026-07-12 P-011/D-008) — a resumed or
   * forked session boots IDLE at its prompt with no first turn, and nothing
   * roster-gated can reach it (its presence rows were reaped when it died, so
   * coord:wake/coord:send answer `unknown_recipient`). The host owns the pty, so
   * it is the one place that can seed that turn without a discovery race — and
   * it works identically for a FORK, whose fresh coord identity no external
   * caller can know until it boots.
   */
  const injectTurnAtPrompt = async ({
    text,
    label,
    budgetMs = recycleCarryInjectBudgetMs,
    backoffMs = recycleCarryRetryBackoffMs,
    onDrop = () => {},
    requireInitialOutput = false,
    terminateOnSubmitVerifyExhaustion = true,
    freshChildOwnerInputGeneration = null,
  }) => {
    if (!text) return { delivered: false, reason: 'no-text', attempts: 0 };
    const injectChild = child; // bail if a newer recycle supersedes this one
    const deadline = Date.now() + budgetMs;
    let attempts = 0;
    let dropReason = 'never-settled';
    const freshChildWasInterrupted = () =>
      freshChildOwnerInputGeneration !== null &&
      ownerInputGeneration !== freshChildOwnerInputGeneration;
    try {
      // A scripted resume/port begins this task before wireChildData() is
      // reached later in host setup. Yield until the listener has observed at
      // least one real startup byte; the subsequent quiet gate then proves the
      // startup repaint has settled at a prompt. Never infer readiness from the
      // sentinel lastOutputAt=0 value.
      while (
        requireInitialOutput &&
        !childStartupReady &&
        !freshChildWasInterrupted() &&
        !(
          childStartupFirstOutputAt > 0 &&
          Date.now() - childStartupFirstOutputAt >= startupMarkerFallbackMs
        ) &&
        Date.now() < deadline
      ) {
        const recoveryState = claudeResumeCompaction.tick();
        if (recoveryState.timedOut) {
          reportClaudeResumeCompactionTimeout();
          dropReason = 'resume-compaction-timeout';
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      // The inner delivery loop below owns the common drop/diagnostic path. Do
      // not return or break from this outer try block when the recovery machine
      // has already timed out; its next gated check observes the same terminal
      // state and exits through that shared path.
      const startupFallbackReady =
        childStartupFirstOutputAt > 0 &&
        Date.now() - childStartupFirstOutputAt >= startupMarkerFallbackMs;
      // EI-20270422678541544 — TERMINAL FALLBACK. A missing startup-ready marker
      // used to return from here with `attempts: 0`, having never once tried to
      // write. That is a GUARANTEED strand whenever marker detection has a false
      // negative, and this detection is inherently best-effort: it is a pattern
      // match over TUI boot output, and a child whose startup bytes landed before
      // wireChildData() attached its listener leaves BOTH childStartupReady and
      // childStartupFirstOutputAt unset while sitting perfectly healthy at its
      // prompt. Observed live 2026-08-12T17:45:31Z — `respawn-carry-dropped
      // reason=no-startup-ready-marker attempts=0 outputSeen=false`, after which
      // that session never took another machine turn until a human typed.
      //
      // So the marker's ABSENCE no longer decides delivery; it only decides how
      // many attempts we are willing to spend. Spend exactly ONE, bounded by the
      // busy gate's own cap: if the child really is at its prompt the turn lands
      // and the session recovers on its own; if it is genuinely dead the write is
      // a no-op inside the existing try/catch and we still drop — but with
      // attempts >= 1 and a reason recording that the fallback was exercised, so
      // the two cases stop being indistinguishable in the ledger.
      const startupMarkerMissing =
        requireInitialOutput && !childStartupReady && !startupFallbackReady;
      if (startupMarkerMissing) dropReason = 'no-startup-ready-marker';
      let lastResortSpent = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (startupMarkerMissing) {
          if (lastResortSpent) {
            dropReason = 'no-startup-ready-marker-last-resort-failed';
            break;
          }
          lastResortSpent = true;
        }
        if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
        if (freshChildWasInterrupted()) {
          dropReason = 'fresh-child-owner-input';
          break;
        }
        attempts++;
        const recoveryBeforeBusy = await waitForClaudeResumeCompaction(deadline);
        if (!recoveryBeforeBusy.ready) {
          dropReason = recoveryBeforeBusy.reason;
          break;
        }
        if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
        // WI-10001066: a fresh Codex child has no submitted turn yet, but its
        // idle composer can repaint continuously. Positive startup proof plus
        // no intervening owner input establishes readiness without requiring
        // raw PTY silence. Reused children and heuristic startup fallbacks
        // still take the ordinary busy gate.
        const freshPromptReady = freshChildOwnerInputGeneration !== null && childStartupReady;
        const atPrompt = freshPromptReady
          ? { deferred: false }
          : await agentBusyGate.waitAtPrompt();
        if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
        if (!atPrompt.deferred) {
          // The menu can be painted while the ordinary quiet gate is settling.
          // Re-check immediately before the first byte so a stale quiet reading
          // can never authorize a kickoff into the recovery choices.
          const recoveryAfterBusy = await waitForClaudeResumeCompaction(deadline);
          if (!recoveryAfterBusy.ready) {
            dropReason = recoveryAfterBusy.reason;
            break;
          }
          if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
          if (freshChildWasInterrupted()) {
            dropReason = 'fresh-child-owner-input';
            break;
          }
          if (quotaBlockDetector.isBlocked()) {
            await verifySubmitted(label);
            dropReason = 'submit-verification-aborted-quota-blocked';
            break;
          }
          for (const step of controlWritesForAgent({ mode: 'turn', data: text }, env.PAPERCUSP_AGENT, env)) {
            if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
            if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
            const chunks = ptyWriteChunks(step.data);
            for (let i = 0; i < chunks.length; i++) {
              try {
                quotaBlockDetector.observeInput(chunks[i]);
                child.write(chunks[i]);
              } catch {
                /* the child may have exited under us */
              }
              if (i + 1 < chunks.length) await new Promise((r) => setTimeout(r, 0));
            }
          }
          lastMachineTurnSubmittedAtMs = Date.now();
          if (child !== injectChild) {
            return { delivered: false, reason: 'superseded', attempts };
          }
          const submitVerification = await verifySubmitted(label, {
            terminateOnExhaustion: terminateOnSubmitVerifyExhaustion,
          });
          if (child !== injectChild) {
            return { delivered: false, reason: 'superseded', attempts };
          }
          // EI-21561923024113260 / WI-42318: verifier exhaustion and abort are
          // semantic negative/unknown outcomes. Ignoring either let a pty write
          // race cleanup or human input and still become delivered:true.
          // Callers with a stronger semantic proof (managed/native transcript)
          // deliberately disable generic fatal exhaustion and own the verdict
          // themselves. Only callers that opt into this verifier as authority
          // may turn its negative/unknown result into a delivery drop.
          const verificationFailure = terminateOnSubmitVerifyExhaustion || submitVerification.aborted === 'quota-blocked'
            ? submitVerificationFailureReason(submitVerification)
            : null;
          if (verificationFailure) {
            dropReason = verificationFailure;
            break;
          }
          return { delivered: true, attempts };
        }
        // Deferred: the child is still mid-boot / mid-turn. Retry until the
        // budget is spent, then fall through to the loud drop.
        // The last-resort pass gets exactly one attempt regardless of the budget
        // (which the startup-marker wait has usually already spent), so re-enter
        // and let the top of the loop record the terminal reason.
        if (startupMarkerMissing) continue;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    } catch {
      /* an unexpected inject error still falls through to the drop trace */
    }
    if (child !== injectChild) return { delivered: false, reason: 'superseded', attempts };
    try {
      onDrop();
    } catch {
      /* the drop trace must never break the session */
    }
    try {
      process.stderr.write(
        `psu-pty-host: ${label} DROPPED for ${ownerId} (${
          dropReason === 'no-startup-ready-marker-last-resort-failed'
            ? 'the child never emitted its startup-ready marker AND the last-resort attempt found no prompt'
            : dropReason === 'no-startup-ready-marker'
              ? 'the child never emitted its startup-ready marker'
              : dropReason === 'submit-verification-exhausted'
                ? 'submit verification exhausted without observing output after a resubmit'
                : dropReason.startsWith('submit-verification-aborted-')
                  ? `submit verification aborted (${dropReason.slice('submit-verification-aborted-'.length)})`
              : dropReason === 'fresh-child-owner-input'
                ? 'the owner used the fresh child before its carry prompt was submitted'
              : dropReason === 'resume-compaction-timeout'
                ? 'Claude resume compaction recovery timed out before a standalone composer prompt appeared'
              : 'the child never settled to its prompt'
        } ` +
          `within ${budgetMs}ms over ${attempts} attempt(s))\n`,
      );
    } catch {
      /* never let a diagnostic write break the host */
    }
    return { delivered: false, reason: dropReason, attempts };
  };

  // Scripted fresh launches and resumes share the managed first-turn seam;
  // prompts stay out of argv. Only a fresh Codex thread can use startup proof
  // instead of output silence. Resume/fork may already be running a turn.
  if (launchKickoff) {
    void (async () => {
      const label = managedKickoff ? 'session-port seed' : 'launch kickoff';
      const r = await injectTurnAtPrompt({
        text: launchKickoff,
        label,
        requireInitialOutput: true,
        freshChildOwnerInputGeneration: env.PAPERCUSP_AGENT === 'codex' &&
          !args.some((arg) => arg === 'resume' || arg === 'fork')
          ? ownerInputGeneration
          : null,
        // The managed kickoff's native transcript proof owns its failure
        // timeout and child kill. Do not let the generic submit verifier tear
        // down the host before that proof can observe a late marker.
        terminateOnSubmitVerifyExhaustion: !managedKickoff,
      });
      if (!managedKickoff) {
        if (!r.delivered) {
          // An opted-in detached caller must receive a terminal negative receipt
          // even when the PTY submission never started. Otherwise the parent
          // waits out its proof window and cannot distinguish "not submitted"
          // from a host that died before it could report.
          publishKickoffProofReceipt({
            persisted: false,
            nativeRef: null,
            reason: `kickoff-not-submitted:${r.reason ?? 'unknown'}`,
          }, env);
          return;
        }
        let proof;
        try {
          proof = await verifyNativeTurnStartWithRetry({
            agent: env.PAPERCUSP_AGENT,
            env,
            text: launchKickoff,
            sinceMs: nativeCaptureAfterMs,
            timeoutMs: nativePersistenceTimeoutMs,
            writeCr: () => child.write('\r'),
            onRetry: () => {
              appendHostEvent(ownerId, 'launch-kickoff-turn-start-retry', {
                reason: 'native-turn-marker-timeout',
              });
            },
          });
        } catch (error) {
          proof = {
            persisted: false,
            nativeRef: null,
            retried: false,
            reason: 'native-turn-proof-error',
          };
          appendHostEvent(ownerId, 'launch-kickoff-turn-start-proof-error', {
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
        // Publish the native transcript verdict before any caller-facing
        // handling. The detached parent owns the placeholder and uses this
        // receipt as the only authority for whether its kickoff ran.
        publishKickoffProofReceipt({
          persisted: proof.persisted === true,
          nativeRef: proof.nativeRef ?? null,
          reason: proof.persisted ? null : proof.reason,
        }, env);
        if (!proof.persisted) {
          const proofUnavailable =
            proof.reason === 'missing-leading-turn-origin' ||
            proof.reason === 'unsupported-backend';
          appendHostEvent(ownerId, 'launch-kickoff-turn-start-unverified', {
            reason: proof.reason,
            retried: proof.retried,
            proofUnavailable,
          });
          try {
            process.stderr.write(
              proofUnavailable
                ? `psu: kickoff submitted but UNVERIFIED — native execution proof is unavailable ` +
                  `(${proof.reason}); never claiming delivered.\n`
                : `psu: kickoff DROPPED — the exact provenance marker never entered the native transcript ` +
                  `(${proof.reason ?? 'native marker timeout'}).\n`,
            );
          } catch {
            /* diagnostics are best-effort */
          }
          // Plain hostThroughPty callers predate provenance tagging. Preserve
          // their submitted session without making a false delivery claim.
          // Production scripted fleet kickoffs are tagged; a missing marker
          // there is authoritative and the fresh, workless child is terminated.
          if (!proofUnavailable && !quotaBlockDetector.isBlocked()) {
            try { child.kill(); } catch { /* already exited */ }
          }
          return;
        }
        // WI-2140591: the marker proves the prompt was ACCEPTED, not that the
        // model ran. Watch for the turn to actually start before claiming
        // delivery — a sampling-layer give-up leaves the marker in place, the
        // child alive, and the session idle forever with nobody informed. The
        // receipt above is already published, so the detached parent is never
        // delayed by this observation.
        const readLastOutputAt = () => activity.snapshot().lastOutputAt ?? 0;
        let turnStart = await observeKickoffModelTurnStart({ lastOutputAt: readLastOutputAt });
        let modelRetried = false;
        if (turnStart.observed && !turnStart.started) {
          modelRetried = true;
          appendHostEvent(ownerId, 'launch-kickoff-model-turn-absent', {
            budgetMs: turnStart.budgetMs,
            polls: turnStart.polls,
            reason: turnStart.reason,
            retrying: true,
          });
          // Re-send the kickoff TEXT, not a bare CR: the prompt already
          // submitted, so the composer is EMPTY and an Enter would be a no-op.
          // Routed through injectTurnAtPrompt so it inherits the busy/composer
          // gates — an UNGATED retype is the documented mid-turn wedge, and the
          // one case this detector can be wrong about (a genuinely slow turn) is
          // exactly the case those gates exist to defer. Never terminate on this
          // path: the child is still usable and the first turn already persisted.
          try {
            await injectTurnAtPrompt({
              text: launchKickoff,
              label: 'launch kickoff (model-turn retry)',
              requireInitialOutput: false,
              terminateOnSubmitVerifyExhaustion: false,
            });
          } catch (error) {
            appendHostEvent(ownerId, 'launch-kickoff-model-turn-retry-error', {
              error: String(error?.message ?? error).slice(0, 200),
            });
          }
          turnStart = await observeKickoffModelTurnStart({ lastOutputAt: readLastOutputAt });
          appendHostEvent(ownerId, 'launch-kickoff-model-turn-retry-result', {
            started: turnStart.started,
            polls: turnStart.polls,
          });
        }
        try {
          process.stderr.write(
            turnStart.started
              ? `psu: kickoff delivered — verified the exact provenance marker in the native transcript` +
                `${modelRetried ? ' (model turn started only after one in-session retry)' : ''}.\n`
              : `psu: kickoff ACCEPTED BUT THE MODEL TURN NEVER STARTED — the provenance marker ` +
                `persisted, then ${Math.round(turnStart.budgetMs / 1000)}s passed with no output ` +
                `(retried once). The child is alive and idle; it is NOT working.\n`,
          );
        } catch {
          /* diagnostics are best-effort */
        }
        return;
      }
      if (!r.delivered) {
        try {
          await acknowledgeManagedKickoff({
            persisted: false,
            renderedHash: managedKickoff.renderedHash,
            error: `session-port seed was not submitted (${r.reason ?? 'unknown'})`,
          });
        } finally {
          if (!quotaBlockDetector.isBlocked()) {
            try { child.kill(); } catch { /* already exited */ }
          }
        }
        return;
      }
      const proof = await waitForNativeTranscriptMarker({
        agent: env.PAPERCUSP_AGENT,
        env,
        marker: managedKickoff.marker,
        sinceMs: nativeCaptureAfterMs,
        timeoutMs: nativePersistenceTimeoutMs,
      });
      if (!proof.persisted) {
        try {
          await acknowledgeManagedKickoff({
            persisted: false,
            renderedHash: managedKickoff.renderedHash,
            error: `session-port seed was submitted but not found in the ${env.PAPERCUSP_AGENT} native transcript`,
          });
        } finally {
          if (!quotaBlockDetector.isBlocked()) {
            try { child.kill(); } catch { /* already exited */ }
          }
        }
        return;
      }
      try {
        await acknowledgeManagedKickoff({
          persisted: true,
          renderedHash: managedKickoff.renderedHash,
          nativeRef: proof.nativeRef,
        });
        process.stderr.write(
          `psu: session port delivered — verified the exact seed checksum in the target native transcript.\n`,
        );
      } catch (error) {
        process.stderr.write(`psu: session-port delivery acknowledgement failed: ${error?.message ?? error}\n`);
        if (!quotaBlockDetector.isBlocked()) {
          try { child.kill(); } catch { /* already exited */ }
        }
      }
    })().catch((error) => {
      if (!managedKickoff) {
        publishKickoffProofReceipt({
          persisted: false,
          nativeRef: null,
          reason: 'launch-kickoff-error',
        }, env);
      }
      try { process.stderr.write(`psu: managed kickoff failed: ${error?.message ?? error}\n`); }
      catch { /* diagnostics are best-effort */ }
      try { child.kill(); } catch { /* already exited */ }
    });
  }

  // P-001a (compaction-continuity-hardening): fold duplicate same-source turn
  // injects that stack up at the gates while the agent is busy — see the
  // makeTurnCoalescer doc block for the measured 9× duplication this kills.
  const turnCoalescer = makeTurnCoalescer();
  // EI-19311270129974785: remember delivery ids while their detached gated
  // pipeline is pending and after it commits, so a retry cannot inject a second
  // real turn while an early ACK is still only acceptance.
  const deliveryDedup = makeDeliveryDedup();
  // EI-8822: serialize the gated-inject critical section so a wake `turn` and a
  // session:request-compaction `/compact` freed at the SAME clean boundary can't
  // both pass the at-prompt gate and interleave their bytes into one pty input
  // line (the "/compact swallowed as prose" race). See makeInjectMutex.
  //
  // EI-22123519641932348: onStuck is this mutex's ONLY observability seam — a
  // wedged holder previously left ZERO trace (the ~6h total-silence incident
  // this closes). Durably record every stuck/force-release tick on THIS
  // owner's event log (so a peer/watchdog reading it after the fact can see
  // the session went dark and why) and echo it to stderr, matching every
  // other loud-diagnostic write in this file.
  const injectMutex = makeInjectMutex({
    onStuck: ({ phase, waitedMs }) => {
      appendHostEvent(ownerId, phase === 'force-release' ? 'inject-mutex-force-released' : 'inject-mutex-stuck', {
        waitedMs,
      });
      try {
        process.stderr.write(
          phase === 'force-release'
            ? `psu-pty-host: inject-mutex FORCE-RELEASED for ${ownerId} after ${waitedMs}ms — ` +
                `a prior gated inject never reached its release; every gated inject since has been ` +
                `queued behind it (EI-22123519641932348). Proceeding the next waiter now.\n`
            : `psu-pty-host: inject-mutex looks STUCK for ${ownerId} (held ${waitedMs}ms with no ` +
                `release yet, EI-22123519641932348) — every gated inject since is queuing behind it\n`,
        );
      } catch {
        /* never let a diagnostic write break the host */
      }
    },
  });
  // WI-5510: per-loop-instance last-delivered fire number — the delivery-side
  // half of the stale-fire guard (see makeStaleFireGuard's doc block). One
  // guard per host process is correct: this host serves exactly ONE ownerId
  // for its whole lifetime (D-006), so it needs no owner-keyed map, only a
  // loop-instance-keyed (routineId) one.
  const staleFireGuard = makeStaleFireGuard();
  // EI-12754: one-shot deferred retry for busy-gate-refused carry-respawn
  // drills. The retry window defaults to 2× the live-inject cap (a busy turn
  // that outran the first 3-minute wait gets one more, longer chance to settle);
  // per-session tunable like the caps above. Deps are read through closures so
  // the retry always uses the CURRENT recycleChild (it is reassigned per child).
  const carryRearmCapMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_REARM_CAP_MS,
    turnInjectBusyCapMs * 2,
  );
  // EI-18109211232286833: per-session tunable like the caps above, so tests
  // can force a tiny budget instead of waiting out the 10-minute default.
  const carryRespawnMaxAgeMs = positiveNumber(
    env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS,
    CARRY_RESPAWN_MAX_AGE_MS,
  );
  const carryRearm = makeCarryRearmController({
    acquireInject: () => injectMutex.acquire(),
    waitIdle: bridgeTty ? () => idleGate.waitIdle() : null,
    waitAtPrompt: (cap, msg) => agentBusyGate.waitAtPrompt(cap, () => codexCarryTurnCompleted({
      agent: env.PAPERCUSP_AGENT, env, transcriptPath: msg?.sourceTranscriptPath,
      receivedAtMs: msg?.receivedAtMs,
    })),
    recycle: (data, opts) => recycleChild(data, opts),
    emitEvent: (kind, extra) => {
      appendHostEvent(ownerId, kind, extra);
      appendSharedDrillLedgerEvent(ownerId, kind, extra);
    },
    capMs: carryRearmCapMs,
    // EI-18665672258948707: a carry-respawn that has been SUPERSEDED by a later
    // respawn already delivered on this host is dropped unconditionally, same as
    // age-based staleness — see isCarryRespawnSuperseded's doc block.
    isStale: (msg) =>
      isCarryRespawnStale(msg.receivedAtMs, { maxAgeMs: carryRespawnMaxAgeMs }) ||
      isCarryRespawnSuperseded(msg.receivedAtMs, lastRespawnAtMs),
  });

  // Control socket: a connector writes one v1 envelope (or legacy raw bytes);
  // we inject it into the pty (a wake turn / a force-interrupt control byte).
  // P-013: a 'turn' (wake) is deferred until the user's input line is idle so a
  // mid-keystroke human line is never corrupted; a 'raw' (force interrupt) is
  // written IMMEDIATELY (the whole point of force is to land mid-thinking).
  // EI-18676244363359331 / WI-5872: allowHalfOpen:true is LOAD-BEARING for the
  // application-level ACK below. Node's net.Server default (allowHalfOpen:false)
  // auto-ends the WRITABLE side the instant the readable side sees the client's
  // FIN ('end') — i.e. the server socket starts closing back IMMEDIATELY, before
  // the async gate pipeline below (idleGate/agentBusyGate/stale-fire/superseded
  // checks, then the actual pty write) ever runs. That auto-close is exactly what
  // makes injectIntoHost()'s client-side `c.on('close', () => finish(true))`
  // resolve true on bare TCP close alone — the close race, not any real signal of
  // delivery. allowHalfOpen:true keeps `conn` writable after 'end' fires so the
  // handler below can write a real ACK/NACK once it actually knows the outcome,
  // then close the connection itself.
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    const chunks = [];
    let payloadBytes = 0;
    let payloadRejected = false;
    conn.on('data', (d) => {
      if (payloadRejected) return;
      payloadBytes += d.length;
      if (payloadBytes > MAX_CONTROL_PAYLOAD_BYTES) {
        payloadRejected = true;
        chunks.length = 0;
        appendHostEvent(ownerId, 'control-payload-rejected', {
          reason: 'payload-too-large',
          receivedBytes: payloadBytes,
          maxBytes: MAX_CONTROL_PAYLOAD_BYTES,
        });
        try {
          process.stderr.write(
            `psu-pty-host: control payload REJECTED for ${ownerId} ` +
              `(${payloadBytes} bytes > ${MAX_CONTROL_PAYLOAD_BYTES} byte cap)\n`,
          );
        } catch {
          /* diagnostic only */
        }
        conn.destroy();
        return;
      }
      chunks.push(d);
    });
    conn.on('error', () => {});
    // EI-18676244363359331 / WI-5872: the whole existing gate/delivery pipeline
    // is now wrapped in an inner IIFE that RETURNS an { ok, reason } outcome at
    // every exit (instead of a bare `return;`) — the outer wrapper writes that
    // outcome back on `conn` as an application-level ACK/NACK before closing it,
    // so a caller no longer has to infer delivery from bare TCP close timing.
    // Every existing early-exit / drop / success path below is UNCHANGED in its
    // own behavior (same gates, same logging, same side effects) — each just
    // now also reports what happened, on the same connection, before it closes.
    conn.on('end', async () => {
      const outcome = await (async () => {
      if (payloadRejected) return { ok: false, reason: 'payload-rejected' };
      const payload = Buffer.concat(chunks);
      if (!payload.length) return { ok: false, reason: 'empty-payload' };
      const msg = decodeControl(payload);
      // EI-153: MISDELIVERY guard — the sender's addressed-recipient assertion
      // (decodeOwnerIdentity) is checked against THIS host's own registered
      // ownerId before anything else runs. This is leg-independent of *why* a
      // wrong envelope reached this socket (a swapped subscriberId, a stale/
      // reused host object, a sanitizeKey collision at some OTHER layer) — no
      // matter the cause, a host that finds itself holding a control message
      // addressed to a DIFFERENT agent must refuse to act on it rather than
      // silently running another agent's work/identity in its own session (the
      // su-b6c3f → su-ff997 incident). Absent `ownerId` (a pre-EI-153 sender, or
      // a legacy non-envelope payload) is a no-op — unchanged behavior.
      if (msg.ownerId != null && msg.ownerId !== ownerId) {
        const rejectExtra = { reason: 'ownerId-mismatch', mode: msg.mode, expected: ownerId, got: msg.ownerId };
        appendHostEvent(ownerId, 'control-payload-rejected', rejectExtra);
        try {
          process.stderr.write(
            `psu-pty-host: control payload REJECTED for ${ownerId} — addressed to ${msg.ownerId} ` +
              `(mode:${msg.mode}); refusing to run another agent's turn/identity in this session (EI-153)\n`,
          );
        } catch {
          /* diagnostic only */
        }
        return { ok: false, reason: 'ownerId-mismatch' };
      }
      // WI-2141435: the guard above calls appendHostEvent ONLY on its reject path, so
      // its silence cannot distinguish "no violations" from "structurally blind to this
      // class" — an ownerId-less payload takes the documented no-op branch above and
      // leaves NO trace at all. Measured on WI-2140968: control-payload-rejected had
      // fired 128 times, EVERY one in an su-itest-misdeliver-* fixture and none in a
      // real session, across a period in which 9 real cross-owner deliveries provably
      // occurred. A firing count of zero was reporting blindness as cleanliness.
      //
      // DETECTOR ONLY — control flow is deliberately unchanged: an unaddressed payload
      // is still accepted exactly as before. Refusing it is a separate, later step
      // (WI-2141435 step 2), gated on this detector first showing a clean production
      // population — an older still-running sender that omits ownerId would otherwise
      // have every delivery refused fleet-wide, and host-code-stale is real and ongoing.
      if (msg.ownerId == null) {
        try {
          let v1 = false;
          try {
            v1 = JSON.parse(payload.toString('utf8'))?.v === 1;
          } catch {
            /* not JSON at all — a genuinely legacy raw payload */
          }
          appendHostEvent(ownerId, 'control-payload-unaddressed', {
            reason: 'no-ownerId',
            mode: msg.mode,
            bytes: payload.length,
            // true  ⇒ a v1 envelope that simply OMITTED ownerId (a pre-EI-153 sender)
            // false ⇒ decodeControl's legacy promotion of a NON-envelope payload
            envelope: v1,
          });
        } catch {
          /* a detector must never be able to affect delivery */
        }
      }
      // EI-19311270129974785: a RETRY of a delivery this host has already accepted
      // is short-circuited before any mode-specific state mutation. Pending means
      // the detached pipeline has not committed a write yet; completed means the
      // original delivery reached its commitment point. A terminal failed/deferred
      // pipeline clears pending below so a later retry remains eligible.
      // Absent/empty deliveryId (a one-shot raw/osc/compact/mcp-reconnect call, or a
      // pre-fix sender) makes this a no-op — unchanged behavior.
      const duplicateState = deliveryDedup.state(msg.deliveryId);
      if (duplicateState) {
        // EI-21428742689578243: `accepted` means the FIRST copy can wait behind
        // the host's busy/composer gates for minutes. During that wait the durable
        // pump retries the SAME delivery id, and executeWake rehydrates its text
        // from the latest loop:checkpoint. Pre-fix, the id-dedup returned here
        // before the turn coalescer could see those fresh bytes, so the eventually
        // delivered banner combined an enqueue-time checkpoint with a newer age.
        // Refresh only a still-pending LOOP waiter. It remains ONE logical delivery
        // (folded is unchanged), completed ids remain immutable, and a waiter that
        // already claimed its slot is deliberately not resurrected.
        const pendingLoopKey =
          duplicateState === 'pending' && msg.mode === 'turn' && msg.routineId
            ? turnCoalesceKey(msg.data, msg.routineId, ownerId)
            : null;
        const pendingLoopMetadata =
          msg.routineId && msg.fireNumber != null
            ? { routineId: msg.routineId, fireNumber: msg.fireNumber }
            : undefined;
        const refreshedPendingTurn =
          pendingLoopKey != null
            ? turnCoalescer.refresh(pendingLoopKey, msg.data, pendingLoopMetadata)
            : false;
        const duplicateReason =
          duplicateState === 'pending' ? 'pending-delivery-id' : 'duplicate-delivery-id';
        try {
          process.stderr.write(
            `psu-pty-host: duplicate delivery id ${msg.deliveryId} for ${ownerId} short-circuited ` +
              `(${duplicateState}, mode:${msg.mode}${refreshedPendingTurn ? ', queued text refreshed' : ''})\n`,
          );
        } catch {
          /* diagnostic only */
        }
        return { ok: true, reason: duplicateReason };
      }
      // SHUTDOWN (WI-6638) — wind this session down and EXIT, closing its tab.
      //
      // Handled HERE, before the coalescer / carry-rearm / inject gates: those all
      // exist to schedule a FUTURE turn, and the whole premise of a shutdown is that
      // there will not be one. Deliberately NOT routed through the reaper's kill path
      // either — measured 2026-08-03, every psu session classifies
      // driveMode:'responsive' and is excluded from the live-idle cohort by the
      // queen-fleet-authority-boundary ruling (P-001/D-001) long before the window
      // guard is consulted. A system reaper may not kill these; only the session
      // itself may exit. This signals nothing but our OWN child.
      if (msg.mode === 'shutdown') {
        if (shuttingDown) return { ok: true, reason: 'already-shutting-down' };
        const refusal = shutdownRefusalReason({
          launchedBy: env.PAPERCUSP_LAUNCHED_BY,
          headless: bridgeTty === false,
          fleetSlug: env.PAPERCUSP_FLEET_SLUG,
          lastInputAt: activity.snapshot().lastInputAt ?? 0,
          agentQuietMs: agentBusyGate.quietForMs(),
          force: msg.force === true,
        });
        if (refusal) {
          appendHostEvent(ownerId, 'shutdown-refused', { reason: refusal, note: msg.data || '' });
          return { ok: false, reason: `shutdown-refused:${refusal}` };
        }
        shuttingDown = true;
        appendHostEvent(ownerId, 'shutdown-accepted', {
          note: msg.data || '',
          forced: msg.force === true,
        });
        try {
          process.stderr.write(
            `psu-pty-host: SHUTDOWN accepted for ${ownerId}${msg.data ? ` — ${msg.data}` : ''}; ` +
              `winding the session down and closing this terminal.\n`,
          );
        } catch {
          /* diagnostic only */
        }
        // DEFERRED so the ACK gets out first. The kill leads (via the child's own
        // exit) to cleanup → onExit → psu `process.exit`, which tears down this very
        // socket — killing synchronously here would race the ack write below
        // (conn.write at the end of this handler) and the requester would read a
        // successful shutdown as a `timeout`/`send-failed` miss.
        //
        // SIGHUP lets the TUI flush its transcript; the child's exit then runs the
        // normal cleanup path and psu exiting closes the `gnome-terminal --wait` tab.
        // The escalation timer is the backstop for a child that ignores SIGHUP.
        setTimeout(() => {
          try {
            killPtyProcessTree(child, 'SIGHUP');
          } catch {
            /* the escalation below still covers it */
          }
          const escalate = setTimeout(() => {
            try {
              killPtyProcessTree(child, 'SIGKILL');
            } catch {
              /* nothing further we can do */
            }
          }, SHUTDOWN_GRACE_MS);
          if (typeof escalate.unref === 'function') escalate.unref();
        }, SHUTDOWN_ACK_DELAY_MS);
        // NOT unref'd: this timer is the shutdown itself, and an unref'd one would
        // let an otherwise-idle host exit the event loop before it ever fires.
        return { ok: true, reason: 'shutdown-accepted' };
      }
      // EI-18679681961154136: a carry-respawn re-arm retry is PENDING for this
      // owner (an earlier busy-gate defer, now re-polling for the next idle
      // window — see makeCarryRearmController). An ordinary wake `turn` must
      // NOT be allowed to compete for that same idle window: the rearm loop
      // RELEASES the inject mutex between attempts (deliberately, so ordinary
      // wakes are never wedged waiting on it) — but that means a ready-to-fire
      // wake can win the race for every idle window the rearm loop is polling
      // for, opening a fresh turn that makes the agent busy again before the
      // rearm's own next attempt lands. Repeat that indefinitely (a busy,
      // well-connected agent keeps receiving wakes) and the carry-respawn is
      // starved forever — observed + diagnosed end-to-end on 2026-07-26. The
      // wake is already durable mail (coord/loop redeliver it), so it loses
      // nothing by skipping this live injection: defer it exactly like an
      // ordinary busy-gate refusal (queue-to-next-turn), and let the rearm
      // loop's next attempt have the idle window uncontested. Scoped to
      // `mode:'turn'` only — reset/recycle/mcp-reconnect stay unaffected;
      // they are already explicit operator/owner actions, not routine wakes.
      if (shouldDeferWakeForPendingRespawn(msg.mode, carryRearm.pendingCount())) {
        const dropExtra = { reason: 'carry-respawn-pending' };
        appendHostEvent(ownerId, 'wake-turn-deferred-for-pending-respawn', dropExtra);
        try {
          process.stderr.write(
            `psu-pty-host: wake turn DEFERRED for ${ownerId} (a carry-respawn re-arm is pending) — ` +
              `left in inbox for the successor's first natural turn\n`,
          );
        } catch {
          /* diagnostic only */
        }
        return { ok: false, reason: 'deferred-carry-respawn-pending' };
      }
      // EI-18109211232286833: stamp the receipt time ONCE, here, so both this
      // delivery attempt and its one makeCarryRearmController retry (which
      // reuses this same `msg` object — see carryRearm.schedule below) measure
      // TOTAL elapsed wait against isCarryRespawnStale, not a per-attempt one.
      if (msg.mode === 'carry-respawn' && msg.receivedAtMs == null) {
        msg.receivedAtMs = Date.now();
      }
      // EI-18681914950138372: mark this carry-respawn in-flight NOW, before it
      // ever enters its own busy-gate wait below — this is what closes the
      // starvation gap (see beginFirstAttempt's doc comment on
      // makeCarryRearmController). Cleared exactly once, whichever way this
      // attempt concludes, via the runGatedDelivery().finally() below.
      if (msg.mode === 'carry-respawn') {
        carryRearm.beginFirstAttempt(msg);
      }
      // P-001a: a same-source turn already waiting at the gates absorbs this one —
      // newest text wins, the waiter delivers ONE annotated turn. Only mode:'turn'
      // (never reset/recycle/compact — lifecycle verbs are not duplicates of work).
      const coalesceKey = msg.mode === 'turn' ? turnCoalesceKey(msg.data, msg.routineId, ownerId) : null;
      const coalesceMetadata =
        msg.routineId && msg.fireNumber != null
          ? { routineId: msg.routineId, fireNumber: msg.fireNumber }
          : undefined;
      if (coalesceKey != null && turnCoalescer.admit(coalesceKey, msg.data, coalesceMetadata)) {
        try {
          process.stderr.write(
            `psu-pty-host: duplicate queued turn FOLDED for ${ownerId} (same-source coalesce, P-001a)\n`,
          );
        } catch {
          /* diagnostic only */
        }
        // EI-19311270129974785: this delivery id IS being honored (folded into the
        // pending waiter's one write) — remember it so a later retry of THIS id
        // short-circuits instead of folding in a second time / racing a stale fold.
        if (msg.deliveryId) deliveryDedup.markCompleted(msg.deliveryId);
        return { ok: true, reason: 'coalesced-into-pending-turn' };
      }
      // EI-18679050054551625 (WI-5872 follow-up #2): everything from here down —
      // mutex acquire, the human-idle + agent-busy GATES, the actual pty write,
      // submit verification, and recycle/carry-respawn — can legitimately take
      // anywhere from milliseconds (an idle agent) to the FULL busy-gate cap
      // (production PAPERCUSP_PSU_PTY_BUSY_CAP_MS, or a multi-second recycle) to
      // resolve. The very first version of the ACK protocol awaited all of this
      // before acking, which meant injectIntoHost()'s default 2000ms client
      // timeout fired on almost every gated delivery, incl. ones that landed
      // perfectly (deferred-then-delivered, capped-then-dropped-but-durable,
      // etc) — the original 9/10-red regression this work item tracks. A first
      // pass fixed the two SLOWEST tails (verifySubmitted, recycleChild) to run
      // in the background, which was necessary but not sufficient: the GATE
      // WAIT itself (waitAtPrompt, up to the full busy cap) still blocked the
      // ack, which a still-red subset of this same test file's assertions
      // depend on NOT happening (each expects `ok` to resolve promptly —
      // representing "accepted for processing" — checked BEFORE the busy
      // window elapses, with the actual write/drop verified separately via the
      // captured pty output on its own timeline).
      //
      // So: ack 'accepted' HERE, before any gate/mutex/write runs, for any
      // message that reached this point (payload validated, correctly
      // addressed, not a coalesce-duplicate) — mirroring the coalesce fast-path
      // just above, which already returns immediately. Run the entire
      // mutex+gate+delivery pipeline as a detached background continuation;
      // every outcome it reaches (deferred/dropped/delivered/error) is already
      // durably recorded via appendHostEvent()/process.stderr.write() calls
      // inside it, exactly as a caller under the OLD bare-close-is-`true`
      // protocol would have had to learn it — from the durable event log or
      // the pty's own output, never from this ACK.
      const runGatedDelivery = async () => {
      // EI-8822: hold the per-host inject mutex across the ENTIRE gated
      // critical section (gate wait → pty write → submit verify) so a wake
      // `turn` and a session:request-compaction `/compact` freed at the SAME
      // clean boundary run one-at-a-time and never interleave into one input
      // line. Ungated raw/osc bypass it — a force-interrupt byte must land
      // immediately (mid-turn), and osc writes the display, not the input line.
      const releaseInject = msg.gated ? await injectMutex.acquire() : null;
      let deferMutexRelease = false;
      const deferForOwnerInput = (reason) => {
        const pendingLength = ownerComposerGate.pendingLength();
        const extra = {
          mode: msg.mode,
          reason,
          pendingLength,
          // WI-38156 forensics. A phantom line is distinguishable from a real
          // one by these two numbers alone: a person either finishes a line or
          // abandons it, so a line staged for a long time whose length never
          // moves and which has received no owner byte since is not a person.
          pendingAgeMs: ownerComposerGate.pendingAgeMs(),
          ownerQuietMs: ownerComposerGate.ownerQuietMs(),
        };
        appendHostEvent(ownerId, 'turn-deferred-for-owner-input', extra);
        noteOwnerInputDefer(pendingLength);
        try {
          process.stderr.write(
            `psu-pty-host: ${msg.mode} DEFERRED for ${ownerId} (${reason}) — ` +
              'owner has an unsubmitted input line; left in inbox for the next natural turn\n',
          );
        } catch {
          /* diagnostic only */
        }
        // P-001a: a deferred waiter must release its coalesce slot; a later wake
        // must be able to start a fresh delivery after the owner submits/cancels.
        if (coalesceKey != null) turnCoalescer.claim(coalesceKey);
        return { ok: false, reason: 'deferred-owner-input' };
      };
      try {
        if (msg.gated) {
          // (1) Human keystroke gate (P-013): don't corrupt a line the user is
          // mid-typing. Only meaningful when there IS a bridged terminal a human
          // could be typing into.
          if (bridgeTty) {
            const idle = await idleGate.waitIdle();
            if (idle.deferred) return deferForOwnerInput(idle.reason || 'idle-cap');
            // Idle is not submission. If the owner paused with text still in
            // the composer, wait for Enter/Ctrl-C/Ctrl-U, bounded like idle.
            if (ownerComposerGate.hasPending()) {
              // WI-38257: a staged line that has stopped tracking a person must not be
              // able to defer wakes forever. Checked BEFORE the wait, because the wait
              // is what burns the cap — that is where the 112s of dead agent came from.
              if (!breakComposerWedgeIfConfirmed()) {
                const clear = await ownerComposerGate.waitClear();
                if (clear.deferred) return deferForOwnerInput(clear.reason || 'owner-input-cap');
              }
            }
          }
          // (2) Agent mid-turn gate (coord-wake-mid-turn-2026-06-30 /
          // clean-boundary-only-kill WI-1818, D-006): don't write a wake `turn`
          // into a TUI that is still generating (wedges it, needs ESC), and —
          // load-bearing for `reset`/`recycle` — never KILL the current child
          // while it is mid-turn (an uncommitted in-flight turn would be lost;
          // the carry-note is only as fresh as the LAST settled turn). This check
          // is a pure read of the activity tracker, unrelated to TTY bridging, so
          // it applies UNCONDITIONALLY for every gated verb (bridgeTty or not) —
          // gating it on bridgeTty left reset/recycle unguarded whenever the host
          // ran without a bridged terminal.
          const verifiedBoundary = msg.mode === 'carry-respawn'
            ? () => codexCarryTurnCompleted({ agent: env.PAPERCUSP_AGENT, env,
              transcriptPath: msg.sourceTranscriptPath, receivedAtMs: msg.receivedAtMs })
            : msg.mode === 'turn'
              ? () => codexLatestTurnCompleted({
                  agent: env.PAPERCUSP_AGENT,
                  env,
                  completedAtOrAfterMs: Math.max(
                    Number(activity.snapshot().lastInputAt ?? 0),
                    lastMachineTurnSubmittedAtMs,
                  ),
                })
              : null;
          const atPrompt = await agentBusyGate.waitAtPrompt(undefined, verifiedBoundary);
          if (atPrompt.deferred) {
            // Agent stayed mid-turn past the cap. DROP the live inject/kill rather
            // than wedge the turn or lose in-flight work — the wake is already
            // durably in the recipient's inbox and is seen on its next natural
            // turn (queue-to-next-turn); a reset/recycle refused here simply never
            // fires this cycle (no partial kill, no data loss).
            try {
              process.stderr.write(
                `psu-pty-host: ${msg.mode} DEFERRED/REFUSED for ${ownerId} ` +
                  `(agent mid-turn > ${turnInjectBusyCapMs}ms cap); ` +
                  `left in inbox for the next natural turn\n`,
              );
            } catch {
              /* never let a diagnostic write break the session */
            }
            // EI-19480099650947832: record WHY the delivery could not fire, not
            // just that it didn't. `busy-gate-expired` alone cannot distinguish a
            // genuinely-busy agent (longest quiet gap ≈ 0ms — something is
            // redrawing the pty continuously) from a near-miss (gap ≈ quietMs —
            // the threshold is simply too tight), and those have OPPOSITE fixes.
            //
            // WI-2141048: this row is emitted for EVERY deferred mode, and is
            // deliberately NOT nested inside the carry-respawn branch below. It
            // used to be, which meant a `turn`/`reset`/`recycle` killed by this
            // gate left a stderr line and nothing durable — so a member that
            // booted and never took a turn was undiagnosable after the fact. A
            // census of the full ~/.papercusp/psu-pty event-log population
            // (6,795 logs, 2026-09-02) found 11,544 carry-respawn rows and ZERO
            // turn-mode siblings of any spelling, confirming the whole non-respawn
            // half of this gate was invisible. `mode` carries what the old
            // kind-name encoded, so this is one row per defer, never two.
            appendHostEvent(ownerId, 'busy-gate-expired', {
              mode: msg.mode,
              capMs: turnInjectBusyCapMs,
              observedMaxQuietMs: Number.isFinite(atPrompt?.maxQuietForMs) ? atPrompt.maxQuietForMs : null,
              quietMs: Number.isFinite(atPrompt?.quietMs) ? atPrompt.quietMs : null,
            });
            // EI-12655 (fix b, leader-concurred rider: "expired must FAIL LOUD")
            // + EI-12754 (the re-arm leg deferred out of that diff) + WI-5368/
            // WI-5530: a carry-respawn refused here previously vanished with ZERO
            // durable trace, then (post-EI-12655) terminally dropped on the FIRST
            // refusal — and, worse, a PRODUCTION (non-drill) respawn was never
            // even scheduled (this branch gated on `msg.drillId`), so every
            // busy-gate-deferred session:request-compaction was silently lost.
            // Now BOTH drill and production respawns re-queue exactly ONE deferred
            // retry at the next settled turn via makeCarryRearmController (which
            // emits the durable rearm-queued row and, on a second refusal or an
            // error, the terminal drop) — so op:'report' / op:'verify' always see
            // a durable outcome, and a busy-but-recovering session no longer loses
            // its respawn to one long turn. A duplicate schedule (a retry already
            // pending for this key) drops terminally here. The diagnostic row
            // above is emitted unconditionally; this branch owns only the
            // carry-respawn LIFECYCLE verdict (rearm-queued / superseded / drop).
            if (msg.mode === 'carry-respawn') {
              const rearmVerdict = carryRearm.schedule(msg);
              // EI-19480099650947832: a PRODUCTION respawn arriving while an
              // earlier one is still re-polling now SUPERSEDES it (the fresher
              // carry document wins) instead of being terminally dropped. This
              // row is deliberately NON-terminal: nothing was lost, the pending
              // re-poll simply adopted this payload, so op:'report'/'verify'
              // must keep waiting for that loop's own delivered/dropped row.
              if (rearmVerdict === 'superseded') {
                const supExtra = {
                  mode: 'carry-respawn',
                  reason: 'superseded-pending-rearm',
                  capMs: turnInjectBusyCapMs,
                };
                appendHostEvent(ownerId, 'respawn-rearm-superseded', supExtra);
                appendSharedDrillLedgerEvent(ownerId, 'respawn-rearm-superseded', supExtra);
              }
              if (rearmVerdict === 'duplicate') {
                const isDrill = !!msg.drillId;
                const dropKind = isDrill ? 'carry-drill-carry-dropped' : 'respawn-carry-dropped';
                const dropExtra = isDrill
                  ? {
                      drillId: msg.drillId,
                      sessionClass: msg.sessionClass ?? '',
                      reason: 'busy-gate-expired',
                      capMs: turnInjectBusyCapMs,
                      rearmed: true,
                    }
                  : {
                      mode: 'carry-respawn',
                      reason: 'busy-gate-expired',
                      capMs: turnInjectBusyCapMs,
                      rearmed: true,
                    };
                appendHostEvent(ownerId, dropKind, dropExtra);
                appendSharedDrillLedgerEvent(ownerId, dropKind, dropExtra);
              }
            }
            // P-001a: clear the coalesce slot on defer — wakes folded into this
            // waiter are dropped WITH it (same queue-to-next-turn semantics), and
            // later arrivals must start a fresh cycle, never fold into a dead one.
            if (coalesceKey != null) turnCoalescer.claim(coalesceKey);
            return { ok: false, reason: 'deferred-busy-gate' };
          }
          // WI-1386682 (2): don't spend a wake `turn`/`reset` inject into a
          // session sitting on Claude's own usage-limit wall. The pty is
          // quiet for the SAME reason a settled prompt is quiet — no output —
          // so the busy-gate above (agent-busy vs at-prompt) cannot tell them
          // apart and just cleared this message to proceed. Writing text+CR
          // into a walled screen is pure waste: the CR queues into the
          // composer (or is dropped outright) and verifySubmitted's later
          // resubmit CRs (WI-2930) are equally futile, all spent against an
          // agent that cannot answer until the wall lifts. Deferring here
          // uses the SAME queue-to-next-turn contract as the busy-gate defer
          // just above — nothing is lost, the message stays durably in the
          // recipient's inbox for a real turn once quota resets, a
          // recycle/respawn replaces the child, or the owner intervenes.
          // Scoped to turn/reset only: recycle/carry-respawn intentionally
          // still proceed even while walled — a walled session still
          // deserves the fresh child the owner asked for, and never letting
          // ANY submit path (including those) be host-fatal while
          // quota-blocked is prevented by the live submit-verifier gate — and
          // mcp-reconnect/raw/osc never reach this branch (already returned
          // above, or ungated).
          if ((msg.mode === 'turn' || msg.mode === 'reset') && quotaBlockDetector.isBlocked()) {
            const extra = { mode: msg.mode, reason: 'quota-blocked' };
            appendHostEvent(ownerId, 'turn-deferred-quota-blocked', extra);
            try {
              process.stderr.write(
                `psu-pty-host: ${msg.mode} DEFERRED for ${ownerId} (quota-blocked; ` +
                  `usage-limit banner on screen) — left in inbox for the next natural turn\n`,
              );
            } catch {
              /* diagnostic only */
            }
            if (coalesceKey != null) turnCoalescer.claim(coalesceKey);
            return { ok: false, reason: 'deferred-quota-blocked' };
          }
          // The agent gate above yields to the event loop. Re-check immediately
          // before the write in case the owner began composing during that wait.
          if (ownerComposerGate.hasPending()) {
            // WI-38257: a staged line that has stopped tracking a person must not be
            // able to defer wakes forever. Checked BEFORE the wait, because the wait
            // is what burns the cap — that is where the 112s of dead agent came from.
            if (!breakComposerWedgeIfConfirmed()) {
              const clear = await ownerComposerGate.waitClear();
              if (clear.deferred) return deferForOwnerInput(clear.reason || 'owner-input-cap');
            }
          }
        }
        // WI-5510: STALE-FIRE GUARD. Once a message has passed every gate above
        // and is ABOUT to be delivered, check + commit it against the last fire
        // number this host has delivered for its loop instance (routineId).
        // Placed here — after the busy-gate wait, before any write/recycle —
        // because this is the true "about to deliver" moment: a message that was
        // still gate-waiting while a LATER fire for the same loop already cleared
        // its own wait and delivered is exactly the stale-mid-turn-flush race
        // this guard exists to close (see makeStaleFireGuard's doc block). Only
        // messages carrying BOTH `routineId` + `fireNumber` (a loop-fire wake
        // from a WI-5510-aware sender) are guarded; an ordinary coord wake or
        // owner-typed injection (neither field set) always admits, unaffected.
        if (msg.fireNumber != null && msg.routineId) {
          const verdict = staleFireGuard.admit(msg.routineId, msg.fireNumber);
          if (!verdict.admit) {
            const dropExtra = {
              routineId: msg.routineId,
              fireNumber: msg.fireNumber,
              lastDelivered: verdict.lastDelivered,
              mode: msg.mode,
            };
            appendHostEvent(ownerId, 'stale-fire-dropped', dropExtra);
            try {
              process.stderr.write(
                `psu-pty-host: STALE fire #${msg.fireNumber} DROPPED for ${ownerId} ` +
                  `(routine ${msg.routineId} already delivered fire #${verdict.lastDelivered}; ` +
                  `mode:${msg.mode}) — superseded by a later fire, never written\n`,
              );
            } catch {
              /* diagnostic only */
            }
            // Same coalesce-slot hygiene as the busy-gate defer path just above —
            // a dropped waiter must release any same-source turn folded into it,
            // never black-hole it; a later arrival starts a fresh cycle.
            if (coalesceKey != null) turnCoalescer.claim(coalesceKey);
            return { ok: false, reason: 'stale-fire-dropped' };
          }
        }
        // EI-18109211232286833: CARRY-RESPAWN STALENESS GUARD. Placed here —
        // after every gate wait, immediately before the delivery it would
        // otherwise perform — because this is the true "about to deliver"
        // moment (same placement rationale as the stale-fire guard just
        // above): a carry-respawn is a snapshot of the world taken when it was
        // built, and one held this long by the busy-gate (+ its one
        // carryRearm re-arm) is no longer trustworthy even though it carries
        // no routineId/fireNumber for the stale-fire guard to catch.
        // EI-18665672258948707: SUPERSEDED GUARD, same placement — a later
        // respawn may have already fired on this host (e.g. the client-side
        // injectIntoHost() write for THIS message appeared to time out, the
        // calling agent retried, and the retry's carry-respawn already delivered
        // and spawned a real successor) while this message sat gate-waiting.
        // Unconditional on age: a superseded carry-respawn is never the right one
        // to deliver, however fresh. Checked separately from staleness so the
        // event log records the true reason.
        const superseded =
          msg.mode === 'carry-respawn' && isCarryRespawnSuperseded(msg.receivedAtMs, lastRespawnAtMs);
        const stale =
          !superseded &&
          msg.mode === 'carry-respawn' &&
          isCarryRespawnStale(msg.receivedAtMs, { maxAgeMs: carryRespawnMaxAgeMs });
        if (superseded || stale) {
          const ageMs = msg.receivedAtMs != null ? Date.now() - msg.receivedAtMs : null;
          const dropExtra = superseded
            ? { mode: 'carry-respawn', reason: 'superseded', ageMs, lastRespawnAtMs }
            : { mode: 'carry-respawn', reason: 'carry-stale', ageMs, maxAgeMs: carryRespawnMaxAgeMs };
          appendHostEvent(ownerId, 'respawn-carry-dropped', dropExtra);
          appendSharedDrillLedgerEvent(ownerId, 'respawn-carry-dropped', dropExtra);
          try {
            process.stderr.write(
              superseded
                ? `psu-pty-host: SUPERSEDED carry-respawn DROPPED for ${ownerId} ` +
                    `(a later respawn already fired at ${lastRespawnAtMs}, this message arrived ` +
                    `${msg.receivedAtMs}) — never delivered, would have discarded a live successor\n`
                : `psu-pty-host: STALE carry-respawn DROPPED for ${ownerId} ` +
                    `(age ${ageMs}ms > ${carryRespawnMaxAgeMs}ms cap) — never delivered\n`,
            );
          } catch {
            /* diagnostic only */
          }
          if (coalesceKey != null) turnCoalescer.claim(coalesceKey);
          return { ok: false, reason: superseded ? 'superseded' : 'carry-stale' };
        }
        // RECYCLE (su-cold-auto-mode P-004b): a hard cold reset — kill + respawn
        // the child in THIS host, then open the fresh process on the carry-note.
        // Codex RESET-CONTEXT is backend-aware: `/new` does not discard the
        // long-lived process context, so Codex reset envelopes take this same
        // hard path. The gate above already guaranteed a settled turn
        // (D-006 clean-boundary). Other reset/turn/raw/osc messages fall through
        // to the write plan below.
        const hardReset =
          msg.mode === 'recycle' ||
          msg.mode === 'carry-respawn' ||
          (msg.mode === 'reset' && coldResetModeForAgent(env.PAPERCUSP_AGENT) === 'recycle');
        if (hardReset) {
          // measured-agent-productivity P-004: a quota recovery is a durable
          // operation, not a fire-and-forget lifecycle request. The outer socket
          // already ACKed `accepted`, so waiting here does not hold the caller;
          // it only keeps this delivery id PENDING until the existing recycle
          // path has proved the successor's native turn start. A later retry then
          // sees completed dedup state, while wake-executor independently waits
          // for the same owner's first productive tool invocation.
          if (msg.mode === "recycle" && msg.quotaRecovery) {
            appendHostEvent(ownerId, "quota-recovery-started", {
              operationId: msg.quotaRecovery.operationId,
              recoveryOwnerId: msg.quotaRecovery.ownerId,
              startedAtMs: msg.quotaRecovery.startedAtMs,
              accountRoutingMode: "auto",
            });
            const recovery = await recycleChild(msg.data, {
              quotaRecovery: msg.quotaRecovery,
            });
            return recovery?.delivered
              ? { ok: true, reason: "quota-recovery-delivered" }
              : {
                  ok: false,
                  reason: `quota-recovery-${recovery?.reason ?? "failed"}`,
                };
          }
          // EI-18679050054551625 / WI-5872 follow-up: recycleChild() is a
          // multi-second operation by construction (kill the current child,
          // wait for it to die, respawn, wait for the fresh child's own
          // startup + busy period, then carry-inject once IT settles — the
          // sibling clean-boundary tests below deliberately budget 3+ seconds
          // for it to land). Awaiting it here before acking meant the ACK
          // protocol's round-trip routinely exceeded injectIntoHost()'s
          // default 2000ms client timeout, so a perfectly-accepted recycle
          // was reported back to the caller as `ok:false`. The busy-gate
          // above already made the accept/defer decision (a still-busy agent
          // took the 'deferred-busy-gate' return above and never reaches
          // here) — from this point recycleChild() proceeding is not in
          // question, so ack "delivered" now and let the kill+respawn+carry
          // run as a background continuation, same pattern as the turn/reset
          // verify-in-background fix just below. The inject mutex stays held
          // (deferMutexRelease) until that continuation actually finishes, so
          // a following gated inject still can't interleave mid-recycle.
          deferMutexRelease = true;
          const releaseAfterRecycle = releaseInject;
          void recycleChild(msg.data, {
            systemPromptAddendum:
              msg.mode === "carry-respawn" ? msg.systemPromptAddendum : "",
            drillId: msg.mode === "carry-respawn" ? msg.drillId : "",
            sessionClass: msg.mode === "carry-respawn" ? msg.sessionClass : "",
          })
            .catch(() => {})
            .finally(() => {
              if (releaseAfterRecycle) releaseAfterRecycle();
            });
          return { ok: true, reason: "delivered" };
        }
        // COMPACT — RETIRED (P-022, 2026-07-18): native compaction is removed
        // fleet-wide; carry-respawn above is the only context cut, and every
        // psu Claude child runs with DISABLE_COMPACT (the command doesn't even
        // exist to type). A mode:'compact' arriving here means a STALE
        // pre-P-022 sender is still running old code (the EI-16190 class: a
        // long-lived host process, e.g. bg-host, never restarted after the
        // cutover). Drop it LOUDLY — an absorbed stale message hid a broken
        // fleet enforcer for ~13h; a screaming one gets its sender restarted.
        if (msg.mode === 'compact') {
          appendHostEvent(ownerId, 'retired-mode-dropped', {
            mode: 'compact',
            hint: 'stale pre-P-022 sender still running (EI-16190) — find and restart it',
          });
          try {
            process.stderr.write(
              `psu-pty-host: mode:compact DROPPED for ${ownerId} — retired by P-022 (carry-respawn is the only ` +
                `context cut); a stale pre-cutover sender is still running (EI-16190): find and restart that process\n`,
            );
          } catch {
            /* diagnostic only */
          }
          return { ok: false, reason: 'retired-mode-dropped' };
        }
        // MCP-RECONNECT (mcp-transport-resilience P-003, 2026-07-13): drive the
        // claude TUI's /mcp dialog to re-attach a dead HTTP-MCP server IN PLACE.
        // The gates above already guaranteed a settled turn + quiet input line.
        // Claude-only: the dialog walker is pinned to the claude TUI; other
        // backends drop durably with an event-log row. Truth
        // of the heal is judged operator-side (presence beat, P-005) — the host
        // event is advisory.
        if (msg.mode === 'mcp-reconnect') {
          const agent = String(env.PAPERCUSP_AGENT || 'claude');
          if (agent !== 'claude') {
            appendHostEvent(ownerId, 'mcp-reconnect-dropped', {
              reason: 'unsupported-backend',
              backend: agent,
            });
            return { ok: false, reason: 'mcp-reconnect-unsupported-backend' };
          }
          const serverName = String(msg.data ?? '').trim() || 'papercusp-su';
          const tap = makeOutputTap();
          appendHostEvent(ownerId, 'mcp-reconnect-started', { serverName });
          try {
            const result = await runMcpReconnectMacro({
              serverName,
              write: (b) => child.write(b),
              readTap: tap.read,
              resetTap: tap.reset,
              crDelayMs: turnSubmitCrDelayForAgent(agent, env),
            });
            appendHostEvent(ownerId, result.ok ? 'mcp-reconnect-completed' : 'mcp-reconnect-failed', {
              serverName,
              step: result.step,
              detail: result.detail,
            });
            try {
              process.stderr.write(
                `psu-pty-host: mcp-reconnect ${result.ok ? 'OK' : 'FAILED'} for ${ownerId} ` +
                  `(${serverName}: ${result.step} — ${result.detail})\n`,
              );
            } catch {
              /* diagnostic only */
            }
            return { ok: result.ok, reason: result.ok ? 'delivered' : 'mcp-reconnect-failed', detail: result.detail };
          } finally {
            tap.close();
          }
        }
        // mode:'osc' targets the terminal DISPLAY — the host's stdout IS the
        // visible window — so a fleet:join recolors the LIVE window. Every other
        // mode targets the agent's stdin (a wake turn / a force-interrupt byte).
        const sink = msg.mode === 'osc' ? stdout : child;
        // Hold owner keystrokes that arrive during the deliberate text→CR
        // submit gap. Without this small delivery lease, a human can start a
        // new line after the envelope is written but before its CR, recreating
        // the same interleaving this composer gate prevents at the front door.
        const machineTurn = bridgeTty && (msg.mode === 'turn' || msg.mode === 'reset');
        if (machineTurn) {
          if (ownerComposerGate.hasPending()) {
            // WI-38257: a staged line that has stopped tracking a person must not be
            // able to defer wakes forever. Checked BEFORE the wait, because the wait
            // is what burns the cap — that is where the 112s of dead agent came from.
            if (!breakComposerWedgeIfConfirmed()) {
              const clear = await ownerComposerGate.waitClear();
              if (clear.deferred) return deferForOwnerInput(clear.reason || 'owner-input-cap');
            }
          }
          machineTurnActive = true;
          queuedOwnerInput = [];
        }
        // P-001a: claim the coalesce slot at delivery — later same-key arrivals
        // start a fresh cycle (they'll gate on the turn this write starts). The
        // claimed newest text replaces this waiter's own, annotated with the count.
        let deliver = msg;
        if (coalesceKey != null) {
          const claimed = turnCoalescer.claim(coalesceKey);
          if (claimed) {
            // The folded text is the newest loop fire, so carry its fire identity
            // forward too. Keeping the first envelope here would make the stale-
            // fire guard commit an older number for newer text.
            deliver = {
              ...msg,
              ...(claimed.metadata ?? {}),
              data: renderCoalescedTurn(claimed.data, claimed.folded),
            };
          }
        }
        // Deliver as ordered steps: a turn writes its text, THEN the submit CR as
        // a separate keystroke after a settle (controlWrites). A one-shot text+CR
        // burst is swallowed by the TUI's paste detector — the turn never submits
        // and the human has to press Enter.
        let machineTurnSubmitted = false;
        try {
          for (const step of controlWritesForAgent(deliver, env.PAPERCUSP_AGENT, env)) {
            if (step.delayMs > 0) await new Promise((r) => setTimeout(r, step.delayMs));
            if (msg.mode !== 'osc') quotaBlockDetector.observeInput(step.data);
            sink.write(step.data);
          }
          if (msg.mode === 'turn' || msg.mode === 'reset') lastMachineTurnSubmittedAtMs = Date.now();
          machineTurnSubmitted = machineTurn;
        } finally {
          if (machineTurn) {
            machineTurnActive = false;
            const ownerInput = queuedOwnerInput;
            queuedOwnerInput = [];
            if (machineTurnSubmitted) ownerComposerGate.markSubmitted();
            for (const input of ownerInput) {
              ownerComposerGate.observe(input);
              try {
                quotaBlockDetector.observeInput(input);
                child.write(input);
              } catch {
                /* child exit is handled by the normal host cleanup path */
              }
            }
          }
        }
        // WI-2930: a turn/reset submit targets the agent's stdin and must be
        // verified like the compact writes above (raw = control bytes and osc =
        // display bytes have no submit to verify).
        if (msg.mode === 'turn' || msg.mode === 'reset') {
          // EI-18679050054551625 / WI-5872 follow-up: verifySubmitted()'s poll
          // loop sleeps a FULL pollMs (default 5000ms, env
          // PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS) before its very first
          // check, and can run up to `polls` iterations resubmitting a CR —
          // it is a best-effort confirm-and-resubmit safety net, not a
          // precondition for a truthful "delivered" ack (the actual write
          // above already landed). Awaiting it here before acking meant the
          // ACK protocol's round-trip always exceeded injectIntoHost()'s
          // default 2000ms client timeout for every turn/reset delivery —
          // observed as 9/10 psu-pty-host-turn.integration.test.ts cases red,
          // each timing out at ~2000-2200ms despite the write having actually
          // succeeded (confirmed via trace instrumentation: the handler
          // reaches verifySubmitted and never returns before the client
          // gives up). Ack "delivered" now; let verify+resubmit run as a
          // background continuation, same pattern as the recycle/carry-
          // respawn fix above — the inject mutex stays held
          // (deferMutexRelease) until it finishes, preserving the "gate wait
          // -> pty write -> submit verify" one-at-a-time invariant.
          deferMutexRelease = true;
          const releaseAfterVerify = releaseInject;
          void verifySubmitted(`${msg.mode} inject`)
            .catch(() => {})
            .finally(() => {
              if (releaseAfterVerify) releaseAfterVerify();
            });
        }
        return { ok: true, reason: 'delivered' };
      } catch (err) {
        // P-001a: an error path must clear the coalesce slot too (claim is
        // idempotent — a no-op when the delivery already claimed it above).
        if (coalesceKey != null) turnCoalescer.claim(coalesceKey);
        // EI-10412: a lifecycle verb (compact/reset/recycle) dying here used to
        // vanish without a trace — for compact that silently killed the whole
        // auto-continuation. The swallow stays (child may have exited mid-inject;
        // the host must survive), but the outcome is now durably recorded.
        if (msg.mode === 'reset' || msg.mode === 'recycle') {
          appendHostEvent(ownerId, `${msg.mode}-inject-error`, {
            error: String((err && err.message) || err).slice(0, 300),
          });
        }
        // EI-18676244363359331 / WI-5872: this used to be a silent swallow for
        // every OTHER mode (turn/raw/osc/mcp-reconnect) too — the sender had no
        // way to learn a mid-delivery throw ever happened. Now folded into the
        // ACK below as a real outcome instead of a bare successful-looking close.
        return { ok: false, reason: 'error', error: String((err && err.message) || err).slice(0, 300) };
      } finally {
        // EI-8822: always free the inject mutex — on success, an early return
        // (defer/recycle/compact), OR a throw — so one inject never wedges the
        // queue behind an unreleased lock. EI-18679050054551625: skip it here
        // when deferMutexRelease is set — the turn/reset verify-in-background
        // or recycle/carry-respawn-in-background continuation above owns
        // releasing it once that continuation actually finishes, so the mutex
        // still covers the full "gate wait -> write/recycle -> verify" span.
        if (!deferMutexRelease && releaseInject) releaseInject();
      }
      };
      // EI-19311270129974785: the early ACK is only an acceptance commitment;
      // keep this id pending until the detached pipeline reaches its write/
      // recycle commitment, or clear it when the attempt is terminally refused.
      if (msg.deliveryId) deliveryDedup.markPending(msg.deliveryId);
      // Fire the gated pipeline and forget it (from the ACK's point of view) —
      // its own try/catch/finally above already handles every expected outcome
      // and durably records it; this outer .catch exists only so a genuinely
      // unexpected throw can never surface as an unhandled promise rejection.
      void runGatedDelivery()
        .then((deliveryOutcome) => {
          if (!msg.deliveryId) return;
          if (
            deliveryOutcome?.ok === true &&
            (deliveryOutcome.reason === "delivered" ||
              deliveryOutcome.reason === "quota-recovery-delivered")
          ) {
            deliveryDedup.markCompleted(msg.deliveryId);
          } else if (
            msg.mode === "carry-respawn" &&
            deliveryOutcome?.reason === "deferred-busy-gate"
          ) {
            // carryRearm.schedule() owns a live retry outside this promise; keep
            // the id pending so a client retry cannot race that re-arm.
            deliveryDedup.markPending(msg.deliveryId);
          } else {
            deliveryDedup.clearPending(msg.deliveryId);
          }
        })
        .catch((err) => {
          if (msg.deliveryId) deliveryDedup.clearPending(msg.deliveryId);
          try {
            process.stderr.write(
              `psu-pty-host: gated delivery pipeline threw for ${ownerId}: ` +
                `${String((err && err.message) || err).slice(0, 300)}\n`,
            );
          } catch {
            /* diagnostic only */
          }
        })
        .finally(() => {
          // EI-18681914950138372: this attempt has concluded one way or another
          // (delivered / dropped / errored / handed off to carryRearm.schedule's
          // own `pending` tracking) — clear the in-flight marker exactly once.
          // Safe even on hand-off: schedule() adds to `pending` synchronously
          // before this can fire, so pendingCount() never dips to 0 mid-transfer.
          if (msg.mode === 'carry-respawn') {
            carryRearm.endFirstAttempt(msg);
          }
        });
      // The host has accepted the request for processing, but has not yet
      // claimed that a turn started. The sender must keep the delivery durable
      // and retryable until the pipeline settlement above marks it completed.
      return { ok: true, reason: 'accepted' };
      })().catch((err) => ({
        ok: false,
        reason: 'unhandled-error',
        error: String((err && err.message) || err).slice(0, 300),
      }));
      // Write the ACK/NACK back on the STILL-OPEN connection (allowHalfOpen:true
      // above kept the writable side alive past the client's FIN) before we
      // close our end. Best-effort: a write/end failure here must never throw
      // out of this event handler and must never re-run any delivery — the real
      // work above already happened (or didn't) regardless of whether the ACK
      // itself makes it back.
      try {
        conn.write(`${JSON.stringify({ v: 1, ...outcome })}\n`);
      } catch {
        /* best-effort — the client's own timeout is the backstop */
      }
      try {
        conn.end();
      } catch {
        /* already closing */
      }
    });
  });
  server.on('error', (e) => process.stderr.write(`psu: control socket error: ${e.message}\n`));
  // Tight umask around bind so the node is never even briefly world-accessible,
  // then pin 0600 (owner-only). Shared by the initial bind and the WI-3455
  // self-heal re-bind (the sock path was unlinked while we were live).
  const listenControlSocket = () => {
    const prevUmask = process.umask(0o077);
    server.listen(sock, () => {
      try {
        chmodSync(sock, 0o600);
      } catch {
        /* best-effort */
      }
      try {
        process.umask(prevUmask);
      } catch {
        /* ignore */
      }
    });
  };
  listenControlSocket();
  // WI-3455: re-bind after the sock path was deleted out from under us. A unix
  // socket keeps LISTENING on the unlinked inode (unreachable — connectors get
  // ENOENT), so heal by closing the listener and re-listening on the same path.
  // net.Server supports listen-after-close; the connection handler is reused.
  rebindControlSocket = () => {
    try {
      server.close(() => {
        try {
          if (existsSync(sock)) unlinkSync(sock); // a dead successor's stray node would block bind
        } catch {
          /* ignore */
        }
        try {
          listenControlSocket();
        } catch (e) {
          process.stderr.write(`psu: control socket re-bind failed: ${e.message}\n`);
        }
      });
    } catch {
      /* close() throws only when already closed — nothing to heal then */
    }
  };

  // pty -> stdout (output bytes = the mid-turn signal, P-006). Re-attachable: a
  // RECYCLE (P-004b) spawns a fresh child and re-wires this bridge to it (node-pty
  // listeners are per-process). onStdin/onResize below read the live `child`
  // closure, so they need no re-wiring.
  wireChildData = () => {
    // WI-41386: one guard per child — it carries partial-escape state, so a
    // respawn must not inherit the dead child's tail.
    const scrollbackGuard = makeScrollbackGuard();
    if (headlessClaudeOnboardingExpiryTimer) {
      clearTimeout(headlessClaudeOnboardingExpiryTimer);
      headlessClaudeOnboardingExpiryTimer = null;
    }
    const headlessClaudeOnboarding = makeHeadlessClaudeOnboardingStateMachine({
      enabled: headlessClaudeOnboardingEnabled(env),
      startupMs: headlessClaudeOnboardingStartupMs(env),
    });
    if (headlessClaudeOnboarding.isActive()) {
      headlessClaudeOnboardingExpiryTimer = setTimeout(() => {
        const result = headlessClaudeOnboarding.expire();
        headlessClaudeOnboardingExpiryTimer = null;
        if (result.action === 'expired') {
          appendHostEvent(ownerId, 'headless-claude-onboarding-expired', {
            phase: result.phase,
            startupMs: headlessClaudeOnboardingStartupMs(env),
          });
        }
      }, headlessClaudeOnboardingStartupMs(env));
      if (typeof headlessClaudeOnboardingExpiryTimer.unref === 'function') {
        headlessClaudeOnboardingExpiryTimer.unref();
      }
    }
    child.onData((d) => {
      const raw = typeof d === 'string' ? d : String(d);
      if (!childStartupFirstOutputAt) childStartupFirstOutputAt = Date.now();
      childStartupOutput += raw;
      if (childStartupOutput.length > 65_536) childStartupOutput = childStartupOutput.slice(-32_768);
      const onboarding = headlessClaudeOnboarding.observe(raw);
      if (onboarding.action === 'submit') {
        try {
          // One raw CR per detected prompt. Do not use controlWritesForAgent:
          // there is no text paste to settle and a delayed write can leave the
          // wizard parked again.
          child.write('\r');
          appendHostEvent(ownerId, 'headless-claude-onboarding-advanced', {
            prompt: onboarding.prompt,
            phase: onboarding.phase,
          });
        } catch {
          /* the child-exit path owns teardown if it disappeared mid-answer */
        }
      } else if (onboarding.action === 'expired') {
        appendHostEvent(ownerId, 'headless-claude-onboarding-expired', {
          phase: onboarding.phase,
          startupMs: headlessClaudeOnboardingStartupMs(env),
        });
      }
      const resumeCompaction = claudeResumeCompaction.observe(raw);
      if (resumeCompaction.action === 'select-summary') {
        try {
          // Claude's first menu item is the safe summary recovery. Send exactly
          // one raw CR; this is a recovery choice, not a user turn, so it must
          // not go through controlWritesForAgent() or submit verification.
          child.write('\r');
          appendHostEvent(ownerId, 'claude-resume-compaction-summary-selected', {
            startupMs: claudeResumeCompactionStartupMs(env),
            recoveryMs: claudeResumeCompactionRecoveryMs(env),
          });
        } catch {
          /* the child-exit path owns teardown; recovery will expire loudly */
        }
      } else if (resumeCompaction.action === 'ready') {
        appendHostEvent(ownerId, 'claude-resume-compaction-ready', {});
      } else if (resumeCompaction.timedOut) {
        reportClaudeResumeCompactionTimeout();
      }
      if (!childStartupReady) {
        // A normal headless Claude boot remains byte-ready. Only a positively
        // identified theme screen turns readiness off until its Security screen
        // receives the second CR; otherwise every healthy launch would wait for
        // the full expiry window even when no wizard is present.
        childStartupReady = startupOutputReady(env.PAPERCUSP_AGENT, childStartupOutput);
      }
      if (onboarding.action === 'submit' && onboarding.prompt === 'theme') {
        childStartupReady = false;
      }
      // The generic Claude readiness heuristic intentionally accepts any output,
      // which is unsafe for the quiet resume-choice menu. Keep it blocked until
      // the recovery machine has seen a later standalone composer prompt.
      if (resumeCompaction.awaitingPrompt || resumeCompaction.timedOut) {
        childStartupReady = false;
      } else if (resumeCompaction.action === 'ready') {
        childStartupReady = true;
      }
      // WI-1386682 (1): feed the quota-wall detector the same raw bytes.
      const quotaTransition = quotaBlockDetector.observe(raw);
      if (quotaTransition) {
        // Publish the edge immediately. A static quota screen may never emit
        // another chunk to trigger the ordinary activity refresh.
        writeMeta();
        // WI-2140984: a bare detected/cleared row cannot distinguish a real
        // wall from a pattern hitting ordinary chrome, which is exactly how a
        // false positive cost a fleet leader an escalation. Carry the agent and
        // the matched text on the DETECTED edge (the cleared edge has none by
        // definition, and the per-deferral rows stay lean).
        const hit = quotaTransition === 'detected' ? quotaBlockDetector.lastMatch() : null;
        appendHostEvent(
          ownerId,
          quotaTransition === 'detected' ? 'quota-block-detected' : 'quota-block-cleared',
          hit
            ? {
                agent: String(env.PAPERCUSP_AGENT ?? '') || null,
                matchedPattern: hit.pattern,
                matchedExcerpt: hit.excerpt,
              }
            : {},
        );
      }
      activity.touchOutput();
      // Headless launchers keep the original raw PTY bytes on stdout for the
      // existing liveness/activity consumers, but also persist a bounded,
      // ANSI-free, CR-split companion so grep cannot expand one TUI frame into
      // an unbounded physical line.
      if (normalizedLog) normalizedLog.push(raw);
      // Everything else — readiness above, the output taps below — keeps seeing
      // the RAW stream; only what reaches the owner's terminal is guarded.
      stdout.write(scrollbackGuard.filter(raw));
      // P-003: feed any live output taps (mcp-reconnect macro screen reads).
      if (outputTaps.size > 0) {
        for (const t of outputTaps) {
          try {
            t(raw);
          } catch {
            /* a tap must never break the stdout bridge */
          }
        }
      }
    });
  };
  wireChildData();

  // stdin (raw) -> pty, tracking activity for the idle gate
  if (bridgeTty) {
    try {
      stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
  }
  if (typeof stdin.resume === 'function') stdin.resume();
  const onStdin = (d) => {
    const input = d.toString('utf8');
    // WI-38156: a bridged terminal answers the TUI's capability queries on the
    // SAME stdin that carries owner keystrokes, so "bytes arrived on stdin" is
    // NOT "a human is here". Classify first — an emulator's own reply must not
    // forge any of the three owner signals below, and `lastInputAt` in
    // particular is permanent: one reply makes shutdownRefusalReason answer
    // 'human-attended' for the life of the session, so every agent-launched
    // bridged host becomes un-shutdownable by tooling.
    // Conservative by construction: only unambiguous terminal-authored string
    // sequences are filtered, so arrow/function/keypad keys still count.
    if (ownerInputDetector.sawOwnerInput(input)) {
      ownerInputGeneration++;
      idleGate.touch();
      activity.touchInput();
      // owner-presence-human-turn-signal-2026-07-11 P-003: a real human keystroke into
      // a bridged terminal → stamp owner presence (throttled, fire-and-forget). Gated on
      // bridgeTty so only a genuine interactive TTY (never a headless piped session)
      // reports. Socket-injected agent wakes bypass stdin, so they never reach here.
      if (bridgeTty) reportOwnerHumanTurn();
    }
    if (bridgeTty) {
      if (machineTurnActive) {
        // The machine turn owns the current text→CR gap. Replay these bytes only
        // after its submit so owner input starts on the next terminal line.
        queuedOwnerInput.push(input);
        return;
      }
      ownerComposerGate.observe(input);
    }
    try {
      quotaBlockDetector.observeInput(input);
      child.write(input);
    } catch {
      /* ignore */
    }
  };
  stdin.on('data', onStdin);

  // terminal resize (SIGWINCH) -> pty resize
  const onResize = () => {
    const c = sanePtyDim(stdout.columns, 0, 1000);
    const r = sanePtyDim(stdout.rows, 0, 500);
    if (c && r) {
      try {
        child.resize(c, r);
      } catch {
        /* ignore */
      }
    }
  };
  if (typeof stdout.on === 'function') stdout.on('resize', onResize);

  return new Promise((resolve) => {
    let cleaned = false;
    let orphanTimer = null; // WI-3141 orphan watchdog; assigned below, cleared in cleanup
    let killChild = () => {};
    /**
     * WI-38054: the signal WE sent, recorded the moment we decide to tear the child
     * down. node-pty's own `signal` is preferred when it arrives, but the teardown
     * paths can complete without ever seeing an exit event (the child may already be
     * gone), and those are precisely the paths where "the session did not choose to
     * end" must still be recorded. Without this, a teardown reports a bare `0` and the
     * row asserts a clean voluntary exit.
     */
    let teardownSignal = null;
    /** WI-38292: set by the adopting path just before it runs `cleanup`, so the
     *  ordinary teardown does the whole release and only the FINAL step differs.
     *  `{ code, go }` — never a bare boolean: the successor's marching orders are
     *  already on disk by the time this is set, and `go` is what actually leaves. */
    let reexecRequested = null;
    const cleanup = (code, signal = null) => {
      if (cleaned) return;
      cleaned = true;
      const endedSignal = signal ?? teardownSignal;
      // A PTY leader can exit before its descendants. Reap the group while its
      // forkpty pgid is still unambiguous, then remove our signal listeners.
      killPtyProcessTree(child, 'SIGKILL');
      // A descendant can call setsid() and escape that pgid while remaining in
      // the session scope. On a GENUINE end of an agent-launched session, reap
      // the rest of that exact scope too. Reexec/recycle is continuation, and
      // an unmarked non-headless/shared scope is never ours to sweep.
      if (
        shouldReapDetachedPtyScopeResidue({
          bridgeTty,
          headless: String(env.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1',
          launchedBy: env.PAPERCUSP_LAUNCHED_BY,
          reexecRequested,
        })
      ) {
        try {
          const residue = reapScopeResidue({
            allowManagedScope: String(env.PAPERCUSP_PSU_HEADLESS ?? '').trim() === '1',
          });
          if (residue?.killedPids?.length || residue?.failedPids?.length) {
            process.stderr.write(
              `psu-pty-host: session scope cleanup for ${ownerId} killed ` +
                `${residue.killedPids?.length ?? 0} detached descendant(s)` +
                `${residue.failedPids?.length ? `; ${residue.failedPids.length} kill(s) failed` : ''}\n`,
            );
          }
        } catch (error) {
          // Group cleanup already ran and the host must still finish its durable
          // session-end record. Surface the residue failure without stranding exit.
          try {
            process.stderr.write(
              `psu-pty-host: session scope cleanup failed for ${ownerId}: ${error?.message ?? error}\n`,
            );
          } catch {
            /* terminal may already be closing */
          }
        }
      }
      try {
        signalSource.off?.('SIGINT', killChild);
        signalSource.off?.('SIGTERM', killChild);
        signalSource.off?.('SIGHUP', killChild);
      } catch {
        /* best-effort listener hygiene */
      }
      if (bridgeTty) {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        // WI-42458: returning stdin to cooked mode does NOT reset terminal-emulator
        // DEC modes. A child killed before its own teardown can leave SGR mouse
        // reporting armed, so the shell that inherits this terminal receives
        // ESC[<35;col;rowM on every mouse move. Final exit is a terminal handoff
        // just like recycle: restore the existing mode set and anchor below a
        // possibly half-drawn frame, but omit the restart marker because no
        // successor agent is being spawned. Keep this inside bridgeTty so a
        // headless session never writes terminal controls into its log stream.
        try {
          const handoff = respawnTerminalHandoffBytes({
            rows: sanePtyDim(stdout.rows, 0, 500) || undefined,
            separator: false,
          });
          if (handoff) stdout.write(handoff);
        } catch {
          /* a closing terminal is best-effort — cleanup must still finish */
        }
      }
      try {
        stdin.off?.('data', onStdin);
        stdin.pause?.();
      } catch {
        /* ignore */
      }
      try {
        stdout.off?.('resize', onResize);
      } catch {
        /* ignore */
      }
      try {
        clearInterval(activityTimer);
      } catch {
        /* ignore */
      }
      // The normalized companion is a separate diagnostic file descriptor.
      // Flush the final visible frame and close it on every terminal exit so
      // the last line is durable and a successor/test can reopen the path
      // without inheriting an open writer from this host.
      try {
        normalizedLog?.close();
      } catch {
        /* diagnostic side-channel cleanup must never block session teardown */
      }
      try {
        if (headlessClaudeOnboardingExpiryTimer) clearTimeout(headlessClaudeOnboardingExpiryTimer);
        headlessClaudeOnboardingExpiryTimer = null;
      } catch {
        /* ignore */
      }
      try {
        if (orphanTimer) clearInterval(orphanTimer);
      } catch {
        /* ignore */
      }
      // WI-3455: only remove the discovery key when it is still OURS. A
      // successor host that took over this ownerId re-registered the json with
      // ITS pid and re-bound the sock — unlinking them here would strand that
      // LIVE session (exactly the 2026-07-08 su-a8f52 stranding: a duplicate
      // host's exit deleted the original's key → no_live_pty_host on a live,
      // psu-hosted session). A missing/corrupt json means no registered
      // successor, so the sock is ours to remove; a json recording a DEAD other
      // pid is left for pruneDead/the janitor (their liveness test already
      // reads it as prunable). NOTE: server.close() must ALSO be skipped when
      // the key is owned by another host — libuv unlinks the server's bound
      // PATH on graceful close, even when that path now points at the
      // successor's re-bound socket node. unref() instead: the server stops
      // holding the event loop open (so an embedding process — a test — can
      // exit) and process exit reaps the fd WITHOUT unlinking the path.
      const registered = readDiscoveryMeta(ownerId);
      const ownedByOther = !!(registered && registered.pid && registered.pid !== process.pid);
      if (ownedByOther) {
        try {
          server.unref();
        } catch {
          /* ignore */
        }
      } else {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        for (const p of [sock, metaPath]) {
          try {
            if (existsSync(p)) unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }
      const finishExit = () => {
        // WI-38292: an ADOPTING exit is not the session ending — it is the same
        // session continuing in a fresh process that loaded current host code. It
        // must therefore leave by a different door: `onExit` records an ended
        // session (adv_sessions, killedBySignal), which would report this live
        // session as dead and hand the successor a grave to climb out of.
        // Everything ABOVE this point still ran: the child is reaped, the tty is
        // un-bridged and the discovery key + socket are released, in that order,
        // BEFORE the successor asserts them (host:2739 — a second host on a live
        // discovery key strands the first).
        if (reexecRequested) {
          resolve(reexecRequested.code);
          reexecRequested.go();
          return;
        }
        // `resolve` keeps its numeric contract for embedding callers; the signal rides
        // the onExit channel, which is the one that reaches the adv_sessions record.
        resolve(code ?? 0);
        onExit(code ?? 0, endedSignal);
      };
      if (managedKickoff && !managedKickoffDisposition) {
        void acknowledgeManagedKickoff({
          persisted: false,
          renderedHash: managedKickoff.renderedHash,
          error: `target child exited (${code ?? 0}) before native session-port persistence was verified`,
        }).catch((error) => {
          try { process.stderr.write(`psu: session-port failure acknowledgement failed: ${error?.message ?? error}\n`); }
          catch { /* diagnostics are best-effort */ }
        }).finally(finishExit);
      } else if (managedKickoffDisposition) {
        void managedKickoffDisposition.catch(() => undefined).finally(finishExit);
      } else {
        finishExit();
      }
    };
    // WI-41044: a verifier window that reaches its CR cap without observing any
    // output after a resubmit is a stranded submit, not a recoverable quiet
    // interval. End the whole managed host so the discovery key, socket, and
    // child subtree are released and the launcher records a nonzero outcome.
    terminateSubmitVerifyExhaustion = (details = {}) => {
      if (cleaned || submitVerifyExhausted) return false;
      submitVerifyExhausted = true;
      const extra = {
        label: details.label ?? 'submit',
        polls: details.polls ?? null,
        resubmits: details.resubmits ?? null,
        maxResubmits: details.maxResubmits ?? null,
        outputObservedAfterResubmit: Boolean(details.outputObservedAfterResubmit),
        reason: 'max-resubmits-without-output',
      };
      appendHostEvent(ownerId, 'submit-verify-exhausted', extra);
      try {
        process.stderr.write(
          `psu-pty-host: ${extra.label} submit verification exhausted for ${ownerId} ` +
            `after ${extra.resubmits ?? '?'} resubmit CRs — terminating host (WI-41044)\n`,
        );
      } catch {
        /* diagnostic only */
      }
      cleanup(1, 'SIGTERM');
      return true;
    };

    // Child-exit wiring, re-attachable for RECYCLE (P-004b). Double-guarded so a
    // recycle's intended kill never tears the host down: (1) `recycling` skips the
    // exit that IS the recycle kill; (2) the per-child capture skips a superseded
    // (already-recycled-away) child whose exit event arrives late. Only the CURRENT
    // child's genuine exit runs cleanup.
    wireChildExit = () => {
      const thisChild = child;
      thisChild.onExit(({ exitCode, signal }) => {
        if (recycling) return; // an intended recycle kill — respawn re-wires; host lives on
        if (child !== thisChild) return; // a superseded child that died late — ignore
        // WI-38054: `signal` MUST be read here. node-pty reports a signal death as
        // { exitCode: 0, signal: N } — MEASURED in this tree: SIGHUP -> {"exitCode":0,"signal":1}.
        // Destructuring only exitCode (as this did) throws away the sole evidence that
        // the session was killed, and the surviving 0 then travels all the way to
        // adv_sessions as a clean voluntary exit. Two of the owner's agents were reaped
        // by a sidecar restart and recorded as `ended_by='self', exit_code=0` this way.
        cleanup(exitCode, signalNameFromCode(signal));
      });
    };
    wireChildExit();

    // RECYCLE (su-cold-auto-mode P-004b): the periodic HARD cold reset in the
    // HYBRID cadence (D-002) — kill the child + fresh-spawn it in THIS same host
    // (same socket / SID / locks / hooks / env survive, D-003), then open the fresh
    // process on the carry-note. Only ever reached at a settled turn (the handler's
    // clean-boundary gate ran first, D-006). Serialized by `recycling`; fail-soft
    // (a spawn failure leaves the host running, carry stays in the inbox).
    recycleChild = async (
      carryText,
      { systemPromptAddendum = '', drillId = '', sessionClass = '', quotaRecovery = null } = {},
    ) => {
      const settleQuotaRecovery = (delivered, reason, extra = {}) => {
        if (quotaRecovery) {
          appendHostEvent(
            ownerId,
            delivered ? 'quota-recovery-ready' : 'quota-recovery-dropped',
            {
              operationId: quotaRecovery.operationId,
              recoveryOwnerId: quotaRecovery.ownerId,
              startedAtMs: quotaRecovery.startedAtMs,
              reason,
              ...extra,
            },
          );
        }
        return { delivered, reason };
      };
      if (recycling) return settleQuotaRecovery(false, 'recycle-already-running');
      recycling = true;
      // WI-5075 observability: the drill-only rows below made a WATCHDOG-initiated
      // carry-respawn (no drillId) completely invisible in the per-owner event log
      // — the P-018 successor-kill loop left ZERO durable trace outside journalctl.
      // Non-drill respawns now always leave generic respawned/failed/carry rows.
      const respawnMode = systemPromptAddendum ? 'carry-respawn' : 'recycle';
      // WI-38292: a respawn replaces the CLI child but NOT this host process, so a
      // host fix committed after this process booted stays inert here — the live
      // reproduction was a continuation fix (d351ee3084) that a running host simply
      // could not execute, which looked exactly like the fix not working. Nothing in
      // the process could report that, so the failure was invisible for its whole
      // lifetime. Record it at the respawn boundary, where a stale host is about to
      // decide the session's continuation and the mismatch actually changes outcomes.
      // Detection only: adoption is a separate, riskier change (a launcher re-exec),
      // and a silent-but-detectable staleness is strictly better than an undetected one.
      try {
        const hostCode = hostCodeStalenessFn();
        if (hostCode.stale) {
          appendHostEvent(ownerId, 'host-code-stale', {
            mode: respawnMode,
            loaded: hostCode.loaded,
            onDisk: hostCode.onDisk,
          });
        }
      } catch {
        /* diagnostic only — never block a respawn on the staleness probe */
      }
      // Assemble + persist the NEXT child's argv before killing the current one.
      // If carry-file creation fails, the settled current session remains alive
      // and its native/force-compaction backstops remain available.
      //
      // P-002 (stale-prompt-render-in-live-sessions-2026-08-02): re-render the base
      // persona FIRST, so the fresh path can be swapped into the argv below. Without
      // it, mintRecycleArgs copies `--system-prompt-file <predecessor's render>`
      // through verbatim and this session runs its FIRST launch's prompt forever —
      // 27 of 53 live sessions were up to 14 days stale when measured.
      //
      // Ordering: this runs BEFORE the kill, so a slow operator delays the respawn
      // rather than leaving the session dead while we wait. FAIL-SOFT: any failure
      // yields null and the successor keeps the inherited render — a stale prompt is
      // strictly better than a lost session — but it is RECORDED, never silent, so
      // a persistently-failing refresh is diagnosable instead of looking like the
      // bug this fixes.
      let personaFile = null;
      let personaRefreshReason = null;
      // Only claude has a `--system-prompt-file` to swap (codex carries its
      // instructions in CODEX_HOME/AGENTS.md, omp in its own launch-context env), so
      // skip the round-trip for a backend that could not use the answer. Skipped only
      // on an EXPLICIT non-claude value — an unset PAPERCUSP_AGENT still attempts the
      // refresh, because silently not refreshing is the failure mode being fixed.
      const agentHint = String(env.PAPERCUSP_AGENT ?? '').trim().toLowerCase();
      if (agentHint && agentHint !== 'claude') {
        personaRefreshReason = `unsupported-agent:${agentHint}`;
      } else {
        try {
          const refreshed = await refreshPersonaFile();
          personaFile = refreshed?.promptFile ?? null;
          personaRefreshReason = personaFile ? null : (refreshed?.reason ?? 'no-file');
        } catch (e) {
          personaFile = null;
          personaRefreshReason = `threw: ${e?.message ?? String(e)}`;
        }
      }
      // Record a refresh that did not happen, so a persistently-failing one is visible
      // rather than looking exactly like the staleness bug. The two EXPECTED skips
      // (a host with no refresh wired, a backend that has no prompt file to swap) are
      // not events — per-respawn noise for a known condition just buries real ones.
      if (
        !personaFile &&
        personaRefreshReason &&
        personaRefreshReason !== 'not-wired' &&
        !personaRefreshReason.startsWith('unsupported-agent')
      ) {
        appendHostEvent(ownerId, 'persona-refresh-skipped', {
          mode: respawnMode,
          reason: personaRefreshReason,
        });
      }
      let recycleArgs;
      let nativeId;
      let launchContextPath = null;
      let freshChildOwnerInputGeneration = null;
      try {
        const minted = systemPromptAddendum
          ? mintCarryRespawnArgs(args, {
              systemPromptAddendum,
              ownerId,
              agent: env.PAPERCUSP_AGENT,
              personaFile,
              codexHome: env.CODEX_HOME,
            })
          : mintRecycleArgs(args, { agent: env.PAPERCUSP_AGENT, personaFile });
        recycleArgs = minted.args;
        nativeId = minted.nativeId;
        launchContextPath = minted.launchContextPath ?? null;
      } catch (e) {
        if (drillId) {
          const failExtra = {
            drillId,
            sessionClass,
            reason: 'argv-build-failed',
            detail: e?.message ?? String(e),
          };
          appendHostEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
          appendSharedDrillLedgerEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
        } else {
          appendHostEvent(ownerId, 'respawn-failed', {
            mode: respawnMode,
            reason: 'argv-build-failed',
            detail: e?.message ?? String(e),
          });
        }
        try {
          // Once per boot: the watchdog re-sends every ~2min sweep, and a
          // deterministic build failure repeated verbatim into the session's
          // terminal is pure spam (owner-reported 2026-07-18, the resume-launch
          // mint gap). The event-log row above still records every attempt.
          if (!recycleChild.argvBuildFailWarned) {
            recycleChild.argvBuildFailWarned = true;
            process.stderr.write(
              `psu-pty-host: carry-respawn argv build failed for ${ownerId}: ${e.message} ` +
                `(further identical failures logged to the event log only)\n`,
            );
          }
        } catch {
          /* diagnostic only */
        }
        recycling = false;
        return settleQuotaRecovery(false, 'argv-build-failed');
      }
      // WI-38292 ADOPTION. A respawn is the ONLY safe moment to swap host code:
      // the session is being cut anyway, the successor's argv is already minted
      // and its carry is already on disk, so nothing in flight is lost. Take it
      // only when ALL of these hold — each is a way the swap could strand the
      // session rather than continue it:
      //   * the loaded host code really is behind the file on disk (increment 1);
      //   * something will actually RE-RUN us (`onReexec` is wired AND the shim
      //     advertised its loop) — without that, exiting just kills the session;
      //   * the successor's orders reached disk, so it boots into THIS session's
      //     carry instead of a bare prompt.
      // Any of them missing ⇒ fall through to the in-process respawn, which is
      // the pre-WI-38292 behaviour: a stale host, but a live one.
      // Interactive sessions must never hand the terminal back to the shim.
      // The shim's re-exec closes/reopens the launcher and can race the
      // successor handoff, which presents as a fresh bootstrap/wizard and an
      // apparent interruption to the owner.  Adoption is safe for headless
      // hosts (there is no human TTY to tear down); keep interactive hosts on
      // the in-process respawn path so the PTY, socket, and terminal remain
      // continuous even when git-sync updates this module on disk.
      // A quota recovery carries an in-flight delivery-id handshake in this
      // host's memory. Keep that one recycle in-process; adopting the host here
      // would throw away the pending/completed dedup state before the operator
      // can confirm pickup. Ordinary respawns still adopt current code exactly
      // as before.
      if (!quotaRecovery && shouldAdoptHostCode({ onReexec, reexecCode, bridgeTty })) {
        let hostCode = { stale: false };
        try {
          hostCode = hostCodeStalenessFn();
        } catch {
          /* a probe failure must never cost a respawn — stay on the old path */
        }
        if (hostCode.stale) {
          // The shim re-runs the launcher with its ORIGINAL environment, not
          // the local child environment assembled after bootstrap. Preserve
          // only the identity/configuration keys needed to reconstruct this
          // exact session; do not serialize the full environment (which may
          // contain unrelated credentials).
          const handoffEnv = {};
          for (const key of HOST_HANDOFF_ENV_KEYS) {
            const value = env[key];
            if (typeof value === 'string' && value.length > 0) handoffEnv[key] = value;
          }
          if (advSessionId != null && !handoffEnv.PAPERCUSP_ADV_SESSION_ID) {
            handoffEnv.PAPERCUSP_ADV_SESSION_ID = String(advSessionId);
          }
          const handoffPath = writeHostHandoff(ownerId, {
            mode: respawnMode,
            command,
            args: recycleArgs,
            cwd,
            nativeId: nativeId ?? null,
            advSessionId: advSessionId ?? env.PAPERCUSP_ADV_SESSION_ID ?? null,
            codexHome: env.CODEX_HOME ?? null,
            launchContextPath,
            // The successor builds its env from the shim's, not from ours, so the
            // deltas this respawn would have applied to the child have to travel
            // with the orders. P-018/P-022: a carry successor must not keep
            // Claude's native compactors, which would race the deterministic one.
            childEnv: {
              ...handoffEnv,
              ...(systemPromptAddendum
                ? { DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1' }
                : {}),
            },
            loaded: hostCode.loaded,
            onDisk: hostCode.onDisk,
            drillId: drillId || null,
            sessionClass: sessionClass || null,
          });
          if (handoffPath) {
            appendHostEvent(ownerId, 'host-code-adopting', {
              mode: respawnMode,
              loaded: hostCode.loaded,
              onDisk: hostCode.onDisk,
              handoffPath,
              nativeId: nativeId ?? null,
            });
            // P-022: a carry-respawn IS this member's context cut, whichever path
            // performs it. Peers wait on `session:compacted:<owner>`, and the
            // in-process path fires it AFTER respawning — a point this path never
            // reaches — so fire it here or every adopting cut goes unannounced.
            if (respawnMode === 'carry-respawn') {
              try {
                fireSessionCompactedEvent(ownerId, 'carry-respawn', { nativeId });
              } catch {
                /* announcing the cut must not be able to prevent it */
              }
            }
            // `cleanup` IS the release sequence — reap the child, un-bridge the
            // tty, drop the timers, then release the discovery key and socket.
            // Reused rather than re-implemented so the adopting path cannot drift
            // away from the ordering the ordinary exit already gets right.
            reexecRequested = {
              code: reexecCode,
              go: () => onReexec({ code: reexecCode, handoffPath, mode: respawnMode }),
            };
            cleanup(0);
            return;
          }
          // Orders did not reach disk. Respawning in place loses nothing (the
          // carry is still in the inbox) whereas exiting would drop it.
          appendHostEvent(ownerId, 'host-code-adopt-failed', {
            mode: respawnMode,
            reason: 'handoff-write-failed',
          });
        }
      }
      const priorDisableAutoCompact = env.DISABLE_AUTO_COMPACT;
      const priorDisableCompact = env.DISABLE_COMPACT;
      try {
        const dead = new Promise((res) => {
          try {
            child.onExit(() => res());
          } catch {
            res();
          }
        });
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        const exitedGracefully = await Promise.race([
          dead.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), RECYCLE_KILL_TIMEOUT_MS)),
        ]);
        if (!exitedGracefully) {
          // child.kill() sends the backend's graceful signal, but a CLI (or a
          // continuation helper it launched) can ignore it. Spawning after the
          // old cap without a hard tree kill creates two writers under the same
          // owner/SID — the cold-respawn duplicate-continuation failure. The
          // process group is this host's pty scope, so SIGKILL is the smallest
          // durable predecessor fence and also catches ordinary descendants.
          killPtyProcessTree(child, 'SIGKILL');
          await Promise.race([
            dead,
            new Promise((resolve) => setTimeout(resolve, RECYCLE_FORCE_KILL_WAIT_MS)),
          ]);
        }
        // Finish any visible text and discard a dangling escape sequence before
        // the successor child starts writing to the same companion artifact.
        if (normalizedLog) normalizedLog.flush();
        // WI-1980: a RECYCLE is a HARD cold reset — mint a FRESH --session-id so
        // we don't re-declare the prior child's already-on-disk id (which claude
        // rejects → boot-retry storm). env (PAPERCUSP_SID) is untouched, so coord
        // identity / locks / socket all survive; only the native claude id rotates.
        childStartupOutput = '';
        childStartupReady = false;
        childStartupFirstOutputAt = 0;
        // WI-1386682 (1): a fresh child has no screen history and cannot
        // inherit the old child's wall.
        quotaBlockDetector.reset();
        // Composer state belongs to the child that was just killed. Carrying a
        // staged-line bit across this hard process boundary can make every wake
        // to the healthy successor defer forever, even though that successor's
        // editor is empty. This does not discard live owner input: the old child
        // (and therefore its composer) is already gone at this point.
        ownerComposerGate.markSubmitted();
        // P-018: disable Claude Code's native AUTO compactor only on the fresh
        // child whose deterministic carry consumer is now installed. The old
        // child kept its native safety net right up to this successful cut.
        // P-022 adds DISABLE_COMPACT: a successor of a pre-cutover session
        // would otherwise inherit an env where /compact still exists.
        if (systemPromptAddendum) {
          env.DISABLE_AUTO_COMPACT = '1';
          env.DISABLE_COMPACT = '1';
        }
        // WI-41386: the predecessor is dead but the TERMINAL still carries its
        // state — a cursor parked mid-frame, and whatever modes a killed child
        // never reset. Hand the terminal over cleanly BEFORE the successor gets
        // to write a byte, or its boot render lands on top of the predecessor's
        // final frame and the owner loses the last screenful of scrollback at
        // every restart. Backend-agnostic on purpose (see
        // respawnTerminalHandoffBytes): a no-op for a clean exit, the only
        // rescue for a dirty one. Best-effort — a handoff write must never be
        // what breaks a respawn.
        try {
          const handoff = respawnTerminalHandoffBytes({
            rows: sanePtyDim(stdout.rows, 0, 500) || undefined,
            separator: env.PAPERCUSP_PSU_PTY_RESPAWN_SEPARATOR !== '0',
          });
          if (handoff) stdout.write(handoff);
        } catch {
          /* the terminal bridge is advisory — never let it break the respawn */
        }
        freshChildOwnerInputGeneration = systemPromptAddendum && agentHint === 'codex'
          ? ownerInputGeneration
          : null;
        child = spawnChild(recycleArgs);
        // Re-anchor the fresh native id → coord ownerId so a LATER untracked
        // resume still recovers this identity (else the 2026-07-02 orphaning bug
        // recurs). Fail-soft: onRespawn (recordSessionOwner) never throws.
        if (nativeId) {
          try {
            onRespawn(nativeId);
          } catch {
            /* anchoring is best-effort — never let it break the respawn */
          }
        }
        baseMeta.ptyPid = child.pid;
        writeMeta();
        wireChildData();
        wireChildExit();
        // WI-1818: mark THIS instant as fresh output activity so the carry-inject
        // retry loop below evaluates the FRESH child's own settledness, not stale
        // quiet-time inherited from the OLD (just-killed) child. Without this, a
        // pre-kill busy gate that had ALREADY been satisfied (the old child was
        // quiet for quietMs before the kill) leaves `lastOutputAt` stale by
        // (at least) quietMs the instant this fresh child boots — so the very
        // FIRST waitAtPrompt() call below could read that staleness as "already
        // at prompt" and inject the carry before the fresh child has emitted a
        // single byte, even one that will stay busy from its first tick.
        activity.touchOutput();
        // EI-18665672258948707: this respawn just genuinely happened — stamp the
        // supersession clock NOW (before the event-log/emit calls below, which
        // are not load-bearing for correctness) so any OTHER carry-respawn still
        // gate-waiting or pending a carryRearm retry, whose receivedAtMs predates
        // this instant, is recognized as superseded the next time it is checked.
        lastRespawnAtMs = Date.now();
      } catch (e) {
        if (systemPromptAddendum) {
          if (priorDisableAutoCompact === undefined) delete env.DISABLE_AUTO_COMPACT;
          else env.DISABLE_AUTO_COMPACT = priorDisableAutoCompact;
          if (priorDisableCompact === undefined) delete env.DISABLE_COMPACT;
          else env.DISABLE_COMPACT = priorDisableCompact;
        }
        try {
          process.stderr.write(`psu-pty-host: recycle spawn failed for ${ownerId}: ${e.message}\n`);
        } catch {
          /* never let a diagnostic write break the host */
        }
        if (drillId) {
          const failExtra = {
            drillId,
            sessionClass,
            reason: 'spawn-failed',
            detail: e?.message ?? String(e),
          };
          appendHostEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
          appendSharedDrillLedgerEvent(ownerId, 'carry-drill-respawn-failed', failExtra);
        } else {
          appendHostEvent(ownerId, 'respawn-failed', {
            mode: respawnMode,
            reason: 'spawn-failed',
            detail: e?.message ?? String(e),
          });
        }
        recycling = false;
        return settleQuotaRecovery(false, 'spawn-failed');
      }
      // EI-20287339148365013: a respawn REPLACES the agent, so any line staged
      // against the predecessor is stale BY DEFINITION — nobody is mid-sentence
      // to a process that no longer exists. Clearing it here makes the routine
      // event that already happens (a carry-respawn) double as the recovery the
      // wedge class never had.
      //
      // Measured 2026-08-12: su-f0c6fa5e carry-respawned at 22:56:00Z and its
      // successor deferred its very first wake 3 minutes later against the same
      // 11-char phantom the PREVIOUS agent had been stuck behind — the host
      // process, and therefore the composer model, outlive the agent. The owner
      // read that as "the bug isn't fixed"; it was the fix being unable to reach
      // a staged line nothing ever resets. This is also the ONLY lever that
      // helps without a relaunch: the pty-host is long-lived, so a code fix
      // reaches an existing host only at moments the host itself re-enters.
      const stagedAcrossRespawn = ownerComposerGate.hasPending()
        ? ownerComposerGate.pendingLength()
        : 0;
      if (stagedAcrossRespawn > 0) {
        // Ctrl-U to the CHILD first, then resync our own model — the same
        // ordering breakComposerWedgeIfConfirmed uses and for the same reason:
        // clearing only our model would leave the real composer holding text
        // that the next injected turn would then append to.
        try {
          child?.write('\u0015');
        } catch {
          /* the child is being replaced anyway */
        }
        ownerComposerGate.markSubmitted();
        appendHostEvent(ownerId, 'owner-composer-cleared-on-respawn', {
          pendingLength: stagedAcrossRespawn,
          respawnMode,
        });
      }
      if (drillId) {
        const respawnedExtra = {
          drillId,
          sessionClass,
          nativeId: nativeId ?? null,
          launchContextPath,
        };
        appendHostEvent(ownerId, 'carry-drill-respawned', respawnedExtra);
        appendSharedDrillLedgerEvent(ownerId, 'carry-drill-respawned', respawnedExtra);
      } else {
        appendHostEvent(ownerId, 'respawned', {
          mode: respawnMode,
          nativeId: nativeId ?? null,
          launchContextPath,
          // false = the successor boots with NO first prompt (P-010 answered case)
          // and waits for its loop/coord wake — expected, but worth seeing.
          firstPrompt: Boolean(carryText),
          capMs: recycleCarryInjectBudgetMs,
          // P-002: did this successor get a FRESH base persona, or inherit the
          // predecessor's render? The whole point of the fix, so it is observable
          // per respawn rather than inferable only from a prompt diff.
          personaRefreshed: Boolean(personaFile),
        });
      }
      // P-022: session:compacted:<owner> used to fire from the /compact handler's
      // completion path; with native compaction retired, a successful
      // carry-respawn IS this member's context cut — fire the same event here so
      // peers' `events:await { event: "session:compacted:<owner>" }` stays a live
      // surface instead of a key nothing emits anymore.
      if (respawnMode === 'carry-respawn') {
        fireSessionCompactedEvent(ownerId, 'carry-respawn', { nativeId });
      }
      recycling = false;
      if (!carryText) {
        if (drillId) {
          const dropExtra = {
            drillId,
            sessionClass,
            reason: 'no-first-prompt',
          };
          appendHostEvent(ownerId, 'carry-drill-carry-dropped', dropExtra);
          appendSharedDrillLedgerEvent(ownerId, 'carry-drill-carry-dropped', dropExtra);
        }
        return settleQuotaRecovery(false, 'no-first-prompt');
      }
      // Open the fresh process on the carry-note once it has booted to its prompt
      // (boot output quiesces → the agent-busy gate clears), via the shared
      // guaranteed-or-loudly-dropped delivery (WI-1941 — the old single-shot
      // waitAtPrompt dropped the iteration SILENTLY the instant it deferred,
      // leaving the session booted-but-idle with no trace until its next
      // scheduled wake). The carry also stays in the inbox as the last-resort
      // next-turn resume, so a drop is observable, not lossy.
      const recordCarryDrop = () => {
        baseMeta.lastCarryDropAt = Date.now();
        baseMeta.carryDropCount = (baseMeta.carryDropCount || 0) + 1;
        // A generic submit-verifier exhaustion may already have cleaned up the
        // host. Preserve the in-memory counter and durable event, but never
        // recreate a stale discovery file after cleanup removed it.
        if (!cleaned) writeMeta();
      };
      let carryResult = await injectTurnAtPrompt({
        text: carryText,
        label: drillId ? `carry-drill ${drillId} first prompt` : 'recycle carry-note',
        // A fresh child can be output-quiet before its input handler exists.
        // Apply the same backend-aware boot proof as a scripted resume/port.
        requireInitialOutput: true,
        freshChildOwnerInputGeneration,
        onDrop: recordCarryDrop,
      });
      let turnStartProof = null;
      // EI-21561923024113260: PTY output proves only that the successor painted
      // something. The incident had outputSeen:true and no user turn for 182s.
      // Production carry prompts carry a unique leading turn-origin marker and
      // a fresh native id, so require that exact pair in the fresh backend
      // transcript before emitting respawn-carry-delivered. Drills retain their
      // existing PTY-level contract because their synthetic payloads do not
      // necessarily carry turn provenance.
      if (!drillId && carryResult.delivered) {
        const proofWindowMs = Math.max(250, Math.floor(nativePersistenceTimeoutMs / 2));
        turnStartProof = await verifyNativeTurnStartWithRetry({
          agent: env.PAPERCUSP_AGENT,
          env,
          text: carryText,
          nativeId,
          requireNativeId: carryTurnProofRequiresNativeId(env.PAPERCUSP_AGENT),
          sinceMs: lastRespawnAtMs,
          timeoutMs: proofWindowMs,
          writeCr: () => child.write('\r'),
          onRetry: () => {
            appendHostEvent(ownerId, 'respawn-carry-turn-start-retry', {
              mode: respawnMode,
              nativeId,
              reason: 'native-turn-marker-timeout',
            });
          },
        });
        if (!turnStartProof.persisted) {
          recordCarryDrop();
          carryResult = { ...carryResult, delivered: false, reason: 'turn-start-unverified' };
          appendHostEvent(ownerId, 'turn-start-unverified', {
            mode: respawnMode,
            nativeId: nativeId ?? null,
            detail: turnStartProof.reason ?? 'native-turn-marker-timeout',
          });
          try {
            process.stderr.write(
              `psu-pty-host: carry turn start UNVERIFIED for ${ownerId} ` +
                `(native ${nativeId ?? 'unknown'}; ${turnStartProof.reason ?? 'marker timeout'}) — ` +
                `recording a drop, never respawn-carry-delivered\n`,
            );
          } catch {
            /* diagnostic only */
          }
        }
      }
      if (drillId) {
        // EI-12655 (drill-1 instrumentation, leader-concurred): a never-settled
        // drop was previously indistinguishable from a never-booted child.
        // budgetMs (the wall-clock the retry loop had) + outputSeen (did the
        // fresh child ever emit a startup byte) make the next occurrence
        // self-diagnosing: outputSeen:false ⇒ the child never became ready;
        // outputSeen:true + never-settled ⇒ continuous TUI output kept the
        // busy gate from ever seeing quietMs of silence.
        const terminalKind = carryResult.delivered
          ? 'carry-drill-carry-delivered'
          : 'carry-drill-carry-dropped';
        const terminalExtra = {
          drillId,
          sessionClass,
          nativeId: nativeId ?? null,
          reason: carryResult.delivered ? undefined : carryResult.reason,
          attempts: carryResult.attempts,
          budgetMs: recycleCarryInjectBudgetMs,
          outputSeen: childStartupOutput.length > 0,
        };
        appendHostEvent(ownerId, terminalKind, terminalExtra);
        appendSharedDrillLedgerEvent(ownerId, terminalKind, terminalExtra);
      } else {
        // EI-21859839880291755: this is the ONLY place a production
        // (non-drill) carry-respawn's terminal outcome is known — both the
        // genuine-success case (delivered:true) and a drop discovered only
        // here (e.g. reason:'turn-start-unverified', which can fire AFTER
        // the retry loop's own pre-recycle staleness/supersede check already
        // passed). Every OTHER production drop path (the pre-recycle
        // staleness/supersede check, and the retry loop's own carry-stale
        // check) mirrors its appendHostEvent call with
        // appendSharedDrillLedgerEvent so the box-wide shared ledger stays
        // aggregatable — this terminal one previously did not, so the shared
        // ledger (~/.papercusp/psu-pty/carry-drills.events.jsonl) was
        // STRUCTURALLY BLIND to every production delivery success and to
        // this drop reason: it could show hundreds of 'carry-stale'/
        // 'superseded' drops and ZERO 'respawn-carry-delivered' rows even on
        // a box where most respawns actually succeeded, because success was
        // logged only to each owner's PRIVATE per-owner log
        // (eventLogPathForOwner), never to the shared one. Measured
        // 2026-08-30: 36,162 respawn-carry-delivered rows exist across
        // per-owner logs while the shared ledger showed 0 in its 48h window
        // — an investigation reading only the shared ledger concluded
        // "fleet-wide carry-respawn starvation" from what was actually just
        // this asymmetric-logging gap. Mirroring the call here (matching the
        // drill branch just above, which has always logged both) closes it.
        const terminalExtra = {
          mode: respawnMode,
          nativeId: nativeId ?? null,
          reason: carryResult.delivered ? undefined : carryResult.reason,
          attempts: carryResult.attempts,
          outputSeen: childStartupOutput.length > 0,
          turnStartVerified: turnStartProof ? Boolean(turnStartProof.persisted) : undefined,
          nativeRef: turnStartProof?.nativeRef ?? undefined,
        };
        const terminalKind = carryResult.delivered ? 'respawn-carry-delivered' : 'respawn-carry-dropped';
        appendHostEvent(ownerId, terminalKind, terminalExtra);
        appendSharedDrillLedgerEvent(ownerId, terminalKind, terminalExtra);
      }
      return settleQuotaRecovery(
        Boolean(carryResult.delivered),
        carryResult.delivered ? 'turn-start-verified' : (carryResult.reason ?? 'carry-dropped'),
        {
          nativeId: nativeId ?? null,
          nativeRef: turnStartProof?.nativeRef ?? null,
          attempts: carryResult.attempts,
        },
      );
    };

    // Raw-mode keyboard Ctrl-C remains a byte forwarded to the target. A real
    // process SIGINT (outer terminal/executor interrupt) is teardown, just like
    // SIGHUP/SIGTERM: kill the whole forkpty group so no backend descendant can
    // survive and serialize the managed-port failure receipt immediately.
    killChild = () => {
      // WI-38054: record the teardown BEFORE sending it. This host is being torn down
      // (its own SIGINT/SIGTERM/SIGHUP), so whatever happens next, the session did not
      // choose to end — without this, a teardown that reaches cleanup through the
      // child-exit path can report a bare 0 indistinguishable from a clean exit.
      teardownSignal = 'SIGHUP';
      // External fleet:kill can SIGKILL this host before node-pty delivers the
      // child's exit event. Run cleanup now so detached VTE-scope descendants are
      // reaped even when the child is slow to report its exit. cleanup() performs
      // the forceful process-tree kill as its first step, preserving the existing
      // SIGHUP -> SIGKILL ordering without waiting on child.onExit.
      killPtyProcessTree(child, 'SIGHUP');
      cleanup(0, 'SIGHUP');
    };
    signalSource.on?.('SIGINT', killChild);
    signalSource.on?.('SIGTERM', killChild);
    signalSource.on?.('SIGHUP', killChild);

    // ── Orphan / vanished-terminal teardown (WI-3141) ──────────────────────────
    // A managed-pty host must NOT outlive the interactive terminal it bridges.
    // SIGHUP (above) is the nominal "terminal closed" signal, but a WSL/console-
    // session teardown can reparent psu to init WITHOUT delivering it — leaving a
    // host that keeps its child alive and keeps forwarding the child's output to a
    // /dev/pts fd the OS has since recycled to the owner's NEXT terminal (the
    // 2026-07-05 "random characters appear without typing" report). So the moment
    // the human is gone, kill the child and exit — hard, not the soft SIGTERM
    // killChild uses, since an orphan may be forwarding a wedged/looping child.
    // Only engaged for a real interactive TTY bridge (bridgeTty): a non-tty
    // (piped/programmatic) host has no terminal to spam and treats stdin EOF as
    // ordinary end-of-input, so these guards would be wrong there.
    if (bridgeTty) {
      const teardownOrphan = (why) => {
        if (cleaned) return;
        try {
          process.stderr.write(
            `psu-pty-host: session orphaned (${why}) for ${ownerId} — killing child + exiting\n`,
          );
        } catch {
          /* the terminal we'd warn on may be the very one that vanished */
        }
        try {
          teardownSignal = 'SIGHUP'; // WI-38054 — an orphan teardown is a kill, not an exit
          killPtyProcessTree(child, 'SIGHUP');
          killPtyProcessTree(child, 'SIGKILL');
        } catch {
          /* already gone */
        }
        cleanup(0, 'SIGHUP');
      };

      // (1) The bridged TTY going EOF / closed / errored = the terminal vanished.
      stdin.once?.('end', () => teardownOrphan('stdin-eof'));
      stdin.once?.('close', () => teardownOrphan('stdin-close'));
      stdin.on?.('error', () => teardownOrphan('stdin-error'));
      // A write error on our stdout (EIO/EPIPE) = the terminal is gone. Wiring a
      // listener also keeps a stray write error from throwing uncaught.
      if (typeof stdout.on === 'function') stdout.on('error', () => teardownOrphan('stdout-error'));

      // (2) Parent-death watchdog — catches the case the pts stays ALIVE (a fresh
      // shell took over the same /dev/pts number, so stdin never hits EOF) but the
      // shell that LAUNCHED psu has died: the exact 2026-07-05 orphan (ppid→init).
      // Only a TRANSITION to init counts; a host already under init at launch (a
      // service/nohup start) is left alone.
      let initialParentPid = 1;
      try {
        initialParentPid = parentPidFn();
      } catch {
        /* if we can't read ppid, skip the watchdog (the EOF guards still apply) */
      }
      if (initialParentPid && initialParentPid !== 1) {
        orphanTimer = setInterval(() => {
          let ppid = initialParentPid;
          try {
            ppid = parentPidFn();
          } catch {
            return; // transient read failure — try again next tick
          }
          if (ppid === 1) teardownOrphan('parent-exited');
        }, ORPHAN_POLL_MS);
        if (typeof orphanTimer.unref === 'function') orphanTimer.unref();
      }
    }
  });
}

/**
 * Bounded, explicitly local recovery for the `psu` launcher.
 *
 * The operator is deliberately not a dependency of this module. An owner at a
 * real local terminal authorizes one exact argv vector; the resulting grant is
 * HMAC-bound to that argv/cwd/terminal and atomically consumed once. Recovery
 * evidence is appended under ~/.papercusp/recovery and reconciled later by the
 * ordinary launcher path when the operator is reachable again.
 */
import { spawn as nodeSpawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

export const RECOVERY_PROTOCOL_VERSION = 1;
export const RECOVERY_CAPABILITY_DIAGNOSTIC = "diagnostic-command";
export const DEFAULT_RECOVERY_TTL_MS = 5 * 60_000;
export const MAX_RECOVERY_TTL_MS = 15 * 60_000;
export const DEFAULT_RECOVERY_RUNTIME_MS = 60_000;
export const MAX_RECOVERY_RUNTIME_MS = 5 * 60_000;
export const MIN_RECOVERY_RUNTIME_MS = 100;
export const RECOVERY_RECONCILE_BATCH = 100;

const GRANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARGV = 64;
const MAX_ARG_BYTES = 4_096;
const MAX_ARGV_BYTES = 32_768;
const MAX_REASON_BYTES = 2_000;
const FUTURE_SKEW_MS = 30_000;

export function recoveryPaths(home = homedir()) {
  const root = join(home, ".papercusp", "recovery");
  return {
    root,
    grants: join(root, "grants"),
    consumed: join(root, "consumed"),
    audit: join(root, "audit.jsonl"),
  };
}

function ensureOwnerDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`recovery path is not a real directory: ${path}`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`recovery path is not owned by the current user: ${path}`);
  }
  chmodSync(path, 0o700);
}

function ensureRecoveryStore(home) {
  const paths = recoveryPaths(home);
  ensureOwnerDirectory(paths.root);
  ensureOwnerDirectory(paths.grants);
  ensureOwnerDirectory(paths.consumed);
  return paths;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateToken(token) {
  const value = String(token ?? "").trim();
  if (value.length < 16) {
    throw new Error("local recovery requires the installed owner superuser token");
  }
  return value;
}

function unsignedGrant(grant) {
  const { signature: _signature, ...unsigned } = grant;
  return unsigned;
}

function signGrant(grant, token) {
  return createHmac("sha256", validateToken(token))
    .update(stableJson(unsignedGrant(grant)))
    .digest("base64url");
}

function signaturesEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const supplied = Buffer.from(a, "utf8");
  const expected = Buffer.from(b, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function currentIdentity() {
  let username = "unknown";
  let uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    const info = userInfo();
    username = info.username || username;
    if (Number.isInteger(info.uid)) uid = info.uid;
  } catch {
    // The numeric uid and hostname still leave a useful local identity record.
  }
  return { uid, username, hostname: hostname() || "unknown" };
}

function validIdentity(value) {
  return Boolean(
    value &&
      (value.uid === null || Number.isSafeInteger(value.uid)) &&
      typeof value.username === "string" &&
      value.username.length > 0 &&
      value.username.length <= 256 &&
      typeof value.hostname === "string" &&
      value.hostname.length > 0 &&
      value.hostname.length <= 256,
  );
}

function validArgv(argv) {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= MAX_ARGV &&
    argv.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length > 0 &&
        !arg.includes("\0") &&
        Buffer.byteLength(arg) <= MAX_ARG_BYTES,
    ) &&
    Buffer.byteLength(argv.join("\0")) <= MAX_ARGV_BYTES
  );
}

function validGrant(value) {
  return Boolean(
    value &&
      value.version === RECOVERY_PROTOCOL_VERSION &&
      typeof value.grantId === "string" &&
      GRANT_ID_RE.test(value.grantId) &&
      value.capability === RECOVERY_CAPABILITY_DIAGNOSTIC &&
      validArgv(value.argv) &&
      isAbsolute(value.argv[0]) &&
      typeof value.cwd === "string" &&
      isAbsolute(value.cwd) &&
      typeof value.reason === "string" &&
      value.reason.trim().length > 0 &&
      Number.isSafeInteger(value.issuedAtMs) &&
      Number.isSafeInteger(value.expiresAtMs) &&
      Number.isSafeInteger(value.maxRuntimeMs) &&
      value.maxRuntimeMs >= MIN_RECOVERY_RUNTIME_MS &&
      value.maxRuntimeMs <= MAX_RECOVERY_RUNTIME_MS &&
      value.expiresAtMs > value.issuedAtMs &&
      value.expiresAtMs - value.issuedAtMs <= MAX_RECOVERY_TTL_MS &&
      value.maxRuntimeMs <= value.expiresAtMs - value.issuedAtMs &&
      value.maxUses === 1 &&
      typeof value.terminalId === "string" &&
      value.terminalId.length > 0 &&
      validIdentity(value.identity) &&
      value.client?.name === "psu" &&
      typeof value.client?.version === "string" &&
      value.client.version.length > 0 &&
      typeof value.signature === "string",
  );
}

function defaultResolveExecutable(command, { cwd, env = process.env } = {}) {
  const candidate = String(command ?? "");
  const direct = candidate.includes("/") || candidate.includes("\\");
  if (direct) {
    const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const real = realpathSync(path);
    if (!statSync(real).isFile()) throw new Error(`recovery executable is not a file: ${real}`);
    return real;
  }
  for (const dir of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, candidate);
    try {
      const real = realpathSync(path);
      const st = statSync(real);
      if (st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0)) return real;
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`recovery executable not found on PATH: ${candidate}`);
}

function validateIssueInput(input) {
  if (input?.capability !== RECOVERY_CAPABILITY_DIAGNOSTIC) {
    throw new Error(`unsupported recovery capability: ${String(input?.capability ?? "missing")}`);
  }
  if (!validArgv(input.argv)) throw new Error("recovery argv must contain 1-64 bounded non-empty arguments");
  const reason = String(input.reason ?? "").trim();
  if (!reason || Buffer.byteLength(reason) > MAX_REASON_BYTES) {
    throw new Error("recovery reason must contain 1-2000 bytes");
  }
  const ttlMs = input.ttlMs ?? DEFAULT_RECOVERY_TTL_MS;
  const maxRuntimeMs = input.maxRuntimeMs ?? DEFAULT_RECOVERY_RUNTIME_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_RECOVERY_TTL_MS) {
    throw new Error(`recovery ttl must be a whole number from 1-${MAX_RECOVERY_TTL_MS}ms`);
  }
  if (
    !Number.isSafeInteger(maxRuntimeMs) ||
    maxRuntimeMs < MIN_RECOVERY_RUNTIME_MS ||
    maxRuntimeMs > MAX_RECOVERY_RUNTIME_MS
  ) {
    throw new Error(
      `recovery max runtime must be a whole number from ${MIN_RECOVERY_RUNTIME_MS}-${MAX_RECOVERY_RUNTIME_MS}ms`,
    );
  }
  if (maxRuntimeMs > ttlMs) throw new Error("recovery max runtime cannot exceed its grant ttl");
  return { reason, ttlMs, maxRuntimeMs };
}

function grantPath(paths, grantId, kind = "grants") {
  if (!GRANT_ID_RE.test(String(grantId ?? ""))) throw new Error("invalid recovery grant id");
  return join(paths[kind], `${grantId}.json`);
}

function appendRecoveryAuditRow(row, { home = homedir() } = {}) {
  const paths = ensureRecoveryStore(home);
  appendFileSync(paths.audit, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  chmodSync(paths.audit, 0o600);
  return paths.audit;
}

function auditEvent(grant, event, atMs, detail = {}) {
  return {
    version: RECOVERY_PROTOCOL_VERSION,
    eventId: randomUUID(),
    event,
    at: new Date(atMs).toISOString(),
    atMs,
    grantId: grant.grantId,
    capability: grant.capability,
    identity: grant.identity,
    client: grant.client,
    reason: grant.reason,
    command: { argv: grant.argv, cwd: grant.cwd },
    ...detail,
  };
}

function refusalAudit(grantId, reason, atMs, opts = {}) {
  const identity = opts.identity ?? currentIdentity();
  return {
    version: RECOVERY_PROTOCOL_VERSION,
    eventId: randomUUID(),
    event: "execution-refused",
    at: new Date(atMs).toISOString(),
    atMs,
    grantId: String(grantId),
    capability: RECOVERY_CAPABILITY_DIAGNOSTIC,
    identity,
    client: { name: "psu", version: opts.clientVersion ?? "unknown" },
    reason: "recovery execution refused",
    command: { argv: [], cwd: "" },
    outcome: { refusalReason: reason },
  };
}

export function issueRecoveryGrant(input, opts = {}) {
  const { reason, ttlMs, maxRuntimeMs } = validateIssueInput(input);
  const token = validateToken(opts.token);
  const terminalId = String(opts.terminalId ?? "").trim();
  if (!terminalId) throw new Error("recovery authorization requires a terminal identity");
  const nowMs = opts.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("invalid recovery issue time");
  const cwd = realpathSync(String(input.cwd ?? process.cwd()));
  if (!statSync(cwd).isDirectory()) throw new Error(`recovery cwd is not a directory: ${cwd}`);
  const resolveExecutable = opts.resolveExecutable ?? defaultResolveExecutable;
  const executable = resolveExecutable(input.argv[0], { cwd, env: opts.env ?? process.env });
  if (!isAbsolute(executable)) throw new Error("recovery executable resolver must return an absolute path");
  const identity = opts.identity ?? currentIdentity();
  if (!validIdentity(identity)) throw new Error("invalid local recovery identity");
  const grant = {
    version: RECOVERY_PROTOCOL_VERSION,
    grantId: opts.grantId ?? randomUUID(),
    capability: input.capability,
    argv: [executable, ...input.argv.slice(1)],
    cwd,
    reason,
    issuedAt: new Date(nowMs).toISOString(),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    maxRuntimeMs,
    maxUses: 1,
    terminalId,
    identity,
    client: { name: "psu", version: String(opts.clientVersion ?? "unknown") || "unknown" },
  };
  if (!GRANT_ID_RE.test(grant.grantId)) throw new Error("invalid generated recovery grant id");
  const signed = { ...grant, signature: signGrant(grant, token) };
  const paths = ensureRecoveryStore(opts.home ?? homedir());
  const path = grantPath(paths, signed.grantId);
  writeFileSync(path, `${JSON.stringify(signed)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  try {
    appendRecoveryAuditRow(auditEvent(signed, "authorized", nowMs), { home: opts.home });
  } catch (error) {
    try { unlinkSync(path); } catch { /* leave the original audit failure as the error */ }
    throw error;
  }
  return signed;
}

function readClaimedGrant(grantId, opts = {}) {
  const paths = ensureRecoveryStore(opts.home ?? homedir());
  const pending = grantPath(paths, grantId, "grants");
  const consumed = grantPath(paths, grantId, "consumed");
  try {
    const st = lstatSync(pending);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, reason: "unsafe-grant-file" };
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      return { ok: false, reason: "unsafe-grant-owner" };
    }
    // link(2) is the no-replace consume claim: unlike rename(2), it cannot
    // overwrite an existing consumed receipt and accidentally re-enable reuse.
    linkSync(pending, consumed);
    unlinkSync(pending);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, reason: existsSync(consumed) ? "already-consumed" : "not-found" };
    }
    if (error?.code === "EEXIST") return { ok: false, reason: "already-consumed" };
    return { ok: false, reason: "claim-failed", error };
  }
  try {
    return { ok: true, grant: JSON.parse(readFileSync(consumed, "utf8")) };
  } catch (error) {
    return { ok: false, reason: "malformed-grant", error };
  }
}

function verifyClaimedGrant(grant, { token, nowMs, terminalId }) {
  if (!validGrant(grant)) return { ok: false, reason: "invalid-grant" };
  const expected = signGrant(grant, token);
  if (!signaturesEqual(grant.signature, expected)) return { ok: false, reason: "bad-signature" };
  if (grant.issuedAtMs > nowMs + FUTURE_SKEW_MS) return { ok: false, reason: "not-yet-valid" };
  if (nowMs >= grant.expiresAtMs) return { ok: false, reason: "expired" };
  if (grant.terminalId !== terminalId) return { ok: false, reason: "terminal-mismatch" };
  return { ok: true };
}

const SECRET_ENV_RE = /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)$/i;
const RECOVERY_IDENTITY_KEYS = new Set([
  "PAPERCUSP_SID",
  "PAPERCUSP_ADV_SESSION_ID",
  "PAPERCUSP_AGENT_SESSION",
  "PAPERCUSP_FLEET_SLUG",
  "PAPERCUSP_FLEET_ROLE",
  "PAPERCUSP_AUTO_MODE",
  "PAPERCUSP_DRAIN_MODE",
  "PAPERCUSP_TTY",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
]);

export function sanitizeRecoveryEnvironment(env = process.env) {
  const safeKeys = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "TZ",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PAPERCUSP_RECOVERY_")) continue;
    if (RECOVERY_IDENTITY_KEYS.has(key)) continue;
    if (SECRET_ENV_RE.test(key)) continue;
    if (safeKeys.has(key) || key.startsWith("LC_")) out[key] = value;
  }
  return out;
}

/** Recovery authority never crosses into an ordinary psu launch/resume/wake. */
export function stripRecoveryMarkers(env = process.env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.startsWith("PAPERCUSP_RECOVERY_")) delete out[key];
  }
  return out;
}

export function renderRecoveryBanner(grant) {
  return [
    "================================================================================",
    "PAPERCUSP NATIVE RECOVERY MODE — CONTROL PLANE BYPASSED",
    `Grant: ${grant.grantId} · capability: ${grant.capability}`,
    `Expires: ${new Date(grant.expiresAtMs).toISOString()} · max runtime: ${grant.maxRuntimeMs}ms · uses: 1`,
    `Reason: ${grant.reason}`,
    `Command argv: ${JSON.stringify(grant.argv)}`,
    "Local append-only audit is active and will reconcile when the operator returns.",
    "================================================================================",
  ].join("\n");
}

export function executeExactRecoveryCommand(
  { file, args, cwd, env, timeoutMs },
  { spawnImpl = nodeSpawn, platform = process.platform, kill = process.kill.bind(process) } = {},
) {
  return new Promise((resolveResult) => {
    let child;
    let settled = false;
    let timedOut = false;
    let deadline = null;
    let hardKillTimer = null;
    const detached = platform !== "win32";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolveResult(result);
    };
    const signalTree = (signal) => {
      if (!child?.pid) return;
      try { kill(detached ? -child.pid : child.pid, signal); } catch { /* already exited */ }
    };
    try {
      child = spawnImpl(file, args, {
        cwd,
        env,
        stdio: "inherit",
        shell: false,
        detached,
      });
    } catch (error) {
      return finish({ exitCode: null, signal: null, timedOut: false, error: error?.message ?? String(error) });
    }
    deadline = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      hardKillTimer = setTimeout(() => signalTree("SIGKILL"), 1_000);
      hardKillTimer.unref?.();
    }, timeoutMs);
    deadline.unref?.();
    child.once("error", (error) =>
      finish({ exitCode: null, signal: null, timedOut, error: error?.message ?? String(error) }),
    );
    child.once("exit", (code, signal) =>
      finish({ exitCode: code, signal: signal ?? null, timedOut }),
    );
  });
}

export async function runRecoveryGrant(grantId, opts = {}) {
  const home = opts.home ?? homedir();
  const token = validateToken(opts.token);
  const now = opts.now ?? (() => Date.now());
  const nowMs = opts.nowMs ?? now();
  const terminalId = String(opts.terminalId ?? "").trim();
  const claimed = readClaimedGrant(grantId, { home });
  if (!claimed.ok) {
    appendRecoveryAuditRow(refusalAudit(grantId, claimed.reason, nowMs, opts), { home });
    return { ok: false, reason: claimed.reason };
  }
  const grant = claimed.grant;
  const verified = verifyClaimedGrant(grant, { token, nowMs, terminalId });
  if (!verified.ok) {
    const row = validGrant(grant)
      ? auditEvent(grant, "execution-refused", nowMs, { outcome: { refusalReason: verified.reason } })
      : refusalAudit(grantId, verified.reason, nowMs, opts);
    appendRecoveryAuditRow(row, { home });
    return { ok: false, reason: verified.reason };
  }

  const writeBanner = opts.writeBanner ?? ((text) => process.stderr.write(`${text}\n`));
  writeBanner(renderRecoveryBanner(grant));
  appendRecoveryAuditRow(auditEvent(grant, "execution-started", nowMs), { home });
  const env = {
    ...sanitizeRecoveryEnvironment(opts.baseEnv ?? process.env),
    PAPERCUSP_RECOVERY_MODE: "1",
    PAPERCUSP_RECOVERY_GRANT_ID: grant.grantId,
    PAPERCUSP_RECOVERY_CAPABILITY: grant.capability,
    PAPERCUSP_RECOVERY_DEADLINE_MS: String(nowMs + grant.maxRuntimeMs),
  };
  const execute = opts.execute ?? executeExactRecoveryCommand;
  const result = await execute({
    file: grant.argv[0],
    args: grant.argv.slice(1),
    cwd: grant.cwd,
    env,
    timeoutMs: grant.maxRuntimeMs,
  });
  const finishedAtMs = Math.max(nowMs, now());
  appendRecoveryAuditRow(
    auditEvent(grant, "execution-finished", finishedAtMs, {
      outcome: {
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        timedOut: Boolean(result.timedOut),
        ...(result.error ? { error: String(result.error).slice(0, 1_000) } : {}),
      },
    }),
    { home },
  );
  return { ok: true, grant, ...result };
}

export async function readRecoveryAudit({ home = homedir() } = {}) {
  const path = recoveryPaths(home).audit;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // A concurrent append can expose a partial tail; the next pass sees it.
    }
  }
  return rows;
}

export async function reconcileRecoveryAudit({ home = homedir(), send } = {}) {
  if (typeof send !== "function") throw new Error("recovery audit reconciliation requires a sender");
  const rows = await readRecoveryAudit({ home });
  const reconciled = new Set();
  for (const row of rows) {
    if (row.event !== "reconciliation-checkpoint") continue;
    for (const id of row.reconciledEventIds ?? []) reconciled.add(id);
  }
  const pendingRows = rows
    .filter((row) => row.event !== "reconciliation-checkpoint" && !reconciled.has(row.eventId))
    .slice(0, RECOVERY_RECONCILE_BATCH);
  if (pendingRows.length === 0) return { ok: true, reconciled: 0, pending: 0 };
  const response = await send(pendingRows);
  const requested = new Set(pendingRows.map((row) => row.eventId));
  const accepted = Array.from(
    new Set(
      (response?.reconciledEventIds ?? []).filter(
        (id) => typeof id === "string" && requested.has(id),
      ),
    ),
  );
  if (accepted.length > 0) {
    const last = pendingRows.findLast((row) => accepted.includes(row.eventId)) ?? pendingRows[0];
    appendRecoveryAuditRow(
      {
        version: RECOVERY_PROTOCOL_VERSION,
        eventId: randomUUID(),
        event: "reconciliation-checkpoint",
        at: new Date().toISOString(),
        atMs: Date.now(),
        grantId: last.grantId,
        reconciledEventIds: accepted,
      },
      { home },
    );
  }
  const allAfter = new Set([...reconciled, ...accepted]);
  const pending = rows.filter(
    (row) => row.event !== "reconciliation-checkpoint" && !allAfter.has(row.eventId),
  ).length;
  return { ok: true, reconciled: accepted.length, pending };
}

const INHERITED_AGENT_MARKERS = [
  "PAPERCUSP_AGENT_SESSION",
  "PAPERCUSP_SID",
  "PAPERCUSP_ADV_SESSION_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
];

const AGENT_ANCESTOR_RE = /(?:^|[\/\s])(?:claude|codex|omp)(?:[\s\0]|$)|psu-pty-host\.mjs/i;

export function recoveryAuthorizationEligibility({
  env = process.env,
  stdinIsTTY = Boolean(process.stdin.isTTY),
  stdoutIsTTY = Boolean(process.stdout.isTTY),
  ancestorCmdlines = [],
} = {}) {
  if (INHERITED_AGENT_MARKERS.some((key) => String(env[key] ?? "").length > 0)) {
    return { ok: false, reason: "inherited-agent-identity" };
  }
  if (ancestorCmdlines.some((line) => AGENT_ANCESTOR_RE.test(String(line)))) {
    return { ok: false, reason: "agent-process-ancestor" };
  }
  if (!stdinIsTTY || !stdoutIsTTY) {
    return { ok: false, reason: "interactive-terminal-required" };
  }
  return { ok: true };
}

export function readRecoveryAncestorCmdlines({ startPid = process.ppid, maxDepth = 32 } = {}) {
  if (process.platform !== "linux") return [];
  const out = [];
  const seen = new Set();
  let pid = Number(startPid);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) break;
    seen.add(pid);
    try {
      out.push(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) break;
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      pid = Number(fields[1]);
    } catch {
      break;
    }
  }
  return out;
}

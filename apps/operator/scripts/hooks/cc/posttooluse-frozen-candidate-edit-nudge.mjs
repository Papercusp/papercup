#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) hook with TWO jobs, both only while a gate candidate is
// FROZEN (there is a marker file); otherwise it exits after one failed read:
//
//   1. EDIT LEDGER (P-019 of frozen-candidate-stays-frozen-through-all-fixes-2026-09-03,
//      D-008 layer 1). Record the EXACT hunk this edit made — { old, new } for an Edit, the
//      body for a Write, one row per MultiEdit entry — attributed to the per-session owner,
//      via `release:repair-queue { op:'record-edit' }`. This is the only attribution that
//      works here: git blame and commit subjects are meaningless under git-sync, but this
//      hook sees the hunk at the moment it is made. Hunk-exact admission (P-020) replays
//      ONLY the calling agent's ledgered hunks, so a stranger's concurrent work in the same
//      file never rides into the judged lineage.
//
//   2. ADVISORY NUDGE (P-004/P-005 of frozen-candidate-compliance-enforcement-2026-08-30,
//      D-007 #2 of the 2026-09-03 plan). If the edited path is in the repair RADIUS (a
//      failing path, or any manifest leg's subject path), say the CONSEQUENCE, not the rule:
//      this edit is NOT judged until admitted; here is the one call; your hunks are (or are
//      not) recorded.
//
// THE TRAP
//   On the first real code red the gate opens ONE frozen repair queue and every later run
//   RESUMES that exact candidate rather than a newer tip (freeze-and-converge, D-007). An
//   agent who fixes a named failing test on `staging` therefore lands the fix ABOVE the sha
//   under judgment. Nothing fails. The gate keeps reporting the same red, the agent reports
//   "fixed N gate reds", and both are locally true while the gate cannot see any of it.
//   Measured 2026-08-30: 3 of 10 reds on candidate 4184805d were already fixed at tip.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to. Editing a failing path is
//     often exactly right; what is wrong is doing it believing the gate will see it.
//   - COSTS ~NOTHING WHEN NOTHING IS FROZEN. The signal is inverted: no frozen repair means
//     no marker file, so the hook exits after one failed read. There is deliberately no
//     database round-trip on that path — this fires on every edit, fleet-wide.
//   - The marker is projected by `writeFrozenCandidateRepairQueue`, the one production write
//     path for the queue, so it cannot describe a previous round.
//   - NORMALIZATION IS PINNED, NOT COPIED-AND-HOPED. `normalizeRepoPath` and `hunksFrom`
//     below must agree with the gate's own (`frozen-candidate-repair-queue.ts`,
//     `frozen-repair-edit-ledger.ts`); `frozen-repair-edit-hook-parity.test.ts` imports both
//     sides and fails the build if they ever diverge.
//   - FAILS OPEN on every internal error, including a ledger write the operator refuses or
//     cannot reach (e.g. :3070 still serving a release without `record-edit`). The nudge
//     then says the hunks were NOT recorded, so the agent knows admission will need
//     `wholeBlob:true, reason` rather than believing it is covered.
//   - `--self-test` runs the embedded cases (no stdin, no network) and exits non-zero on failure.
//
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** MUST match packages/operator-core/lib/release/frozen-candidate-repair-queue.ts. */
export function normalizeRepoPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

export function markerPath() {
  const base = process.env.PAPERCUSP_STATE_DIR ?? join(homedir(), '.papercusp', 'state');
  return join(base, 'frozen-repair-edit-marker.json');
}

export function readMarker(path = markerPath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.candidate !== 'string' || typeof parsed.repairHead !== 'string') return null;
    if (!Array.isArray(parsed.failingPaths)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * P-019: the repair RADIUS — the failing paths plus every P-021 manifest leg's subject paths
 * (a pre-P-022 marker has no `legs`, so the radius is the failing set alone). Normalized.
 */
export function repairRadius(marker) {
  const out = new Set();
  for (const p of marker?.failingPaths ?? []) out.add(normalizeRepoPath(p));
  for (const leg of Array.isArray(marker?.legs) ? marker.legs : []) {
    for (const p of Array.isArray(leg?.subjectPaths) ? leg.subjectPaths : []) out.add(normalizeRepoPath(p));
  }
  out.delete('');
  return out;
}

/**
 * P-005 / D-007 #2: name the CONSEQUENCE, not the rule. "Remember freeze-and-converge" is the
 * prose that already failed — it asks the reader to recall a regime and derive what it
 * implies. Returns null when there is nothing to say (path outside the radius).
 *
 * `ledger` is the P-019 outcome for this path: `{ recorded: true }`, `{ recorded: false,
 * detail }`, or null when no recording was attempted (self-test / no hunk extracted).
 *
 * @param {any} marker
 * @param {string} editedPath
 * @param {{ recorded: boolean, detail?: string } | null} [ledger]
 * @returns {string | null}
 */
export function warningFor(marker, editedPath, ledger = null) {
  if (!marker) return null;
  const p = normalizeRepoPath(editedPath);
  if (!p) return null;
  if (!repairRadius(marker).has(p)) return null;
  const lines = [
    '⛔ THIS FIX WILL NOT REACH THE GATE UNTIL YOU ADMIT IT.',
    `   ${p} is in the frozen candidate's repair radius, and the gate is judging ${String(
      marker.repairHead,
    ).slice(0, 12)} (frozen candidate ${String(marker.candidate).slice(0, 12)}, phase ${
      marker.phase ?? 'unknown'
    }) — NOT the staging tip your edit lands on.`,
    '   So the gate will keep failing on this exact file however correct your fix is, and a',
    '   "fixed the gate red" claim off this edit would be false (work_items:complete refuses it).',
    '   Put it on the judged lineage with ONE call, after git-sync commits the edit:',
    `     release:repair-queue { op:'admit', paths:['${p}'] }`,
  ];
  if (ledger && ledger.recorded === true) {
    lines.push('   Your hunks are RECORDED in the edit ledger; admission will carry only them (D-008),');
    lines.push("   never a peer's concurrent work in the same file.");
  } else if (ledger && ledger.recorded === false) {
    lines.push(
      `   ⚠ Your hunks were NOT recorded (${ledger.detail ?? 'ledger unavailable'}) — hunk-exact admission has`,
    );
    lines.push("   nothing to replay for this edit; admit it with wholeBlob:true and a reason, explicitly.");
  }
  lines.push('   It reports whether the judged sha now carries your fix. Do NOT fire');
  lines.push('   release:checkpoint-run and do NOT retire the queue to "make the gate move".');
  return lines.join('\n');
}

/** Every path an Edit/Write/MultiEdit payload touched. */
export function editedPathsFrom(payload) {
  const input = payload?.tool_input ?? {};
  const paths = [];
  if (typeof input.file_path === 'string') paths.push(input.file_path);
  else if (typeof input.path === 'string') paths.push(input.path);
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (typeof e?.file_path === 'string') paths.push(e.file_path);
  }
  return paths;
}

/**
 * P-019: the hunks a payload made — MUST match `hunksFromToolCall` in
 * packages/operator-core/lib/release/frozen-repair-edit-ledger.ts (pinned by the parity test).
 *   Edit / capability_edit         { file_path, old_string, new_string, replace_all? }
 *   Write / capability_write       { file_path, content }
 *   MultiEdit / capability_multi_edit { file_path, edits:[{ old_string, new_string, replace_all? }] }
 *   Codex write_file               { path, content }
 *   Codex apply_patch              patch text — not a hunk pair; nothing extracted (recorded as absent).
 */
export function hunksFrom(payload) {
  const input = payload?.tool_input;
  if (!input || typeof input !== 'object') return [];
  const name = String(payload?.tool_name ?? '').toLowerCase();
  const isMulti = /multi_?edit/.test(name);
  const isEdit = !isMulti && /(^|_)edit$/.test(name);
  const isWrite = /(^|_)write(_file)?$/.test(name);
  const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  if (!filePath) return [];
  const str = (v) => (typeof v === 'string' ? v : null);
  if (isMulti) {
    const out = [];
    (Array.isArray(input.edits) ? input.edits : []).forEach((e, index) => {
      if (!e || typeof e !== 'object') return;
      const o = str(e.old_string);
      const n = str(e.new_string);
      if (o === null || n === null) return;
      out.push({ path: str(e.file_path) ?? filePath, hunk: { kind: 'edit', old: o, new: n, replaceAll: e.replace_all === true }, editIndex: index });
    });
    return out;
  }
  if (isEdit) {
    const o = str(input.old_string);
    const n = str(input.new_string);
    if (o === null || n === null) return [];
    return [{ path: filePath, hunk: { kind: 'edit', old: o, new: n, replaceAll: input.replace_all === true }, editIndex: 0 }];
  }
  if (isWrite) {
    const body = str(input.content);
    if (body === null) return [];
    return [{ path: filePath, hunk: { kind: 'write', body }, editIndex: 0 }];
  }
  return [];
}

/** Did the client report the edit itself failed? A failed edit made no hunk to record. */
export function toolCallFailed(payload) {
  const r = payload?.tool_response ?? payload?.toolResponse;
  if (!r || typeof r !== 'object') return false;
  return r.is_error === true || r.isError === true || Boolean(r.error);
}

/**
 * Per-session owner — the SAME resolution order as pretooluse-locks-acquire.sh, so the
 * ledger row, the lock row and the agent's own `admit` call carry ONE identity.
 */
export function ownerIdentity(payload, env = process.env, readFile = (p) => readFileSync(p, 'utf8')) {
  const lockSid = env.PAPERCUSP_LOCK_SID;
  if (typeof lockSid === 'string' && lockSid) return lockSid;
  try {
    if (env.CODEX_HOME) {
      const diag = JSON.parse(readFile(join(env.CODEX_HOME, 'papercusp-diagnostics.json')));
      if (typeof diag?.lockOwnerSid === 'string' && diag.lockOwnerSid) return diag.lockOwnerSid;
    }
  } catch {
    /* no codex diagnostics */
  }
  if (typeof env.PAPERCUSP_SID === 'string' && env.PAPERCUSP_SID) return env.PAPERCUSP_SID;
  if (typeof payload?.session_id === 'string' && payload.session_id) return payload.session_id;
  try {
    const id = readFile(join(homedir(), '.papercusp', 'su-agent-id')).trim();
    if (id) return id;
  } catch {
    /* not installed */
  }
  return null;
}

/**
 * Repo-relative path for an edited file: the SUPERPROJECT root when the file sits in a
 * submodule (the gate's queue names paths from the superproject), else the toplevel. Null
 * when the file is outside any repository — nothing to attribute to a lineage then.
 */
export function repoRelativePath(filePath, cwd = process.cwd(), git = execFileSync) {
  try {
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs; // a Write may create the file after we run — the parent dir still resolves
    }
    const dir = dirname(real);
    const out = String(
      git('git', ['-C', dir, 'rev-parse', '--show-superproject-working-tree', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }),
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const root = out[0];
    if (!root) return null;
    const rel = relative(realpathSafe(root), real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return normalizeRepoPath(rel);
  } catch {
    return null;
  }
}

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Parse the MCP endpoint's JSON or SSE envelope into the inner tool result (or null). */
export function parseMcpToolResult(rawText) {
  let result = null;
  let rpcError = null;
  for (let line of String(rawText ?? '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    let candidate;
    try {
      candidate = JSON.parse(line);
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;
    if ('result' in candidate) {
      result = candidate.result;
      break;
    }
    if ('error' in candidate) {
      rpcError = candidate.error;
      break;
    }
  }
  if (rpcError) return { ok: false, detail: `rpc: ${rpcError.message ?? JSON.stringify(rpcError)}` };
  if (!result || typeof result !== 'object') return { ok: false, detail: 'no result' };
  if (result.isError === true) {
    const text = (result.content ?? []).map((c) => c?.text ?? '').join(' ').slice(0, 200);
    return { ok: false, detail: `tool error: ${text || 'unknown'}` };
  }
  for (const item of result.content ?? []) {
    if (!item || item.type !== 'text') continue;
    try {
      const inner = JSON.parse(item.text);
      if (inner && typeof inner === 'object') return { ok: true, inner };
    } catch {
      /* not JSON */
    }
  }
  return { ok: false, detail: 'no text result' };
}

/**
 * POST one `record-edit` through the same door the lock hook uses (bearer + ?client=owner so
 * the server attributes the row to the per-session owner). Never throws.
 */
export async function recordOneHunk({ operatorUrl, token, owner, marker, path, hunk, toolUseId, editIndex, atMs, fetchImpl = fetch }) {
  const url =
    operatorUrl.replace(/\/+$/, '') +
    '/api/mcp?superuser=1&origin=hook&format=json&client=' +
    encodeURIComponent(owner);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'release:repair-queue',
      arguments: {
        op: 'record-edit',
        path,
        hunk,
        toolUseId: toolUseId || undefined,
        editIndex,
        atMs,
        candidate: marker.candidate,
      },
    },
  });
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    if (!res.ok) return { recorded: false, detail: `HTTP ${res.status}` };
    const parsed = parseMcpToolResult(text);
    if (!parsed.ok) return { recorded: false, detail: parsed.detail };
    const inner = parsed.inner;
    if (inner.ok === true && inner.recorded === true) return { recorded: true, inserted: inner.inserted !== false, inner };
    return { recorded: false, detail: inner.reason ?? inner.verdict ?? 'refused', inner };
  } catch (err) {
    return { recorded: false, detail: err?.name === 'TimeoutError' ? 'operator timeout' : String(err?.message ?? err).slice(0, 120) };
  }
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // fail open
  }
  const marker = readMarker();
  if (!marker) return; // the common case: nothing frozen
  if (toolCallFailed(payload)) return; // a failed edit made no hunk

  // P-019: record every hunk this edit made, whatever the path — hunk-exact admission needs
  // the SOURCE fix as much as the failing test, and the failing set cannot name the source.
  const ledgerByPath = new Map();
  const hunks = hunksFrom(payload).slice(0, 20);
  if (hunks.length > 0) {
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    let token = '';
    try {
      token = readFileSync(tokenPath, 'utf8').trim();
    } catch {
      token = '';
    }
    const owner = ownerIdentity(payload);
    const operatorUrl = String(process.env.PAPERCUSP_OPERATOR_URL ?? 'http://localhost:3070').replace(/\/api\/mcp.*$/, '');
    if (token && owner) {
      const toolUseId = String(payload.tool_use_id ?? payload.tool_call_id ?? '');
      const atMs = Date.now();
      const results = await Promise.all(
        hunks.map(async (h) => {
          const rel = repoRelativePath(h.path, payload.cwd ?? process.cwd());
          if (!rel) return null;
          const r = await recordOneHunk({ operatorUrl, token, owner, marker, path: rel, hunk: h.hunk, toolUseId, editIndex: h.editIndex, atMs });
          return { rel, r };
        }),
      );
      for (const entry of results) {
        if (!entry) continue;
        const prev = ledgerByPath.get(entry.rel);
        // A path is "recorded" only if EVERY hunk for it landed.
        if (!prev) ledgerByPath.set(entry.rel, entry.r);
        else if (prev.recorded && !entry.r.recorded) ledgerByPath.set(entry.rel, entry.r);
      }
    } else {
      for (const h of hunks) {
        const rel = repoRelativePath(h.path, payload.cwd ?? process.cwd());
        if (rel) ledgerByPath.set(rel, { recorded: false, detail: token ? 'no session identity' : 'papercusp not installed' });
      }
    }
  }

  const seen = new Set();
  const messages = [];
  for (const path of editedPathsFrom(payload)) {
    const rel = repoRelativePath(path, payload.cwd ?? process.cwd()) ?? normalizeRepoPath(path);
    const msg = warningFor(marker, rel, ledgerByPath.get(rel) ?? null);
    if (msg && !seen.has(msg)) {
      seen.add(msg);
      messages.push(msg);
    }
  }
  if (messages.length) process.stdout.write(`${messages.join('\n\n')}\n`);
}

function selfTest() {
  const marker = {
    candidate: 'c'.repeat(40),
    repairHead: 'r'.repeat(40),
    phase: 'repair-in-progress',
    failingPaths: ['packages/x/lib/a.test.ts'],
    legs: [{ legId: 'lint:tsc', status: 'red', subjectPaths: ['packages/x/lib/src.ts'] }],
  };
  let failures = 0;
  const fail = (m) => {
    failures += 1;
    process.stderr.write(`self-test FAIL: ${m}\n`);
  };
  const cases = [
    ['./packages/x/lib/a.test.ts', true],
    ['packages/x/lib/a.test.ts', true],
    ['packages\\x\\lib\\a.test.ts', true],
    ['packages/x/lib/src.ts', true], // P-019: a manifest leg's subject path is in the radius
    ['packages/x/lib/other.test.ts', false],
    ['', false],
  ];
  for (const [path, shouldWarn] of cases) {
    if ((warningFor(marker, path) !== null) !== shouldWarn) fail(`${JSON.stringify(path)} expected ${shouldWarn}`);
  }
  if (warningFor(null, 'packages/x/lib/a.test.ts') !== null) fail('a null marker must be silent');
  const msg = warningFor(marker, 'packages/x/lib/a.test.ts') ?? '';
  if (!msg.includes("op:'admit'")) fail('the message must name the sanctioned command (admit)');
  if (msg.includes("op:'converge'")) fail('the message must not name the retired converge spelling');
  if (!warningFor(marker, 'packages/x/lib/a.test.ts', { recorded: true })?.includes('RECORDED')) fail('recorded hunks must be named');
  if (!warningFor(marker, 'packages/x/lib/a.test.ts', { recorded: false, detail: 'x' })?.includes('NOT recorded')) fail('an unrecorded hunk must be named');
  // hunksFrom: the shapes the matcher admits
  const edit = hunksFrom({ tool_name: 'Edit', tool_input: { file_path: '/r/a.ts', old_string: 'o', new_string: 'n' } });
  if (edit.length !== 1 || edit[0].hunk.kind !== 'edit' || edit[0].hunk.replaceAll !== false) fail('Edit → one edit hunk');
  const write = hunksFrom({ tool_name: 'mcp__papercusp-su__capability_write', tool_input: { file_path: '/r/a.ts', content: 'b' } });
  if (write.length !== 1 || write[0].hunk.kind !== 'write' || write[0].hunk.body !== 'b') fail('capability_write → one write hunk');
  const multi = hunksFrom({
    tool_name: 'MultiEdit',
    tool_input: { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, 'junk', { old_string: 'c', new_string: 'd', replace_all: true }] },
  });
  if (multi.length !== 2 || multi[1].editIndex !== 2 || multi[1].hunk.replaceAll !== true) fail('MultiEdit → N hunks with positions');
  if (hunksFrom({ tool_name: 'apply_patch', tool_input: 'diff' }).length !== 0) fail('apply_patch extracts nothing');
  if (hunksFrom({ tool_name: 'Read', tool_input: { file_path: 'x' } }).length !== 0) fail('a read extracts nothing');
  if (!toolCallFailed({ tool_response: { is_error: true } }) || toolCallFailed({ tool_response: { ok: true } })) fail('toolCallFailed');
  // parseMcpToolResult: JSON, SSE, rpc error, isError
  const okJson = parseMcpToolResult(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true,"recorded":true}' }] } }));
  if (!okJson.ok || okJson.inner.recorded !== true) fail('parse JSON envelope');
  const okSse = parseMcpToolResult('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n');
  if (!okSse.ok) fail('parse SSE envelope');
  if (parseMcpToolResult('{"jsonrpc":"2.0","id":1,"error":{"message":"nope"}}').ok) fail('rpc error is not ok');
  if (parseMcpToolResult('{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"bad"}]}}').ok) fail('isError is not ok');
  if (ownerIdentity({ session_id: 's1' }, { PAPERCUSP_LOCK_SID: 'lock-1' }, () => '') !== 'lock-1') fail('owner: lock sid wins');
  if (ownerIdentity({ session_id: 's1' }, {}, () => { throw new Error('x'); }) !== 's1') fail('owner: session id fallback');
  process.stdout.write(failures === 0 ? 'self-test OK\n' : `self-test: ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (process.argv.includes('--self-test')) selfTest();
else if (invokedDirectly) main().catch(() => {});

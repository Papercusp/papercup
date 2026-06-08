#!/usr/bin/env node
/**
 * psu-launcher.mjs — the `psu` command.
 *
 * Picks an SU agent + harness + plan, records a tracked `adv_sessions`
 * row via the bootstrap-su endpoint, then exec's the chosen `*-su`
 * wrapper (claude-su / omp-su / codex-su) in the harness cwd with the
 * tracking env. The `*-su` wrappers (installed by
 * install-standalone-mcp.sh) already inject the engineer playbook +
 * skip-permissions + MCP — `psu` adds the picker + plan tracking on top.
 *
 * Per `psu-wrappers-and-plan-tracked-launch-2026-05-30` Phase B (pivot:
 * single `psu` entry point exec'ing the existing `*-su` wrappers).
 *
 * Lives in the repo so it resolves `@inquirer/prompts` from the
 * operator's node_modules; the on-PATH `psu` shim is a one-liner that
 * exec's this file by absolute path.
 *
 * Interactive:   psu
 * Scripting:     psu --no-picker --agent=<claude|omp|codex> --harness=<slug> [--plan=<slug>|--no-plan]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostThroughPty } from './psu-pty-host.mjs';

export const AGENTS = ['claude', 'omp', 'codex'];
/** Sentinel value for the "NO PLAN" picker row. Uses non-slug chars
 *  (`<`/`>`) so it can never collide with a real plan slug. */
export const NO_PLAN = '<no-plan>';

const OPERATOR_URL = process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070';

/**
 * Per-request timeout (ms). `fetch` has no default timeout, so a wedged or
 * CPU-saturated operator used to make `psu` hang FOREVER on its first picker
 * call (`bootstrap-su/options`) with no output. A bounded timeout fails fast
 * with an actionable message instead. Override with PAPERCUSP_PSU_TIMEOUT_MS.
 */
// Per-request timeout. Raised 15s→45s (2026-06-07): a busy operator can take
// 10-30s on a hop-heavy bootstrap route under fleet load, and a 15s cap turned
// every transient slow window into a hard `psu` failure. 45s rides through the
// blip; a truly wedged host still fails (just later) with the same guidance.
const REQUEST_TIMEOUT_MS = Number(process.env.PAPERCUSP_PSU_TIMEOUT_MS) || 45_000;
// One automatic retry on a transient failure (timeout OR connection-refused —
// the latter is a restart blip) before surfacing the error, so a single slow
// tick or an in-flight host restart self-heals instead of failing the launch.
const API_RETRIES = Number(process.env.PAPERCUSP_PSU_RETRIES) || 1;

/** Parse the scripting-escape flags. Pure — exported for tests. */
export function parseArgs(argv) {
  const out = { picker: true, resume: false, resumeId: null, agent: null, role: null, feature: null, workspace: null, harness: null, plan: null, noPlan: false, model: null, resumeSession: null, launchContext: null, profile: null, yes: false, brain: false };
  for (const a of argv) {
    if (a === '--no-picker') out.picker = false;
    // THE brain (native-terminal-desktop D-013): resume the canonical pinned
    // brain session exactly (no picker); when none is pinned (or it no longer
    // resolves) launch a fresh claude SU session and pin it server-side.
    else if (a === '--brain') out.brain = true;
    // `--resume` alone → pick from the recent-session list. `--resume=<id>`
    // (or a bare id after `--resume`) → resume THAT session directly, no
    // picker. The id is the /adv adv_sessions row id OR the agent's native
    // session id (the claude --session-id UUID) — both match a tracked row.
    else if (a === '--resume') out.resume = true;
    else if (a.startsWith('--resume=')) { out.resume = true; out.resumeId = a.slice('--resume='.length) || null; }
    else if (a === '--no-plan') out.noPlan = true;
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    else if (a.startsWith('--role=')) out.role = a.slice('--role='.length);
    else if (a.startsWith('--feature=')) out.feature = a.slice('--feature='.length);
    else if (a.startsWith('--workspace=')) out.workspace = a.slice('--workspace='.length);
    else if (a.startsWith('--harness=')) out.harness = a.slice('--harness='.length);
    else if (a.startsWith('--plan=')) out.plan = a.slice('--plan='.length);
    // P-032 omp-convergence passthroughs: a model fuzzy-match, resume of a
    // specific recorded session, and a kickoff/launch-context file the server
    // pre-generated (fed to the *-su wrapper as its launch-context).
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a.startsWith('--resume-session=')) out.resumeSession = a.slice('--resume-session='.length);
    else if (a.startsWith('--launch-context=')) out.launchContext = a.slice('--launch-context='.length);
    // P-023: su playbook profile (engineer|power) — assembled per-launch now,
    // so it's a launch flag, not a per-install choice. Default (server-side) engineer.
    else if (a.startsWith('--profile=')) out.profile = a.slice('--profile='.length);
    // Skip the confirm when resuming an UNTRACKED (non-psu) session (for scripts).
    else if (a === '--yes' || a === '-y') out.yes = true;
    // Bare positional id after `--resume` (ergonomic `psu --resume 42` form).
    else if (!a.startsWith('--') && out.resume && !out.resumeId) out.resumeId = a;
  }
  return out;
}

/**
 * Extra args to pass THROUGH a `*-su` wrapper to the underlying CLI (the
 * wrappers all end with `"$@"`). Maps a model fuzzy-match + a resume-by-id
 * onto each backend's native flags. Pure — exported for tests.
 *
 * This is what gives psu launches model/resume parity with the retired
 * `buildEngineerOmpLaunchCommand` (P-032): omp `--model`/`-r`, claude
 * `--model`/`--resume`, codex `-m`/`resume`.
 */
export function suWrapperExtraArgs(agent, { model, resumeSession } = {}) {
  const args = [];
  if (model) {
    if (agent === 'codex') args.push('-m', model);
    else args.push('--model', model); // claude + omp
  }
  if (resumeSession) {
    if (agent === 'omp' || agent === 'claude') args.push('-r', resumeSession);
    else if (agent === 'codex') args.push('resume', resumeSession);
  }
  return args;
}

/**
 * Per-backend args for an interactive ROLE session — exec the raw CLI
 * (NOT the *-su wrapper, which bakes the engineer playbook + superuser
 * MCP) with the role prompt as system prompt + the signed role-scoped
 * `.mcp.json`. Pure — exported for tests.
 *
 * claude gets `--strict-mcp-config` so it's restricted to ONLY the
 * role-scoped server (true tool-scoping); omp path-discovers the cwd's
 * `.mcp.json`. codex has no --mcp-config / --append-system-prompt flags,
 * so bootstrap-role mints a per-session CODEX_HOME (AGENTS.md = role
 * prompt, config.toml = role-scoped MCP) and exports it via
 * `envelopeEnv.CODEX_HOME`; the launcher just execs `codex` with the
 * approvals/sandbox bypass MCP tool calls need (mirrors the codex-su
 * wrapper).
 */
export function roleLaunchArgs(backend, { promptFile, mcpJsonPath, coordExtPath }) {
  if (backend === 'claude') {
    return {
      bin: 'claude',
      args: [
        '--dangerously-skip-permissions',
        '--append-system-prompt-file', promptFile,
        '--mcp-config', mcpJsonPath,
        '--strict-mcp-config',
        '--permission-mode', 'bypassPermissions',
      ],
    };
  }
  if (backend === 'omp') {
    // omp path-discovers <cwd>/.mcp.json; --append-system-prompt takes a file path.
    // -e loads the coordination extension (lock enforcement + coord + the activity
    // bridge port) when one is supplied — a role omp session is a worker that edits
    // files + whose activity belongs in the fleet view, so it gets the same hook the
    // su omp launch + role codex/claude do. (claude/codex role hooks are user-level /
    // baked; omp's is the `-e` module.)
    const args = ['--approval-mode', 'yolo', '--append-system-prompt', promptFile];
    if (coordExtPath) args.push('-e', coordExtPath);
    return { bin: 'omp', args };
  }
  if (backend === 'codex') {
    // CODEX_HOME (with AGENTS.md + role-scoped config.toml + lock-hook
    // settings.json) is supplied via envelopeEnv.
    // --dangerously-bypass-hook-trust runs the home's SU-locks hooks (P-030;
    // the only hooks there are ours); --dangerously-bypass-approvals-and-sandbox
    // lets the session call MCP tools without per-call approval (codex CANCELS
    // MCP tool calls under the default sandbox — see the orchestrator path).
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox'] };
  }
  throw new Error(`roleLaunchArgs: backend '${backend}' has no interactive role launch`);
}

/**
 * Raw-CLI launch args for a SUPERUSER (`su`) session — the engineer/
 * collaborator path. Pure — exported for tests. The su counterpart to
 * `roleLaunchArgs`: same raw backends, but the prompt is the engineer
 * playbook (`buildLaunchSpec({kind:'su'})`).
 *
 * MCP is USER-LEVEL for claude + omp and survives a raw launch (the Phase 0
 * finding) — claude's `papercusp-su` lives in `~/.claude.json` (its url
 * env-expands `${PAPERCUSP_SID}`, so per-session identity flows once psu
 * exports the SID), omp's in `~/.omp/agent/mcp.json`. So psu supplies NO
 * `--mcp-config`: it would double the `papercusp-su` server. This also
 * realizes D-005 (su keeps its FULL toolkit — every user server loads, not
 * just papercusp) more directly than `--mcp-config` + non-strict would.
 *
 * Lock-hook enforcement is likewise USER-LEVEL for claude (Pre/PostToolUse
 * in `~/.claude/settings.json`); omp loads it as a module via `-e`
 * (P-021, `~/.papercusp/papercusp-coord.ts`). codex is the only one whose
 * MCP + hooks are NOT user-level — it has no --mcp-config/-e/-prompt flag,
 * so a per-session CODEX_HOME is minted server-side (P-030: AGENTS.md =
 * playbook, config.toml = superuser MCP w/ bearer, settings.json = lock
 * hooks) and supplied via `envelopeEnv.CODEX_HOME`; the launcher execs
 * `codex` with `--dangerously-bypass-hook-trust` (the home's only hooks are
 * ours) + the approvals/sandbox bypass MCP tool calls need.
 */
export function suLaunchArgs(backend, { promptFile, coordExtPath, nativeSessionId } = {}) {
  if (backend === 'claude') {
    return {
      bin: 'claude',
      args: [
        '--dangerously-skip-permissions',
        '--append-system-prompt-file', promptFile,
        // Force the session id bootstrap-su recorded so `psu --resume <uuid>`
        // can correlate this session to its adv row — and resume the EXACT
        // session, not `--continue`'s most-recent-in-cwd. claude-only (omp/codex
        // pass null; they don't take a forced session id).
        ...(nativeSessionId ? ['--session-id', nativeSessionId] : []),
        // No --mcp-config: claude's papercusp-su is user-level (~/.claude.json)
        // and survives a raw launch; adding it would duplicate the server.
        '--permission-mode', 'bypassPermissions',
      ],
    };
  }
  if (backend === 'omp') {
    // omp's papercusp-su is user-level (~/.omp/agent/mcp.json);
    // --append-system-prompt takes a file path; -e loads the coordination
    // extension (P-021) for lock enforcement when one is provided.
    const args = ['--approval-mode', 'yolo', '--append-system-prompt', promptFile];
    if (coordExtPath) args.push('-e', coordExtPath);
    return { bin: 'omp', args };
  }
  if (backend === 'codex') {
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox'] };
  }
  throw new Error(`suLaunchArgs: backend '${backend}' has no interactive su launch`);
}

/**
 * Per-agent resume command — RAW CLI (no `*-su` wrapper, P-042). Pure —
 * exported for tests. Returns the raw `bin` + resume args, re-supplying the
 * same launch flags the fresh-launch path uses (the wrappers used to bake
 * these). Semantics: claude/omp continue the most recent conversation in the
 * session's cwd (omp targets an exact thread when one was captured); codex
 * resumes its most recent session from its per-session CODEX_HOME (set by the
 * caller via env — derived from the session id, which still holds that
 * session's history).
 *
 * MCP + (claude) lock hooks are user-level → survive a raw resume. omp re-adds
 * the coordination extension via `-e <coordExtPath>` (per-invocation, not saved
 * in the thread). codex re-supplies its bypass flags; its hooks/MCP live in the
 * CODEX_HOME the caller points at.
 */
export function resumeArgsFor(session, { coordExtPath } = {}) {
  // `session.sessionId` is the agent's NATIVE session id (a UUID) when known —
  // set for store-found (untracked) sessions, so we resume that EXACT session.
  // Without it (tracked rows don't carry the native id) we fall back to the
  // agent's "most-recent-in-cwd" resume.
  if (session.agent === 'claude') {
    const resume = session.sessionId ? ['--resume', session.sessionId] : ['--continue'];
    return { bin: 'claude', args: [...resume, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'] };
  }
  if (session.agent === 'omp') {
    const args = session.ompThreadId ? ['-r', session.ompThreadId] : ['-c'];
    args.push('--approval-mode', 'yolo');
    if (coordExtPath) args.push('-e', coordExtPath);
    return { bin: 'omp', args };
  }
  if (session.agent === 'codex') {
    // Bypass flags BEFORE the `resume` subcommand (top-level). CODEX_HOME (the
    // session's home) is set by the caller. `resume <uuid>` (UUIDs take
    // precedence) for an exact session; `resume --last` otherwise.
    const resume = session.sessionId ? ['resume', session.sessionId] : ['resume', '--last'];
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', ...resume] };
  }
  throw new Error(`resumeArgsFor: unknown agent: ${session.agent}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** First `"cwd":"…"` in a session jsonl (claude events + codex rollout meta both
 *  carry it), so we recover the launch dir WITHOUT knowing where it started. */
function cwdFromSessionFile(file) {
  try {
    const m = readFileSync(file, 'utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

/** Recursively find the codex rollout file whose name ends with `-<id>.jsonl`. */
function findCodexRollout(root, id) {
  for (const e of safeReaddir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory()) { const hit = findCodexRollout(p, id); if (hit) return hit; }
    else if (e.name.endsWith(`-${id}.jsonl`)) return p;
  }
  return null;
}

/**
 * Find a session the user did NOT launch via psu, by searching each agent's
 * OWN session store for the id — NOT a filesystem crawl: claude keeps every
 * session under `~/.claude/projects/<dir>/<id>.jsonl`, codex under
 * `~/.codex/sessions/**​/rollout-*-<uuid>.jsonl`. The store IS the index, and
 * the matched file records its own `cwd`, so the launch dir falls out of it.
 * Returns `{ agent, sessionId|ompThreadId, cwd, untracked:true }` or null.
 * A UUID → claude/codex (whichever store has it); a non-UUID → an omp thread
 * name (resumed in the current dir, since omp's store isn't path-indexed here).
 * Pure-ish (reads FS); exported for tests.
 */
export function findUntrackedSession(id, { home = homedir(), cwd = process.cwd() } = {}) {
  if (!id) return null;
  if (UUID_RE.test(id)) {
    const claudeProjects = join(home, '.claude', 'projects');
    for (const d of safeReaddir(claudeProjects)) {
      if (!d.isDirectory()) continue;
      const f = join(claudeProjects, d.name, `${id}.jsonl`);
      if (existsSync(f)) return { agent: 'claude', sessionId: id, cwd: cwdFromSessionFile(f) || cwd, untracked: true };
    }
    const codexRollout = findCodexRollout(join(home, '.codex', 'sessions'), id);
    if (codexRollout) return { agent: 'codex', sessionId: id, cwd: cwdFromSessionFile(codexRollout) || cwd, untracked: true };
    return null;
  }
  // Non-UUID → treat as an omp thread name; resume in the current dir.
  return { agent: 'omp', ompThreadId: id, cwd, untracked: true };
}

/**
 * Does claude's OWN store hold a transcript for this session id? A tracked
 * adv row alone doesn't prove resumability: a launch that died before its
 * first persisted turn leaves the adv row (and the brain pin) behind with NO
 * `~/.claude/projects/<dir>/<id>.jsonl`, and `claude --resume <id>` then
 * fails "No conversation found". Pure-ish (reads FS); exported for tests.
 */
export function claudeStoreHasSession(id, { home = homedir() } = {}) {
  if (!id) return false;
  const claudeProjects = join(home, '.claude', 'projects');
  for (const d of safeReaddir(claudeProjects)) {
    if (d.isDirectory() && existsSync(join(claudeProjects, d.name, `${id}.jsonl`))) return true;
  }
  return false;
}

/** Map a plan picker value to the bootstrap-su `plan_slug` (NO_PLAN → null). Pure. */
export function planValue(picked) {
  return picked === NO_PLAN || picked == null || picked === '' ? null : picked;
}

/**
 * Resolve which fields the flags PRE-SELECT vs which still need an
 * interactive prompt. Pure — exported for tests. Throws on a bad --agent.
 *
 * Any flag you pass preselects that field (the picker skips it); anything
 * you omit is marked `need*` so the interactive picker fills it in. This
 * is what lets you preselect some fields and still get prompted for the
 * rest — e.g. `psu --agent=claude --workspace=ws2` presets agent +
 * workspace and prompts for harness + plan.
 */
export function presetsFromArgs(args) {
  const agent = args.agent || null;
  if (agent && !AGENTS.includes(agent)) {
    throw new Error(`--agent must be one of ${AGENTS.join('|')} (got ${agent})`);
  }
  const harness = args.harness != null && args.harness !== '' ? args.harness : null;
  const planProvided = args.noPlan || (args.plan != null && args.plan !== '');
  return {
    agent,
    workspace: args.workspace || null,
    harness,
    plan: args.noPlan ? null : (args.plan || null),
    needAgent: !agent,
    needWorkspace: !args.workspace,
    needHarness: !harness,
    needPlan: !planProvided,
  };
}

/**
 * Strict (no-prompt) resolution for `--no-picker`. Pure; throws if the
 * required --agent is missing (can't prompt in scripting mode). Omitted
 * workspace/harness/plan fall back to the server defaults (active
 * workspace, workspace root, no plan).
 */
export function selectionsFromArgs(args) {
  const p = presetsFromArgs(args);
  if (p.needAgent) {
    throw new Error(`--agent must be one of ${AGENTS.join('|')} (got ${String(args.agent)})`);
  }
  return { agent: p.agent, workspace: p.workspace, harness: p.harness, plan: p.plan };
}

function readToken() {
  try {
    return readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function api(path, opts = {}) {
  const token = readToken();
  let res;
  // Retry a transient failure (timeout / connection-refused) once before giving
  // up — a single slow tick or an in-flight host restart shouldn't fail psu.
  // A caller-supplied AbortSignal disables retry (the caller owns the lifetime).
  const maxAttempts = opts.signal ? 1 : API_RETRIES + 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch(OPERATOR_URL + path, {
        ...opts,
        // Without a timeout a wedged operator hangs psu indefinitely. Fail fast.
        signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(opts.headers || {}),
        },
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        process.stderr.write(`psu: ${path} did not respond (attempt ${attempt}/${maxAttempts}) — retrying…\n`);
        await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }
    }
  }
  if (lastErr) {
    const e = lastErr;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(
        `the operator at ${OPERATOR_URL} did not respond within ${REQUEST_TIMEOUT_MS}ms (${path}, ${maxAttempts} attempts). ` +
          `It may be wedged — restart it (systemctl --user restart papercup-dev-api.service), ` +
          `or raise the cap with PAPERCUSP_PSU_TIMEOUT_MS.`,
      );
    }
    throw new Error(
      `could not reach the operator at ${OPERATOR_URL} (${e?.message || e}). ` +
        `Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL.`,
    );
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { status: 'error', error: text.slice(0, 200) };
  }
  if (!res.ok || json.status === 'error') {
    // json.error may be a string OR a structured object ({code, message}) — coerce
    // to a real message so we never surface "[object Object]".
    const err = json.error;
    const msg =
      typeof err === 'string'
        ? err
        : err?.message || (err ? JSON.stringify(err) : `HTTP ${res.status} from ${path}`);
    throw new Error(msg);
  }
  return json;
}

async function pickAgent() {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Agent',
    choices: [
      { name: 'claude', value: 'claude' },
      { name: 'omp', value: 'omp' },
      { name: 'codex', value: 'codex' },
    ],
  });
}

/** Pick a workspace. Harnesses are workspace-scoped, so this comes
 *  before the harness picker. Auto-resolves (no prompt) when there's
 *  0 or 1 workspace. Returns the workspace id (or null → active). */
async function pickWorkspace() {
  const { workspaces, activeWorkspace } = await api('/api/agent-mcp/console/bootstrap-su/options');
  if (!Array.isArray(workspaces) || workspaces.length <= 1) {
    return activeWorkspace ?? (workspaces && workspaces[0] ? workspaces[0].id : null);
  }
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Workspace',
    default: activeWorkspace ?? undefined,
    choices: workspaces.map((w) => ({
      name: w.id === activeWorkspace ? `${w.name}  (active)` : w.name,
      value: w.id,
    })),
  });
}

function filterRows(rows, term) {
  const t = (term || '').toLowerCase();
  return t ? rows.filter((r) => r.name.toLowerCase().includes(t)) : rows;
}

async function pickHarness(workspace) {
  const { search } = await import('@inquirer/prompts');
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const { harnesses, workspace: ws } = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
  const rows = [
    { name: `· workspace root — no harness  [${ws}]`, value: null },
    ...harnesses.map((h) => ({ name: h.status ? `${h.slug}  (${h.status})` : h.slug, value: h.slug })),
  ];
  return search({
    message: 'Harness',
    source: async (term) => filterRows(rows, term),
  });
}

async function pickPlan(workspace, harness) {
  const { search } = await import('@inquirer/prompts');
  let plans = [];
  if (harness) {
    try {
      const params = new URLSearchParams({ harness });
      if (workspace) params.set('workspace', workspace);
      const r = await api(`/api/agent-mcp/console/bootstrap-su/options?${params.toString()}`);
      plans = r.plans || [];
    } catch {
      plans = [];
    }
  }
  const rows = [
    { name: 'NO PLAN — ad-hoc SU session', value: NO_PLAN },
    ...plans.map((p) => ({ name: p.slug, value: p.slug })),
  ];
  return search({
    message: 'Plan',
    source: async (term) => filterRows(rows, term),
  });
}

/** Sentinel for the "no feature" picker row (optional-feature roles). */
const NO_FEATURE = '<no-feature>';

/** Pick the role. 'su' (plain engineer) leads; the known pipeline roles
 *  follow. Returns { role, roles } so the caller reuses the consumes map. */
async function pickRole() {
  const { roles } = await api('/api/agent-mcp/console/bootstrap-su/options');
  const known = Array.isArray(roles) ? roles : [];
  const { select } = await import('@inquirer/prompts');
  const role = await select({
    message: 'Role',
    choices: [
      { name: 'su  — engineer collaborator (full SU catalog)', value: 'su' },
      ...known.map((r) => ({ name: r.id, value: r.id })),
    ],
  });
  return { role, roles: known };
}

/** Role sessions support claude, omp, and codex interactively. codex
 *  runs in a per-session CODEX_HOME (bootstrap-role mints it). */
async function pickRoleBackend() {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Backend',
    choices: [
      { name: 'claude', value: 'claude' },
      { name: 'omp', value: 'omp' },
      { name: 'codex', value: 'codex' },
    ],
  });
}

/** Harness picker that REQUIRES a real harness (role sessions are
 *  harness-scoped — no workspace-root option). */
async function pickHarnessRequired(workspace) {
  const { search } = await import('@inquirer/prompts');
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const { harnesses } = await api(`/api/agent-mcp/console/bootstrap-su/options${q}`);
  const rows = (harnesses || []).map((h) => ({ name: h.status ? `${h.slug}  (${h.status})` : h.slug, value: h.slug }));
  if (rows.length === 0) {
    console.error('psu: no harnesses registered in this workspace — a role session needs one.');
    process.exit(1);
  }
  return search({ message: 'Harness', source: async (term) => filterRows(rows, term) });
}

/** Feature picker. `need` = 'required' (must pick) | 'optional' (offer
 *  a "no feature" row). Returns the feature id or null. */
async function pickFeature(workspace, harness, need) {
  const { search } = await import('@inquirer/prompts');
  let features = [];
  try {
    const params = new URLSearchParams({ harness, features: '1' });
    if (workspace) params.set('workspace', workspace);
    const r = await api(`/api/agent-mcp/console/bootstrap-su/options?${params.toString()}`);
    features = r.features || [];
  } catch {
    features = [];
  }
  const featureRows = features.map((f) => ({
    name: f.title ? `${f.id}  —  ${f.title}${f.status ? `  (${f.status})` : ''}` : f.id,
    value: f.id,
  }));
  const rows = need === 'optional'
    ? [{ name: 'NO FEATURE — run the role unscoped', value: NO_FEATURE }, ...featureRows]
    : featureRows;
  if (rows.length === 0) {
    console.error(`psu: role needs a feature but harness '${harness}' has none.`);
    process.exit(1);
  }
  const picked = await search({ message: 'Feature', source: async (term) => filterRows(rows, term) });
  return picked === NO_FEATURE ? null : picked;
}

/**
 * Should this interactive launch run through the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012)? Pure — exported for tests.
 *
 * Rollout gate. `PAPERCUSP_PSU_NO_PTY=1` is an always-wins kill switch.
 * Otherwise the default is `PTY_DEFAULT_ON`; until the P-015 feel-check is
 * confirmed it's opt-IN via `PAPERCUSP_PSU_PTY=1` so the default launch path
 * stays byte-identical for the live fleet (psu-launcher is exec'd directly — an
 * edit hits every agent's next launch). Needs a real TTY on both ends (we bridge
 * raw mode); a non-TTY launch (the brain dock pane, --no-picker scripts) keeps
 * the plain inherit spawn, which is correct — there's no terminal to bridge.
 */
export const PTY_DEFAULT_ON = false; // TODO(P-012): flip true once the feel-check passes
export function usePtyHost({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (env.PAPERCUSP_PSU_NO_PTY === '1') return false;
  const enabled =
    env.PAPERCUSP_PSU_PTY === '1' ? true : env.PAPERCUSP_PSU_PTY === '0' ? false : PTY_DEFAULT_ON;
  if (!enabled) return false;
  return !!(stdin.isTTY && stdout.isTTY);
}

/** The original plain launch: inherit the user's stdio straight into the child.
 *  The fallback when the managed-pty host is disabled, has no TTY, or fails to
 *  start. */
function spawnInherit({ wrapperBin, args = [], cwd, env }) {
  const child = spawn(wrapperBin, args, { cwd, env, stdio: 'inherit' });
  child.on('error', (e) => {
    console.error(`psu: failed to launch ${wrapperBin}: ${e.message}`);
    console.error(`psu: is ${wrapperBin} on PATH? run apps/operator/scripts/install-standalone-mcp.sh`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function runWrapper({ wrapperBin, args = [], cwd, envelopeEnv }) {
  const env = { ...process.env, ...envelopeEnv };
  // turn-lifecycle-control Phase 3: when enabled + interactive, host the agent
  // through a managed pty + owner-only control socket so the operator can inject
  // a wake (or, Phase 4, an interrupt) into the LIVE session rather than parking
  // it. The discovery key is the coord ownerId (PAPERCUSP_SID); without one the
  // operator can't find the socket, so we keep the plain launch.
  const ownerId = env.PAPERCUSP_SID || null;
  if (ownerId && usePtyHost({ env })) {
    try {
      hostThroughPty({
        command: wrapperBin,
        args,
        cwd,
        env,
        ownerId,
        advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
        onExit: (code) => process.exit(code ?? 0),
      }).catch((e) => {
        // The pty was already spawned (the promise only rejects on an unforeseen
        // bridge error); don't double-spawn — surface + exit non-zero.
        process.stderr.write(`psu: managed-pty host error: ${e?.message ?? e}\n`);
        process.exit(1);
      });
      return;
    } catch (e) {
      // Synchronous failure = the pty never started (node-pty load / spawn). Safe
      // to fall back to the plain inherit launch.
      process.stderr.write(
        `psu: managed-pty host unavailable (${e?.message ?? e}); using a plain launch. ` +
          `Set PAPERCUSP_PSU_NO_PTY=1 to silence.\n`,
      );
    }
  }
  spawnInherit({ wrapperBin, args, cwd, env });
}

function fmtAge(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const ms = Date.now() - t;
  const m = 60_000, h = 3_600_000, d = 86_400_000;
  if (ms < 2 * m) return 'just now';
  if (ms < h) return `${Math.floor(ms / m)}m ago`;
  if (ms < d) return `${Math.floor(ms / h)}h ago`;
  return `${Math.floor(ms / d)}d ago`;
}

/** Resume a resolved session: cd to its recorded cwd + exec the RAW agent's
 *  resume command there (P-042 — no `*-su` wrapper), re-establishing the same
 *  per-session config the wrapper used to bake. */
function launchResume(session) {
  // omp re-loads the coordination extension per invocation; claude/codex don't
  // use -e. Stable path, only added when actually installed.
  const coordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
  const coordExtPath = session.agent === 'omp' && existsSync(coordExt) ? coordExt : undefined;
  const { bin, args } = resumeArgsFor(session, { coordExtPath });

  // Per-session coord/lock owner (a fresh process gets a fresh SID).
  const env = {
    PAPERCUSP_AGENT: session.agent,
    PAPERCUSP_SID: `su-${randomUUID()}`,
    ...(session.id != null ? { PAPERCUSP_ADV_SESSION_ID: String(session.id) } : {}),
  };
  // codex resumes from its per-session CODEX_HOME — derived from the session id
  // (that home still holds the session's history; only re-launching the SAME
  // session rebuilds it). The home's config.toml carries the baked superuser
  // bearer, so no PAPERCUSP_SU_TOKEN is needed.
  if (session.agent === 'codex' && session.id != null) {
    env.CODEX_HOME = join(homedir(), '.papercusp', 'su-codex-homes', `session-${session.id}`);
  }

  console.error(`psu: resuming ${session.agent} in ${session.cwd}  (${bin} ${args.join(' ')})`);
  runWrapper({ wrapperBin: bin, args, cwd: session.cwd, envelopeEnv: env });
}

/** A session that couldn't be matched to a tracked adv_sessions row — either a
 *  genuinely vanilla session, or a psu session that predates native-id tracking
 *  (its id was never recorded, so it can't be linked). Either way the engineer
 *  playbook won't be re-injected (and for codex, the papercusp-su tools — it ran
 *  under ~/.codex). Warn + require explicit confirmation before resuming it as
 *  if it were SU. `--yes` bypasses (scripts); non-interactive without `--yes`
 *  refuses. */
async function confirmUntrackedResume(session, args) {
  const sid = session.sessionId || session.ompThreadId || '?';
  const missing = session.agent === 'codex'
    ? 'the engineer playbook + papercusp-su tools'
    : 'the engineer playbook';
  console.error(
    `psu: ⚠ session ${sid} isn't linked to a tracked psu launch — resuming it as a raw ` +
      `${session.agent} session (${missing} won't be re-injected; ${session.cwd}). ` +
      `Sessions psu started before native-id tracking won't match here either. Resuming continues it as-is.`,
  );
  if (args.yes) { console.error('psu: --yes given; proceeding.'); return; }
  if (!args.picker) {
    console.error('psu: refusing to resume an untracked session non-interactively — re-run without --no-picker, or pass --yes.');
    process.exit(2);
  }
  const { confirm } = await import('@inquirer/prompts');
  const proceed = await confirm({ message: 'Do you want to proceed anyway?', default: false });
  if (!proceed) { console.error('psu: aborted.'); process.exit(0); }
}

// `psu --resume` (picker) or `psu --resume=<id>` / `psu --resume <id>`
// (direct): resume a tracked session by adv id OR its recorded native session
// id, OR an unmatched session by the agent's native session id — cd to its
// recorded cwd and run the agent there.
async function resumeFlow(args = {}) {
  const data = await api('/api/adv/sessions/resumable');
  const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);

  // Direct resume by id — skip the picker.
  if (args.resumeId) {
    // 1. A psu-tracked session (adv_sessions row)? Match the integer adv id OR
    //    the agent's recorded NATIVE session id (the claude --session-id UUID),
    //    so resuming by EITHER handle finds the tracked row — and resumes the
    //    exact session (resumeArgsFor prefers the native id) with NO false
    //    "not started by psu" warning.
    const tracked = sessions.find(
      (s) => String(s.id) === String(args.resumeId) || (s.sessionId && s.sessionId === args.resumeId),
    );
    if (tracked) { launchResume(tracked); return; }

    // 2. Not tracked → search the agents' OWN session stores for the id.
    const untracked = findUntrackedSession(args.resumeId);
    if (!untracked) {
      const ids = sessions.map((s) => s.id).filter((x) => x != null).join(', ');
      console.error(
        `psu: no session "${args.resumeId}" — not a tracked psu session (ids: ${ids || 'none'}), ` +
          `and no claude/codex session file with that id under ~/.claude/projects or ~/.codex/sessions ` +
          `(omp threads resume by thread name).`,
      );
      process.exit(1);
    }

    // 3. Untracked = NOT launched by psu → its engineer playbook (and, for codex,
    //    the papercusp-su tools) are NOT loaded. Require an explicit confirm.
    await confirmUntrackedResume(untracked, args);
    launchResume(untracked);
    return;
  }

  if (sessions.length === 0) {
    console.error('psu: no tracked sessions — launch one with `psu`, or resume a raw session by id with `psu --resume=<session-id>`.');
    process.exit(1);
  }
  const { search } = await import('@inquirer/prompts');
  const rows = sessions.map((s) => ({
    name:
      `${s.id != null ? `#${s.id}  ·  ` : ''}${s.agent}  ·  ${s.planSlug ? `plan ${s.planSlug}` : 'no plan'}  ·  ${s.cwd}  ·  ${fmtAge(s.startedAt)}` +
      `${s.endedAt ? '' : '  · active'}`,
    value: s,
  }));
  const picked = await search({
    message: 'Resume which session?',
    source: async (term) => filterRows(rows, term),
  });
  launchResume(picked);
}

// `psu --brain` (native-terminal-desktop D-013): the desktop chat dock's
// brain pane. Resume THE canonical pinned brain session exactly — no picker,
// no prompt (the dock pane launches non-interactively) — falling back to a
// fresh claude SU launch that the server pins as the new brain when no pin
// exists or the pinned session no longer resolves. The pin is the native
// session uuid in harness_shared.operator_settings (`brain_session_id`),
// written by POST bootstrap-su `brain: true` BEFORE the session's first turn
// (the uuid is server-minted and forced via claude --session-id).
async function brainFlow(args = {}) {
  let pin = null;
  try {
    pin = (await api('/api/agent-mcp/console/bootstrap-su/brain'))?.brainSessionId ?? null;
  } catch (e) {
    // Pin endpoint unavailable (an operator predating D-013, or a DB error).
    // Do NOT fresh-launch here — a server that can't read the pin can't WRITE
    // it either, so every dock open would fork a new unpinned "brain".
    // Degrade to the pre-D-013 behavior: the recent-session resume picker.
    console.error(`psu: brain pin unavailable (${e?.message ?? e}) — falling back to the resume picker.`);
    await resumeFlow(args);
    return;
  }
  if (pin) {
    const data = await api('/api/adv/sessions/resumable');
    const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);
    // The pin is the recorded NATIVE session id of a psu-tracked launch.
    const tracked = sessions.find((s) => s.sessionId && s.sessionId === pin);
    // A tracked adv row alone doesn't prove the session is RESUMABLE: a brain
    // launch that died before its first persisted turn leaves the pin + adv
    // row behind with no claude transcript, and `claude --resume` then fails
    // "No conversation found" on EVERY dock open — a permanent wedge, since
    // the pane is non-interactive (observed 2026-06-06). Verify claude's own
    // store first; a transcript-less session has zero turns, so falling
    // through to the fresh+re-pin path loses nothing.
    if (tracked && (tracked.agent !== 'claude' || claudeStoreHasSession(pin))) {
      launchResume(tracked);
      return;
    }
    if (tracked) {
      console.error(`psu: pinned brain ${pin} is adv-tracked but claude has no transcript for it — launching a fresh brain (re-pinning).`);
    } else {
      // Tracked row gone but the agent's own store still has the transcript
      // (e.g. the adv row was pruned): it IS the brain psu launched — resume it
      // without the untracked-confirm (the dock pane can't drive a prompt).
      const untracked = findUntrackedSession(pin);
      if (untracked) {
        console.error(`psu: brain ${pin} lost its tracked row — resuming from the ${untracked.agent} session store.`);
        launchResume(untracked);
        return;
      }
      console.error(`psu: pinned brain ${pin} no longer resolves anywhere — launching a fresh brain (re-pinning).`);
    }
  }
  // Fresh brain: claude (the pin needs claude's forceable --session-id),
  // server-default workspace unless overridden, no plan. The server records
  // the pin before we exec, so the NEXT `psu --brain` resumes exactly this.
  await launchFreshSu(
    { agent: 'claude', workspace: args.workspace || null, harness: args.harness || null, plan: null },
    args,
    { brain: true },
  );
}

// `psu --role=<role>` (or picking a non-su role): an interactive,
// role-scoped session — role persona + tools + feature context, human at
// the keyboard. Goes through bootstrap-role + execs the raw backend with
// the role prompt + signed role-scoped .mcp.json (NOT a *-su wrapper).
async function roleFlow(args, role, rolesMeta) {
  const consumes = (rolesMeta || []).find((r) => r.id === role)?.consumes ?? { feature: 'none', plan: 'none' };
  let agent, workspace, harness, feature, plan;
  if (args.picker) {
    agent = args.agent || (await pickRoleBackend());
    workspace = args.workspace || (await pickWorkspace());
    harness = args.harness || (await pickHarnessRequired(workspace));
    if (args.feature) feature = args.feature;
    else if (consumes.feature === 'none') feature = null;
    else feature = await pickFeature(workspace, harness, consumes.feature);
    // Plan context for plan-consuming roles (scoper/reviewer). --plan/--no-plan
    // preselect; otherwise offer the plan picker (it has a "NO PLAN" row).
    if (args.noPlan) plan = null;
    else if (args.plan) plan = args.plan;
    else if (consumes.plan === 'none') plan = null;
    else plan = planValue(await pickPlan(workspace, harness));
  } else {
    if (agentInvalidForRole(args.agent)) {
      throw new Error('--agent must be claude, omp, or codex for a role session');
    }
    if (!args.harness) throw new Error('--harness is required for a role session');
    agent = args.agent;
    workspace = args.workspace || null;
    harness = args.harness;
    feature = args.feature || null;
    plan = args.noPlan ? null : (args.plan || null);
  }

  const res = await api('/api/agent-mcp/console/bootstrap-role', {
    method: 'POST',
    body: JSON.stringify({ role, agent, workspace, harness_slug: harness, feature, plan }),
  });

  // omp role sessions load the coordination extension (lock enforcement + coord +
  // the activity-bridge port) via -e, the same stable module the su omp launch +
  // resume use. claude/codex role hooks are user-level / baked into the codex home.
  const roleCoordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
  const roleCoordExtPath = res.agent === 'omp' && existsSync(roleCoordExt) ? roleCoordExt : undefined;
  const { bin, args: launchArgs } = roleLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    mcpJsonPath: res.mcpJsonPath,
    coordExtPath: roleCoordExtPath,
  });
  console.error(
    `psu: ${res.role} on ${res.agent}  ·  ${res.feature ? `feature ${res.feature}` : (res.planSlug ? `plan ${res.planSlug}` : 'no feature')}` +
      `  ·  harness ${res.harnessSlug}  ·  session ${res.sessionId ?? '?'}`,
  );
  console.error(`psu: cwd ${res.cwd}  —  role-scoped MCP (${res.role}); resume from here`);
  runWrapper({ wrapperBin: bin, args: launchArgs, cwd: res.cwd, envelopeEnv: res.envelopeEnv });
}

/** True when an --agent value can't back a role session (claude/omp/codex can). */
export function agentInvalidForRole(agent) {
  return agent !== 'claude' && agent !== 'omp' && agent !== 'codex';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.brain) {
    await brainFlow(args);
    return;
  }
  if (args.resume) {
    await resumeFlow(args);
    return;
  }

  // Resolve the role first: flag wins; else pick (picker mode); else 'su'.
  let role = args.role || null;
  let rolesMeta = null;
  if (!role && args.picker) {
    const picked = await pickRole();
    role = picked.role;
    rolesMeta = picked.roles;
  }
  if (!role) role = 'su';
  if (role !== 'su') {
    await roleFlow(args, role, rolesMeta);
    return;
  }

  // ── plain SU / engineer flow (unchanged) ──
  let selections;
  if (args.picker) {
    // Honor any flags as preselections; prompt only for what was omitted.
    const p = presetsFromArgs(args);
    const agent = p.needAgent ? await pickAgent() : p.agent;
    const workspace = p.needWorkspace ? await pickWorkspace() : p.workspace;
    const harness = p.needHarness ? await pickHarness(workspace) : p.harness;
    const plan = p.needPlan ? planValue(await pickPlan(workspace, harness)) : p.plan;
    selections = { agent, workspace, harness, plan };
  } else {
    selections = selectionsFromArgs(args);
  }

  await launchFreshSu(selections, args);
}

/**
 * POST bootstrap-su + exec the raw backend — the fresh-SU launch tail shared
 * by the plain `psu` flow and `psu --brain`'s fresh-brain fallback. `brain`
 * pins the minted native session id server-side as THE canonical brain
 * (native-terminal-desktop D-013) before the session's first turn.
 */
async function launchFreshSu(selections, args, { brain = false } = {}) {
  const res = await api('/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    body: JSON.stringify({
      agent: selections.agent,
      workspace: selections.workspace,
      harness_slug: selections.harness,
      plan_slug: selections.plan,
      // P-023: playbook profile (engineer|power), assembled per-launch.
      // Omitted → server defaults to engineer.
      ...(args.profile ? { profile: args.profile } : {}),
      ...(brain ? { brain: true } : {}),
      // Our cwd — the server uses it for a no-harness launch (so the
      // agent's cwd-scoped session resume works from the user's terminal,
      // not the internal .papercusp dir). Ignored for harness launches.
      cwd: process.cwd(),
    }),
  });

  // res.cwd is server-decided: the harness repo for a harness launch, or
  // our cwd (above) for a no-harness one. Agents scope resumable sessions
  // by cwd, so resume works from res.cwd.
  console.error(
    `psu: ${res.agent} (su${brain ? ' · BRAIN pinned' : ''})  ·  ${res.planSlug ? `plan ${res.planSlug}` : 'no plan'}  ·  session ${res.sessionId ?? '?'}`,
  );
  console.error(`psu: cwd ${res.cwd}  —  resume this session by running the agent's resume command from here`);

  // P-020: exec the RAW backend (not a *-su wrapper) with the engineer
  // playbook (res.promptFile) + flags. MCP + lock hooks are user-level for
  // claude/omp (they survive a raw launch); codex runs in res.codexHome.
  const { bin, args: baseArgs } = suLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    coordExtPath: res.coordExtPath,
    // Force the recorded native session id on a FRESH launch — but not when
    // this invocation is itself resuming one (--session-id + --resume conflict).
    nativeSessionId: args.resumeSession ? null : res.nativeSessionId,
  });
  // model/resume passthrough (raw-CLI flags: claude/omp --model/-r, codex -m/resume).
  const extra = suWrapperExtraArgs(res.agent, { model: args.model, resumeSession: args.resumeSession });
  const launchArgs = [...baseArgs, ...extra];
  // A kickoff launch-context (server-generated) layers in as a SECOND system
  // prompt for claude/omp; codex would need it folded into AGENTS.md (deferred).
  if (args.launchContext && res.agent !== 'codex') {
    launchArgs.push(res.agent === 'claude' ? '--append-system-prompt-file' : '--append-system-prompt', args.launchContext);
  }

  // codex's superuser bearer is baked into its per-session config.toml
  // server-side (D-006); nothing for psu to export here.
  runWrapper({ wrapperBin: bin, args: launchArgs, cwd: res.cwd, envelopeEnv: { ...res.envelopeEnv } });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (e && (e.name === 'ExitPromptError' || /force closed/i.test(e.message || ''))) {
      console.error('psu: cancelled');
      process.exit(130);
    }
    const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    console.error('psu: ' + msg);
    process.exit(1);
  });
}

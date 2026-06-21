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
import { existsSync, readFileSync, readdirSync, cpSync, mkdirSync } from 'node:fs';
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
// A TIMEOUT means the host accepted but didn't answer within REQUEST_TIMEOUT_MS
// (wedged, not restarting) — a retry just burns another full timeout, so keep
// these few. Tunable via PAPERCUSP_PSU_RETRIES (kept for back-compat).
const TIMEOUT_RETRIES = Number(process.env.PAPERCUSP_PSU_RETRIES) || 1;
// A CONNECTION failure (refused/reset — undici's "fetch failed") almost always
// means the operator is mid-recycle: the memory-watchdog drains + exits and
// systemd restarts a fresh process (~10-15s unreachable per cycle), which on a
// busy box recurs. These fail in milliseconds, so rather than one fixed retry we
// keep retrying on a short backoff until this wall-clock budget elapses — riding
// THROUGH the restart window instead of failing the launch on the first dead
// tick. A genuine outage still fails once the budget is spent. 0 disables.
const _connectRetryRaw = Number(process.env.PAPERCUSP_PSU_CONNECT_RETRY_MS);
const CONNECT_RETRY_BUDGET_MS = Number.isFinite(_connectRetryRaw) ? _connectRetryRaw : 30_000;

/** Parse the scripting-escape flags. Pure — exported for tests. */
export function parseArgs(argv) {
  const out = { picker: true, resume: false, resumeId: null, fork: false, agent: null, role: null, feature: null, workspace: null, harness: null, plan: null, noPlan: false, model: null, resumeSession: null, launchContext: null, profile: null, yes: false, brain: false, account: null, addDir: [], passthrough: [] };
  // Everything after a literal `--` is forwarded VERBATIM to the underlying agent
  // CLI (claude/omp/codex) — a generic escape hatch so a new backend flag needs no
  // psu change. Appended at the END of the launch/resume argv (launchFreshSu /
  // launchResume); ordering past that is the caller's responsibility.
  let rest = false;
  let pendingAddDir = false;
  let pendingAccount = false;
  for (const a of argv) {
    if (rest) { out.passthrough.push(a); continue; }
    // `--add-dir <dir>` (space form) — the previous token armed this; take the
    // value verbatim (even if it looks like a flag, it's the dir the user meant).
    if (pendingAddDir) { pendingAddDir = false; out.addDir.push(a); continue; }
    // `--account <id>` (space form) — the previous token armed this; take the
    // value verbatim (an account id never starts with `--`).
    if (pendingAccount) { pendingAccount = false; out.account = a; continue; }
    if (a === '--') { rest = true; continue; }
    if (a === '--no-picker') out.picker = false;
    // THE brain (native-terminal-desktop D-013): resume the canonical pinned
    // brain session exactly (no picker); when none is pinned (or it no longer
    // resolves) launch a fresh claude SU session and pin it server-side.
    else if (a === '--brain') out.brain = true;
    // `--resume` alone → pick from the recent-session list. `--resume=<id>`
    // (or a bare id after `--resume`) → resume THAT session directly, no
    // picker. The id is the /adv adv_sessions row id OR a backend-native handle:
    // claude session UUID, OMP thread id, or Codex rollout UUID under a tracked
    // CODEX_HOME.
    else if (a === '--resume') out.resume = true;
    else if (a.startsWith('--resume=')) { out.resume = true; out.resumeId = a.slice('--resume='.length) || null; }
    // Fork the resumed session instead of appending to it (claude --fork-session):
    // claude mints a NEW session id seeded with the original's history, leaving the
    // original's id + transcript untouched. psu additionally hands the fork a FRESH
    // coord identity (new PAPERCUSP_SID, no adv-row link — see resumeEnvFor) so it
    // can run CONCURRENTLY with the still-live original without colliding on
    // locks/presence/inbox-wake — the whole point of forking vs. a second --resume.
    // claude-only; resume-only.
    else if (a === '--fork' || a === '--fork-session') out.fork = true;
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
    // First-class `--add-dir <dir>` / `--add-dir=<dir>` (repeatable): the most-asked
    // backend passthrough, lifted out of the generic `--` for discoverability +
    // backend-aware placement. Maps to claude's + codex's native `--add-dir` (omp
    // has none → warned + skipped at launch). Both space + `=` forms; values are
    // forwarded verbatim. See addDirArgs for the per-backend flag mapping.
    else if (a === '--add-dir') pendingAddDir = true;
    else if (a.startsWith('--add-dir=')) { const v = a.slice('--add-dir='.length); if (v) out.addDir.push(v); }
    // psu-account-chooser P-001: pin this session to a specific pool account
    // (`psu --account aviynw6` or `--account=aviynw6`). Threaded to bootstrap-su,
    // which routes the session through the inference-gateway pinned to it
    // (gatewaySpawnEnv); fail-soft to the default credential when the gateway is
    // off or the id is unknown/disallowed.
    else if (a === '--account') pendingAccount = true;
    else if (a.startsWith('--account=')) out.account = a.slice('--account='.length);
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
 * Map psu's repeated `--add-dir <dir>` onto each backend's native flag. claude
 * AND codex both expose `--add-dir` (extra tool-accessible directories); omp has
 * no equivalent → [] (the launch path warns so the user isn't surprised). Pure —
 * exported for tests.
 *
 * Emits the single-`=` token form (`--add-dir=<dir>`), NOT the space form: claude's
 * `--add-dir` is VARIADIC, so a space-form value at the end of the argv would
 * greedily swallow whatever followed (e.g. a `--` passthrough token). The `=` form
 * binds exactly one value per occurrence — the same greed-guard reason
 * NATIVE_SCHEDULER_DENY_FLAG is one `=` token. clap (codex) accepts `=` too.
 */
export function addDirArgs(agent, dirs = []) {
  if (!dirs.length) return [];
  if (agent === 'claude' || agent === 'codex') return dirs.map((d) => `--add-dir=${d}`);
  return [];
}

/**
 * Native-scheduler lockout (native-scheduler-lockout-2026-06-09 D-001/D-002):
 * AGENT sessions (role panes + the brain/Queen) lose claude-code's own
 * scheduling surfaces — Cron* tools, ScheduleWakeup, the schedule/loop
 * skills, and Bash-reachable OS schedulers — so a wake can only live in the
 * harness routines table (the one scheduler Pause/`hive:status`/the liveness
 * backstop can see). The human `psu su` session keeps them (D-003).
 *
 * MUST stay one `=` token: the flag is variadic and the space form greedily
 * eats every following argv element. This plain-node script can't import TS,
 * so the literal mirrors NATIVE_SCHEDULER_DENY + OS_SCHEDULER_BASH_DENY in
 * `@papercusp/orchestrator/native-scheduler-deny`; the lockstep test in
 * `lib/psu-launcher.test.ts` pins the two copies together. Exported for tests.
 */
export const NATIVE_SCHEDULER_DENY_FLAG =
  '--disallowedTools=CronCreate,CronDelete,CronList,ScheduleWakeup,Skill(schedule),Skill(loop),Bash(crontab:*),Bash(systemd-run:*),Bash(batch:*)';

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
export function roleLaunchArgs(backend, { promptFile, mcpJsonPath, coordExtPath, nativeSessionId, replaceClaudeBase } = {}) {
  if (backend === 'claude') {
    // domain-generic-agent-personas-2026-06-17 P-014 (REPLACE_CLAUDE_BASE, default-off):
    // mirror suLaunchArgs — when armed, the role prompt REPLACES the Claude coding base
    // (--system-prompt-file + --exclude-dynamic-system-prompt-sections) so an interactive
    // role session runs on OUR base too (coherent with the fleet + su/brain paths). Flag-off
    // ⇒ --append-system-prompt-file, byte-identical to today.
    const systemPromptArgs = replaceClaudeBase
      ? ['--system-prompt-file', promptFile, '--exclude-dynamic-system-prompt-sections']
      : ['--append-system-prompt-file', promptFile];
    return {
      bin: 'claude',
      args: [
        '--dangerously-skip-permissions',
        ...systemPromptArgs,
        '--mcp-config', mcpJsonPath,
        '--strict-mcp-config',
        // Force the spec-minted session id (mirrors suLaunchArgs) so `psu --resume`
        // and wake-executor resume the EXACT conversation, not `--continue`'s
        // most-recent-in-cwd (a random peer on the shared tree). claude-only.
        ...(nativeSessionId ? ['--session-id', nativeSessionId] : []),
        '--permission-mode', 'bypassPermissions',
        // Agent sessions must schedule ONLY via the harness routines table —
        // never claude's own cron/schedule/loop surfaces (D-001).
        NATIVE_SCHEDULER_DENY_FLAG,
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
    // P-014: --system-prompt (replace) when REPLACE_CLAUDE_BASE armed, else --append.
    const args = [
      '--approval-mode', 'yolo',
      replaceClaudeBase ? '--system-prompt' : '--append-system-prompt', promptFile,
    ];
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
export function suLaunchArgs(backend, { promptFile, coordExtPath, nativeSessionId, replaceClaudeBase } = {}) {
  if (backend === 'claude') {
    // domain-generic-agent-personas-2026-06-17 P-014 (REPLACE_CLAUDE_BASE, default-off):
    // when armed, the playbook REPLACES the Claude coding base (--system-prompt-file +
    // --exclude-dynamic-system-prompt-sections to drop the residual env block) instead of
    // appending to it. Flag-off ⇒ --append-system-prompt-file, byte-identical to today.
    const systemPromptArgs = replaceClaudeBase
      ? ['--system-prompt-file', promptFile, '--exclude-dynamic-system-prompt-sections']
      : ['--append-system-prompt-file', promptFile];
    return {
      bin: 'claude',
      args: [
        '--dangerously-skip-permissions',
        ...systemPromptArgs,
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
    // P-014: --system-prompt (replace) when REPLACE_CLAUDE_BASE armed, else --append.
    const args = [
      '--approval-mode', 'yolo',
      replaceClaudeBase ? '--system-prompt' : '--append-system-prompt', promptFile,
    ];
    if (coordExtPath) args.push('-e', coordExtPath);
    return { bin: 'omp', args };
  }
  if (backend === 'codex') {
    // codex has no --system-prompt flag: its system prompt IS the per-session
    // CODEX_HOME AGENTS.md (the playbook), so codex already carries no Claude base —
    // REPLACE_CLAUDE_BASE is a no-op here (nothing to switch from append to replace).
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
export function resumeArgsFor(session, { coordExtPath, fork = false, forkSessionId = null, addDir = [] } = {}) {
  // --fork-session is a claude concept; omp/codex have no branch-the-session flag,
  // and silently appending to the original would be the very clobber the user asked
  // to avoid. Refuse loudly instead.
  if (fork && session.agent !== 'claude') {
    throw new Error(`--fork is only supported for claude sessions (${session.agent} has no fork-session)`);
  }
  // `session.sessionId` is the agent's NATIVE session id (a UUID) when known —
  // set for store-found (untracked) sessions, so we resume that EXACT session.
  // Without it (tracked rows don't carry the native id) we fall back to the
  // agent's "most-recent-in-cwd" resume.
  if (session.agent === 'claude') {
    const resume = session.sessionId ? ['--resume', session.sessionId] : ['--continue'];
    // --fork-session: branch the resumed conversation into a NEW session id, leaving
    // the original's id + transcript untouched (so the fork is safe to run alongside it).
    // `--session-id <forkSessionId>` FORCES that new id to one psu pre-minted (a
    // tracked fork — launchTrackedFork) so the fork is resumable from the picker, not
    // only by raw uuid. The plain `--session-id`/`--resume` conflict is LIFTED by
    // --fork-session (verified: claude accepts the trio), so only emit the forced id
    // alongside --fork-session.
    const forkFlag = fork
      ? ['--fork-session', ...(forkSessionId ? ['--session-id', forkSessionId] : [])]
      : [];
    return { bin: 'claude', args: [...resume, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', ...forkFlag, ...addDirArgs('claude', addDir)] };
  }
  if (session.agent === 'omp') {
    const args = session.ompThreadId ? ['-r', session.ompThreadId] : ['-c'];
    args.push('--approval-mode', 'yolo');
    if (coordExtPath) args.push('-e', coordExtPath);
    return { bin: 'omp', args };
  }
  if (session.agent === 'codex') {
    // Bypass flags + any --add-dir BEFORE the `resume` subcommand (all top-level
    // codex options). CODEX_HOME (the session's home) is set by the caller.
    // `resume <uuid>` (UUIDs take precedence) for an exact session; `resume --last`
    // otherwise.
    const resume = session.sessionId ? ['resume', session.sessionId] : ['resume', '--last'];
    return { bin: 'codex', args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', ...addDirArgs('codex', addDir), ...resume] };
  }
  throw new Error(`resumeArgsFor: unknown agent: ${session.agent}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * The per-session isolated `CLAUDE_CONFIG_DIR` root + dir for a tracked claude
 * session, keyed by its coord owner id — the .mjs mirror of the TS helper
 * `@papercusp/orchestrator/session-launch-dirs` `sessionClaudeConfigDir` (EI-155).
 *
 * An interactive claude session launches with `CLAUDE_CONFIG_DIR` pointed here
 * (bootstrap-su/role → writeInteractiveClaudeConfig), so it writes its transcript
 * under `<dir>/projects/**` — NOT the shared `~/.claude`. Every resume reader
 * (launchResume, claudeStoreHasSession, findUntrackedSession) must therefore look
 * here, or `claude --resume <uuid>` finds nothing. Pure — `home` for tests; honors
 * the same `PAPERCUSP_SESSION_CLAUDE_DIR` override the materializer uses.
 */
function sessionClaudeRoot(home = homedir()) {
  return process.env.PAPERCUSP_SESSION_CLAUDE_DIR || join(home, '.papercusp', 'session-claude');
}
function sessionClaudeConfigDir(ownerId, home = homedir()) {
  return join(sessionClaudeRoot(home), ownerId);
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

function trackedCodexSessionsRoot(session, home = homedir()) {
  if (session.id == null) return null;
  return join(home, '.papercusp', 'su-codex-homes', `session-${session.id}`, 'sessions');
}

/**
 * Resolve a direct `psu --resume <id>` against tracked adv_sessions rows.
 *
 * Claude records its native UUID at bootstrap, so `sessionId` is enough. OMP
 * learns its native thread id after launch via the coord hook, so match
 * `ompThreadId` too. Codex cannot be forced to a pre-minted id, but its rollout
 * UUID is persisted under the tracked row's isolated CODEX_HOME; when the user
 * passes that UUID, discover the owning row and graft the id onto the transient
 * session object so `resumeArgsFor` can emit `codex resume <uuid>` while
 * `launchResume` still restores that row's CODEX_HOME.
 */
export function resolveTrackedResumeSession(sessions, id, { home = homedir() } = {}) {
  if (!id) return null;
  const wanted = String(id);
  const direct = sessions.find(
    (s) =>
      String(s.id) === wanted ||
      (s.sessionId && s.sessionId === wanted) ||
      (s.ompThreadId && s.ompThreadId === wanted),
  );
  if (direct) return direct;

  if (!UUID_RE.test(wanted)) return null;
  for (const session of sessions) {
    if (session.agent !== 'codex') continue;
    const root = trackedCodexSessionsRoot(session, home);
    if (root && findCodexRollout(root, wanted)) {
      return { ...session, sessionId: wanted };
    }
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
    // EI-155: interactive claude sessions write transcripts under per-session
    // isolated dirs (`<session-claude>/<owner>/projects`), not the shared store —
    // scan those too, so an isolated session whose adv row was pruned still
    // resolves by its native uuid (and carries its `configDir` so the resume
    // points CLAUDE_CONFIG_DIR back at it).
    const isoRoot = sessionClaudeRoot(home);
    for (const owner of safeReaddir(isoRoot)) {
      if (!owner.isDirectory()) continue;
      const configDir = join(isoRoot, owner.name);
      const projects = join(configDir, 'projects');
      for (const d of safeReaddir(projects)) {
        if (!d.isDirectory()) continue;
        const f = join(projects, d.name, `${id}.jsonl`);
        if (existsSync(f)) return { agent: 'claude', sessionId: id, cwd: cwdFromSessionFile(f) || cwd, untracked: true, configDir };
      }
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
export function claudeStoreHasSession(id, { home = homedir(), configDir = null } = {}) {
  if (!id) return false;
  // EI-155: an interactive session's transcript lives in its isolated configDir,
  // not the shared ~/.claude — check that first (when known) before the shared store.
  const roots = [configDir, join(home, '.claude')].filter(Boolean);
  for (const root of roots) {
    const projects = join(root, 'projects');
    for (const d of safeReaddir(projects)) {
      if (d.isDirectory() && existsSync(join(projects, d.name, `${id}.jsonl`))) return true;
    }
  }
  return false;
}

/**
 * Can this tracked session actually be RESUMED — does the agent's own store
 * hold a persisted transcript for it? An adv row is recorded at LAUNCH time
 * (bootstrap-su, before the agent's first turn), but an agent only persists
 * its transcript on the first message — so a launch that died at startup, or
 * a session closed at the prompt, leaves a permanent "ghost" row with nothing
 * to resume (`claude --resume` fails "No conversation found"; measured ~50%
 * of recent rows on the standing dev box, 2026-06-12). The resume picker
 * filters by this so it only offers sessions that can really be resumed.
 *
 * Verification is per-agent and deliberately errs toward KEEPING a row when
 * the store can't be checked by id:
 *   - claude + known sessionId → the EI-155 isolated config dir (else the
 *     shared ~/.claude) must hold `projects/<dir>/<sid>.jsonl`.
 *   - claude, no sessionId (pre-native-id rows) → resume falls back to
 *     `--continue` (most-recent-in-cwd) — not verifiable by id, keep.
 *   - codex + known sessionId + adv row id → the per-session CODEX_HOME must
 *     hold the rollout file; without a row id there is no home to check — keep.
 *   - omp → the thread store isn't path-indexed here — keep.
 * Pure-ish (reads FS); `home` injectable for tests; exported for tests.
 */
export function sessionHasTranscript(session, { home = homedir() } = {}) {
  if (session.agent === 'claude') {
    if (!session.sessionId) return true;
    const configDir =
      session.configDir ||
      (session.coordOwnerId ? sessionClaudeConfigDir(session.coordOwnerId, home) : null);
    return claudeStoreHasSession(session.sessionId, { home, configDir });
  }
  if (session.agent === 'codex') {
    if (!session.sessionId || session.id == null) return true;
    const sessionsRoot = trackedCodexSessionsRoot(session, home);
    return Boolean(findCodexRollout(sessionsRoot, session.sessionId));
  }
  return true;
}

/** Map a plan picker value to the bootstrap-su `plan_slug` (NO_PLAN → null). Pure. */
export function planValue(picked) {
  return picked === NO_PLAN || picked == null || picked === '' ? null : picked;
}

/**
 * Env for a resumed session. Pure — exported for tests. Identity + scope
 * SURVIVE the resume (psu-workspace-scoping fix):
 *   - A tracked row's `coordOwnerId` is re-exported as PAPERCUSP_SID —
 *     wake-executor semantics. The old behavior (fresh random SID per
 *     resume) orphaned the original SID's locks/awaits/presence and
 *     detached the live session from its adv row mid-stream.
 *   - The row's `workspaceId` is re-exported as PAPERCUSP_WORKSPACE — the
 *     carrier claude's user-level MCP url (`${PAPERCUSP_WORKSPACE:-}`) and
 *     omp's x-papercusp-workspace header expand at connect. Without it a
 *     resumed session lost workspace scoping and every workspace-scoped
 *     tool failed "no workspace transaction".
 * Untracked sessions (no adv row) have neither → fresh SID, no workspace;
 * the operator's SID→adv-row fallback can't help those either.
 *
 * `fork: true` INVERTS the identity rule on purpose: a fork is a genuinely new
 * session, not a second body of the original, so it ALWAYS gets a fresh SID and
 * NO adv-row link — that is what lets a fork run concurrently with the still-live
 * original without colliding on its locks/presence/inbox-wake. Workspace scope
 * still carries over (the fork stays in the same workspace).
 */
export function resumeEnvFor(session, { mintSid = () => `su-${randomUUID()}`, fork = false } = {}) {
  if (fork) {
    return {
      PAPERCUSP_AGENT: session.agent,
      PAPERCUSP_SID: mintSid(),
      ...(session.workspaceId ? { PAPERCUSP_WORKSPACE: session.workspaceId } : {}),
    };
  }
  return {
    PAPERCUSP_AGENT: session.agent,
    PAPERCUSP_SID: session.coordOwnerId || mintSid(),
    ...(session.workspaceId ? { PAPERCUSP_WORKSPACE: session.workspaceId } : {}),
    ...(session.id != null ? { PAPERCUSP_ADV_SESSION_ID: String(session.id) } : {}),
  };
}

/**
 * Decide how the account is chosen for a RESUME launch. Pure — exported for
 * tests. The gateway account pin is spawn-env only (never persisted on the
 * session), so a resume otherwise silently falls back to the default credential
 * (verified: launchResume never re-folds gatewaySpawnEnv). Option 1 (owner,
 * 2026-06-19): re-prompt on an interactive resume, neutral default.
 *   - explicit `--account` → honored in ANY mode (no prompt)
 *   - interactive (picker)  → prompt (pickAccount; itself a no-op + no prompt
 *                             when the gateway is off / the pool is empty)
 *   - --no-picker scripting → none → default credential, byte-identical to the
 *                             pre-account resume (no surprise prompt in scripts)
 */
export function resumeAccountPlan(args) {
  if (args.account) return { source: 'flag', account: args.account, prompt: false };
  if (args.picker) return { source: 'prompt', account: null, prompt: true };
  return { source: 'none', account: null, prompt: false };
}

/**
 * The full env for a resume launch — identity + workspace scope (resumeEnvFor),
 * the brain agent-session marker, and the re-pinned account env. Pure — exported
 * for tests. With no `accountEnv` it is byte-identical to the pre-account resume
 * (resumeEnvFor [+ brain marker]); `accountEnv.env` layers the gateway pin on top.
 */
export function buildResumeEnv(session, { fork = false, brain = false, accountEnv = null } = {}) {
  return {
    ...resumeEnvFor(session, { fork }),
    ...(brain ? { PAPERCUSP_AGENT_SESSION: '1' } : {}),
    ...(accountEnv?.env ?? {}),
  };
}

/** The per-account routing header the inference gateway reads + the claude CLI forwards (via
 *  ANTHROPIC_CUSTOM_HEADERS). MUST equal the server's `ACCOUNT_HEADER` (gateway.ts) — pinned in
 *  lockstep by a test. Duplicated here (not imported) so the standalone launcher stays dependency-light. */
export const GATEWAY_ACCOUNT_HEADER = 'x-papercusp-account';

/**
 * The inference-gateway pin env for an account, built CLIENT-SIDE. Pure — exported for tests. Mirrors
 * the server's gatewaySpawnEnv + resolveAccountPin exactly: point the agent at the localhost gateway
 * (which injects the account's OAuth) + carry the per-account routing header the claude CLI forwards.
 * The fresh-launch path gets this folded by the bootstrap-su POST; the RESUME path (no POST) builds it
 * here so it never depends on a server endpoint that may not be deployed where the launcher points.
 */
export function gatewayPinEnv(account) {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  const port = Number.isFinite(p) && p > 0 ? p : 8788;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_CUSTOM_HEADERS: `${GATEWAY_ACCOUNT_HEADER}: ${account}`,
    PAPERCUSP_ACCOUNT_ID: account,
  };
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

/**
 * Resilient fetch: retries CONNECTION failures (refused/reset — "fetch failed",
 * i.e. the operator is mid-recycle) on a short backoff until `connectBudgetMs`
 * elapses, so a launch rides THROUGH a memory-watchdog drain+restart window
 * instead of failing on the first dead tick. TIMEOUTs (reachable but slow —
 * wedged, not restarting) are retried only a small fixed number of times, since
 * each retry costs another full timeout. A caller-supplied `init.signal` owns
 * the request lifetime and disables retry. Returns the Response (caller reads
 * the body); throws a descriptive Error when every attempt fails.
 *
 * Deps are injected for tests (psu-launcher.test.ts) — `fetchImpl`/`sleep`/`now`
 * make the retry timing deterministic without real timers or sockets.
 */
export async function fetchWithResilience(
  url,
  init = {},
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    onNotice = (msg) => process.stderr.write(msg),
    timeoutMs = REQUEST_TIMEOUT_MS,
    connectBudgetMs = CONNECT_RETRY_BUDGET_MS,
    timeoutRetries = TIMEOUT_RETRIES,
    label = url,
  } = {},
) {
  // A caller-supplied AbortSignal owns the request lifetime — never retry it.
  const callerSignal = init.signal ?? null;
  const retryable = !callerSignal;
  // Wall-clock deadline for retrying CONNECTION failures (host mid-recycle).
  const connectDeadline = now() + connectBudgetMs;
  let timeoutRetriesLeft = timeoutRetries;
  let announcedConnRetry = false;
  let lastErr;
  for (;;) {
    try {
      return await fetchImpl(url, {
        ...init,
        // Without a timeout a wedged operator hangs psu indefinitely. Fail fast.
        signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      if (!retryable) break;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (isTimeout) {
        // Reachable but slow (wedged, not restarting) — a retry costs another
        // full timeout, so only a small fixed number of them.
        if (timeoutRetriesLeft <= 0) break;
        timeoutRetriesLeft -= 1;
        onNotice(`psu: ${label} timed out after ${timeoutMs}ms — retrying…\n`);
        await sleep(1_500);
        continue;
      }
      // Connection refused/reset ("fetch failed") — the operator is almost
      // certainly mid-recycle or a deploy swap, unreachable for ~10-15s. Retry
      // on a short backoff until the budget elapses so the launch rides through,
      // instead of failing on the first dead window (the single 1.5s retry this
      // replaced couldn't span a recycle).
      const remaining = connectDeadline - now();
      if (remaining <= 0) break;
      if (!announcedConnRetry) {
        onNotice(
          `psu: operator at ${OPERATOR_URL} unreachable (${label}) — it may be restarting; ` +
            `retrying for up to ${Math.ceil(connectBudgetMs / 1000)}s…\n`,
        );
        announcedConnRetry = true;
      }
      await sleep(Math.min(2_000, remaining));
    }
  }
  const e = lastErr;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    throw new Error(
      `the operator at ${OPERATOR_URL} did not respond within ${timeoutMs}ms (${label}). ` +
        `It may be wedged — restart it (systemctl --user restart papercup-dev-api.service), ` +
        `or raise the cap with PAPERCUSP_PSU_TIMEOUT_MS.`,
    );
  }
  throw new Error(
    `could not reach the operator at ${OPERATOR_URL} after ${Math.ceil(connectBudgetMs / 1000)}s (${e?.message || e}). ` +
      `Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL.`,
  );
}

async function api(path, opts = {}) {
  const token = readToken();
  const res = await fetchWithResilience(
    OPERATOR_URL + path,
    {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    },
    { label: path },
  );
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

/**
 * psu-account-chooser P-005: pick a pool account to pin this session to (gateway
 * routing), or the default credential. Returns the account id, or null for "no pin"
 * — INCLUDING when the picker is hidden: gateway off, an empty pool, or any fetch
 * error (fail-soft — the account step never blocks a launch). The "default" row is
 * FIRST so hitting enter keeps today's behavior; accounts blocked by the active
 * session-override are shown disabled (the server would reject them anyway).
 */
/** The account-pin choices the gateway offers for a workspace (gatewayOn + pool + session-override).
 *  Live `/options` endpoint — deployed everywhere, unlike a bespoke pin endpoint (deploy-skew safe).
 *  null on any error (fail-soft → no pin). */
async function fetchAccountChoices(workspace) {
  try {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    return (await api(`/api/agent-mcp/console/bootstrap-su/options${q}`)).accounts ?? null;
  } catch {
    return null;
  }
}

/** Render the account picker from already-fetched choices. Returns the chosen id, or null for
 *  "default credential — no pin" / an empty pool (gateway off). */
async function promptAccount(accounts) {
  const pool = Array.isArray(accounts?.pool) ? accounts.pool : [];
  if (pool.length === 0) return null; // gateway off / no pool → hidden, byte-identical
  const exclude = new Set(accounts.excludeAccounts ?? []);
  const forced = new Set(accounts.forcedAccounts ?? []);
  const { select } = await import('@inquirer/prompts');
  const choices = [
    { name: '· default credential — no account pin', value: null },
    ...pool.map((id) => {
      const blocked = exclude.has(id) || (forced.size > 0 && !forced.has(id));
      const tag = exclude.has(id) ? '  (excluded)' : forced.size > 0 && !forced.has(id) ? '  (not in allow-list)' : '';
      return { name: `${id}${tag}`, value: id, disabled: blocked ? '(blocked by session-override)' : false };
    }),
  ];
  return select({ message: 'Account (inference-gateway pin)', default: null, choices });
}

async function pickAccount(workspace) {
  const accounts = await fetchAccountChoices(workspace);
  return accounts ? promptAccount(accounts) : null;
}

/** True if `id` is a pinnable account given the gateway choices (pool membership + session-override
 *  allow/exclude). Pure — mirrors the server's resolveAccountPin gating. Exported for tests. */
export function accountPinnable(accounts, id) {
  if (!id || !accounts?.gatewayOn) return false;
  const pool = Array.isArray(accounts.pool) ? accounts.pool : [];
  if (!pool.includes(id)) return false;
  const exclude = accounts.excludeAccounts ?? [];
  const forced = accounts.forcedAccounts ?? [];
  if (exclude.includes(id)) return false;
  if (forced.length > 0 && !forced.includes(id)) return false;
  return true;
}

/**
 * Choose (prompt) / honor (`--account`) the account for a RESUME, then build the inference-gateway
 * pin env CLIENT-SIDE (gatewayPinEnv) — the resume mints no session, so it can't ride the
 * bootstrap-su POST that folds the pin for a fresh launch, and the launcher must not depend on a
 * server endpoint that may not be deployed where it points (the 404 deploy-skew bug). Gating reuses
 * the live `/options` choices. Returns `{ id, env, notice }`: `id` for the FORK path (folded
 * server-side via the bootstrap POST), `env`/`notice` for the in-place resume (launchResume).
 * No prompt + no env when the gateway is off / pool empty / scripting (`--no-picker`).
 */
async function chooseResumeAccount(session, args) {
  const plan = resumeAccountPlan(args);
  if (plan.source === 'none') return { id: null, env: {}, notice: null }; // --no-picker + no --account
  const accounts = await fetchAccountChoices(session.workspaceId);
  if (!accounts?.gatewayOn || !(Array.isArray(accounts.pool) && accounts.pool.length)) {
    // Pinning is a no-op (gateway off / empty pool) → default-credential resume, byte-identical.
    return {
      id: null,
      env: {},
      notice: plan.account ? `--account ${plan.account} ignored: inference gateway off / no pool — using the default credential.` : null,
    };
  }
  const id = plan.prompt ? await promptAccount(accounts) : plan.account;
  if (!id) return { id: null, env: {}, notice: null }; // chose "default credential"
  if (!accountPinnable(accounts, id)) {
    return { id: null, env: {}, notice: `--account ${id} ignored: not an allowed pool account — using the default credential.` };
  }
  return { id, env: gatewayPinEnv(id), notice: `pinned to account ${id} (routed through the inference gateway).` };
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
// P-012/P-015: managed-pty IS the interactive launch path (D-006). Flipped on
// 2026-06-08 after the mechanical feel-check passed end-to-end (a real bash
// driven through the host: cooked-line editing + backspace, $COLUMNS from the
// pty size, Ctrl-C interrupts the foreground job without killing the shell,
// bracketed-paste/readline intact, clean exit). Per-launch escape hatches stay:
// `PAPERCUSP_PSU_PTY=0` opts one launch out, `PAPERCUSP_PSU_NO_PTY=1` is the
// always-wins kill switch. A non-TTY launch (brain dock pane, --no-picker
// scripts) still takes the plain inherit spawn — there's no terminal to bridge.
export const PTY_DEFAULT_ON = true;
export function usePtyHost({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (env.PAPERCUSP_PSU_NO_PTY === '1') return false;
  const enabled =
    env.PAPERCUSP_PSU_PTY === '1' ? true : env.PAPERCUSP_PSU_PTY === '0' ? false : PTY_DEFAULT_ON;
  if (!enabled) return false;
  return !!(stdin.isTTY && stdout.isTTY);
}

/**
 * Supervisor presence beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-004): while psu is the live PARENT of the agent child — which it is in
 * BOTH launch paths (spawnInherit waits + forwards exit; the pty host owns
 * the pty for the session's lifetime) — keep the session's coord_presence
 * row warm via the bootstrap-su heartbeat endpoint. Process-alive semantics,
 * the interactive analog of the fleet nursery beat (operator-spawn.ts
 * ensureSpawnHeartbeatLoop): an agent in an hour-long turn making NO tool
 * calls stays live; the beat dies with this process (child exit →
 * process.exit kills the timer; the timer is unref'd so it never holds psu
 * open on its own).
 *
 * Quiet + fail-soft by design: a down/wedged operator means missed beats,
 * never terminal spam or an error loop. touchHeartbeat server-side is a
 * no-op when no presence row exists (D-003) — declare-intent at session
 * start mints the row, this only keeps it warm.
 *
 * Exported with injectables for tests (scripts/__tests__).
 */
export const SUPERVISOR_BEAT_MS = 60_000;
export function startSupervisorBeat(
  ownerId,
  { fetchImpl = fetch, intervalMs = SUPERVISOR_BEAT_MS, operatorUrl = OPERATOR_URL, token = null, setIntervalImpl = setInterval } = {},
) {
  if (!ownerId) return null;
  const beat = async () => {
    try {
      const tok = token ?? readToken();
      await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/heartbeat', {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: {
          'content-type': 'application/json',
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({ ownerId }),
      });
    } catch {
      /* missed beat — the next tick retries; never surface */
    }
  };
  const timer = setIntervalImpl(() => { void beat(); }, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();
  void beat(); // immediate first beat so a fresh session is warm at once
  return timer;
}

/**
 * Best-effort "my child exited" report: stamps the tracked adv row's
 * ended_at/exit_code (bootstrap-su/session-ended), so the resume picker and
 * roster stop showing dead sessions as `· active` and the session-dir GC's
 * open-row protection actually expires. psu is the live parent in BOTH launch
 * paths (the same property the supervisor beat rides), so child-exit is the
 * one reliable place to stamp it. Awaited with a short timeout because psu
 * process.exit()s right after; any failure — operator down, endpoint not yet
 * deployed (an older release 404s) — is swallowed: end-stamping is telemetry,
 * never a reason to hold the user's terminal open. Exported with injectables
 * for tests. Never rejects.
 */
export async function reportSessionEnded(
  advSessionId,
  exitCode,
  { fetchImpl = fetch, operatorUrl = OPERATOR_URL, token = null, timeoutMs = 2_000 } = {},
) {
  if (!advSessionId) return;
  try {
    const tok = token ?? readToken();
    await fetchImpl(operatorUrl + '/api/agent-mcp/console/bootstrap-su/session-ended', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify({ advSessionId: Number(advSessionId), exitCode: exitCode ?? null }),
    });
  } catch {
    /* best-effort — never surface */
  }
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
    void reportSessionEnded(env.PAPERCUSP_ADV_SESSION_ID || null, code).finally(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
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
  // liveness-hardening P-004: supervisor beat covers BOTH launch paths below.
  startSupervisorBeat(ownerId);
  if (ownerId && usePtyHost({ env })) {
    try {
      hostThroughPty({
        command: wrapperBin,
        args,
        cwd,
        env,
        ownerId,
        advSessionId: env.PAPERCUSP_ADV_SESSION_ID || null,
        onExit: (code) => {
          void reportSessionEnded(env.PAPERCUSP_ADV_SESSION_ID || null, code).finally(() =>
            process.exit(code ?? 0),
          );
        },
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
 *  per-session config the wrapper used to bake. `brain` marks the resumed
 *  session as the pinned brain (Queen) — an AGENT, so it re-applies the
 *  native-scheduler lockout the human resume path deliberately skips
 *  (flags don't persist into resumes; every brain dock-open re-arms it). */
function launchResume(session, { brain = false, fork = false, passthrough = [], addDir = [], accountEnv = null } = {}) {
  // --fork is claude-only — refuse early with a clear message rather than letting
  // resumeArgsFor throw a terse error (or, worse, appending to the original, which
  // is the clobber --fork exists to avoid).
  if (fork && session.agent !== 'claude') {
    console.error(`psu: --fork is only supported for claude sessions — ${session.agent} has no fork-session. Re-run without --fork to resume in place.`);
    process.exit(2);
  }
  if (addDir.length && session.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  // omp re-loads the coordination extension per invocation; claude/codex don't
  // use -e. Stable path, only added when actually installed.
  const coordExt = join(homedir(), '.papercusp', 'papercusp-coord.ts');
  const coordExtPath = session.agent === 'omp' && existsSync(coordExt) ? coordExt : undefined;
  const { bin, args } = resumeArgsFor(session, { coordExtPath, fork, addDir });
  if (brain && session.agent === 'claude') args.push(NATIVE_SCHEDULER_DENY_FLAG);
  // Generic `--` passthrough, forwarded verbatim after psu's own resume flags.
  if (passthrough.length) args.push(...passthrough);

  // Identity + workspace scope survive the resume (see resumeEnvFor) — except a
  // FORK, which deliberately takes a fresh coord identity + no adv-row link so it
  // can run alongside the still-live original it branched from. `accountEnv` re-pins
  // the inference-gateway account (spawn-env only, otherwise lost on resume); the
  // agent-session marker arms the hook-level scheduler guard (bash gate / omp
  // coord-hook) for the brain only — never the owner's own sessions (D-003).
  const env = buildResumeEnv(session, { fork, brain, accountEnv });
  // EI-155: a claude session launched with per-session transcript isolation wrote
  // its transcript under an isolated CLAUDE_CONFIG_DIR (keyed by coord owner id),
  // NOT the shared ~/.claude — point the resume back at it or `claude --resume
  // <uuid>` finds "No conversation found". `session.configDir` (an untracked
  // isolated session resolved by findUntrackedSession) wins; else derive from the
  // tracked row's coordOwnerId. Only when it exists — sessions launched before
  // EI-155 used the shared store and want no override.
  if (session.agent === 'claude') {
    const dir = session.configDir
      || (session.coordOwnerId ? sessionClaudeConfigDir(session.coordOwnerId) : null);
    if (dir && existsSync(dir)) env.CLAUDE_CONFIG_DIR = dir;
  }
  // codex resumes from its per-session CODEX_HOME — derived from the session id
  // (that home still holds the session's history; only re-launching the SAME
  // session rebuilds it). The home's config.toml carries the baked superuser
  // bearer, so no PAPERCUSP_SU_TOKEN is needed.
  if (session.agent === 'codex' && session.id != null) {
    env.CODEX_HOME = join(homedir(), '.papercusp', 'su-codex-homes', `session-${session.id}`);
  }

  // Surface whether the account re-pin took effect (or the fail-soft reason it
  // was skipped) so a resume is never silently unpinned — mirrors launchFreshSu.
  if (accountEnv?.notice) console.error(`psu: account — ${accountEnv.notice}`);
  console.error(`psu: ${fork ? 'forking' : 'resuming'} ${session.agent} in ${session.cwd}  (${bin} ${args.join(' ')})`);
  runWrapper({ wrapperBin: bin, args, cwd: session.cwd, envelopeEnv: env });
}

/**
 * The bootstrap-su POST body that mints the NEW tracked row + native id for a
 * fork. Pure — exported for tests. A fork carries over the original's workspace +
 * plan and lands in the ORIGINAL's cwd (harness_slug:null so the server doesn't
 * relocate cwd — the seeded transcript is keyed by the original's cwd, and claude
 * resolves --resume by CLAUDE_CONFIG_DIR + the encoded cwd it runs in, so the fork
 * MUST run in that same cwd). agent is always claude (the only fork-session backend).
 */
export function forkBootstrapBody(session, account = null) {
  return {
    agent: 'claude',
    workspace: session.workspaceId || null,
    harness_slug: null,
    plan_slug: session.planSlug || null,
    cwd: session.cwd,
    // A tracked fork mints a fresh session, so the gateway account pin is folded
    // server-side (resolveAccountPin) into the new launch envelope — the same path
    // a fresh psu launch takes. Omitted → no `account` key (byte-identical).
    ...(account ? { account } : {}),
  };
}

/**
 * src/dst for seeding a fork's fresh isolated config dir with the original's
 * transcripts. Pure — exported for tests. We copy the whole `projects/` subtree
 * (the original's per-session dir holds essentially just <origId>.jsonl) so that
 * whichever encoded-cwd dir claude looks under, the original transcript is present
 * to --resume from.
 */
export function forkSeedPaths(origConfigDir, forkConfigDir) {
  return { src: join(origConfigDir, 'projects'), dst: join(forkConfigDir, 'projects') };
}

/**
 * `psu --resume <tracked-claude> --fork` → a NEW *tracked* session. Unlike the
 * plain (untracked) fork (launchResume + fork, which lets claude mint a random id
 * with no adv row), this:
 *   1. mints a fresh adv_sessions row + native id via bootstrap-su (same envelope
 *      a fresh psu session gets: per-session CLAUDE_CONFIG_DIR, coord owner id, MCP),
 *   2. SEEDS that fresh config dir with the original's transcript (forkSeedPaths),
 *   3. launches `claude --resume <origId> --fork-session --session-id <forkId>` so
 *      claude forks the history into the psu-known id (verified: the trio is valid).
 * The fork therefore shows up in `psu --resume`'s picker like any other psu session.
 * Its coord identity (PAPERCUSP_SID) is fresh (a NEW row), so it runs concurrently
 * with the still-live original without colliding on locks/presence/inbox-wake.
 *
 * No engineer-playbook re-injection (unlike launchFreshSu): the forked history
 * already carries the original's system prompt — appending it again would double it.
 *
 * Falls back to the plain untracked fork (launchResume) when the session isn't a
 * forkable tracked claude session, or when bootstrap-su is unreachable/incomplete —
 * so `--fork` never hard-fails on the tracked path.
 */
async function launchTrackedFork(session, args = {}, acct = { id: null, env: {}, notice: null }) {
  // The account re-pin: a TRACKED fork folds it server-side (forkBootstrapBody →
  // resolveAccountPin), like a fresh launch; an UNTRACKED fallback re-pins client-
  // side via accountEnv (it never hits bootstrap-su).
  const forkOpts = {
    fork: true,
    passthrough: args.passthrough,
    addDir: args.addDir,
    accountEnv: { env: acct?.env ?? {}, notice: acct?.notice ?? null },
  };
  const forkable = session.agent === 'claude' && session.sessionId && session.coordOwnerId && session.id != null;
  if (!forkable) {
    // Untracked claude (no adv row) → the plain untracked fork; non-claude →
    // launchResume refuses with a clear message. Either way defer to launchResume.
    launchResume(session, forkOpts);
    return;
  }
  let res;
  try {
    res = await api('/api/agent-mcp/console/bootstrap-su', {
      method: 'POST',
      body: JSON.stringify(forkBootstrapBody(session, acct?.id ?? null)),
    });
  } catch (e) {
    console.error(`psu: fork bootstrap failed (${e?.message ?? e}) — falling back to an UNTRACKED fork (resumable only by uuid).`);
    launchResume(session, forkOpts);
    return;
  }
  const forkId = res?.nativeSessionId || null;
  const forkConfigDir = res?.envelopeEnv?.CLAUDE_CONFIG_DIR || null;
  if (!forkId || !forkConfigDir) {
    console.error('psu: fork bootstrap returned no native id / config dir — falling back to an UNTRACKED fork (resumable only by uuid).');
    launchResume(session, forkOpts);
    return;
  }
  // Seed the fork's empty per-session config dir with the original's transcript so
  // `claude --resume <origId>` resolves there; the forked turns then write
  // <forkId>.jsonl in the fork's OWN dir (keyed by its fresh coord owner id).
  const origConfigDir = session.configDir || sessionClaudeConfigDir(session.coordOwnerId);
  const { src, dst } = forkSeedPaths(origConfigDir, forkConfigDir);
  try {
    if (existsSync(src)) { mkdirSync(dst, { recursive: true }); cpSync(src, dst, { recursive: true }); }
    else console.error(`psu: original transcript dir not found (${src}) — claude --resume may fail to find it.`);
  } catch (e) {
    console.error(`psu: could not seed the fork transcript (${e?.message ?? e}) — continuing; claude --resume may not find the original.`);
  }
  // Resume the ORIGINAL's id, fork into the FORCED fork id. No playbook re-inject.
  const { bin, args: forkArgs } = resumeArgsFor(session, { fork: true, forkSessionId: forkId, addDir: args.addDir });
  if (args.passthrough?.length) forkArgs.push(...args.passthrough);
  console.error(
    `psu: forking claude ${session.sessionId} → tracked session #${res.sessionId ?? '?'} (${forkId}) in ${session.cwd}  (${bin} ${forkArgs.join(' ')})`,
  );
  console.error('psu: the fork is a NEW tracked session — it appears in `psu --resume`; the original is untouched.');
  // Surface the account pin outcome the POST resolved (fold or fail-soft reason).
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);
  // Run in the ORIGINAL's cwd (the seeded transcript is keyed by it); the fresh
  // bootstrap envelope (config dir / coord id / MCP) makes it a proper SU session.
  runWrapper({ wrapperBin: bin, args: forkArgs, cwd: session.cwd, envelopeEnv: { ...res.envelopeEnv } });
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
// (direct): resume a tracked session by adv id, recorded native session id,
// linked OMP thread id, or Codex rollout UUID under a tracked CODEX_HOME. If
// none match, fall back to an unmatched session by the agent's native store id.
// Either way, cd to the recorded cwd and run the agent there.
async function resumeFlow(args = {}) {
  const data = await api('/api/adv/sessions/resumable');
  const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);

  // Direct resume by id — skip the picker.
  if (args.resumeId) {
    // 1. A psu-tracked session (adv_sessions row)? Match the integer adv id,
    //    the agent's recorded NATIVE session id (claude), linked native thread
    //    id (OMP), or discovered rollout UUID in the tracked CODEX_HOME
    //    (Codex). Resuming by any handle finds the tracked row with NO false
    //    "not started by psu" warning.
    const tracked = resolveTrackedResumeSession(sessions, args.resumeId);
    if (tracked) {
      // A tracked row alone doesn't prove resumability — a launch that died
      // (or was closed) before its first persisted message has NO transcript,
      // and the raw `--resume` would fail "No conversation found". Say why
      // instead of letting the agent CLI fail cryptically.
      if (!sessionHasTranscript(tracked)) {
        console.error(
          `psu: session #${tracked.id} (${tracked.agent}${tracked.sessionId ? ` ${tracked.sessionId}` : ''}) ` +
            `has no persisted transcript — it died or was closed before its first message, so there is no ` +
            `conversation to resume. Pick a different session with \`psu --resume\`.`,
        );
        process.exit(1);
      }
      // Re-pin the gateway account (prompt when interactive / honor --account) —
      // the pin is spawn-env only, so a resume otherwise drops it (option 1).
      const acct = await chooseResumeAccount(tracked, args);
      if (args.fork) { await launchTrackedFork(tracked, args, acct); return; }
      launchResume(tracked, { passthrough: args.passthrough, addDir: args.addDir, accountEnv: { env: acct.env, notice: acct.notice } });
      return;
    }

    // 2. Not tracked → search the agents' OWN session stores for the id.
    const untracked = findUntrackedSession(args.resumeId);
    if (!untracked) {
      const ids = sessions.map((s) => s.id).filter((x) => x != null).join(', ');
      console.error(
        `psu: no session "${args.resumeId}" — not a tracked psu session (ids: ${ids || 'none'}), ` +
          `and no claude/codex session file with that id under ~/.claude/projects, tracked CODEX_HOME dirs, or ~/.codex/sessions ` +
          `(omp threads resume by thread name).`,
      );
      process.exit(1);
    }

    // 3. Untracked = NOT launched by psu → its engineer playbook (and, for codex,
    //    the papercusp-su tools) are NOT loaded. Require an explicit confirm.
    await confirmUntrackedResume(untracked, args);
    // An untracked session has no adv row to seed a tracked fork from — fork it in
    // place (claude mints a random id; resumable only by uuid). launchResume handles it.
    // Account re-pin applies here too (a raw resume can be routed through the gateway).
    const acct = await chooseResumeAccount(untracked, args);
    launchResume(untracked, { fork: args.fork, passthrough: args.passthrough, addDir: args.addDir, accountEnv: { env: acct.env, notice: acct.notice } });
    return;
  }

  // Only offer sessions whose agent store actually holds a transcript — a row
  // recorded at launch whose session never persisted a first message is a
  // permanent ghost ("No conversation found" on every attempt). Say how many
  // were hidden so a "where did my session go?" has an answer.
  const resumable = sessions.filter((s) => sessionHasTranscript(s));
  const ghostCount = sessions.length - resumable.length;
  if (ghostCount > 0) {
    console.error(
      `psu: hiding ${ghostCount} session(s) with no persisted transcript (died or closed before the first message) — they cannot be resumed.`,
    );
  }
  if (resumable.length === 0) {
    console.error('psu: no resumable sessions — launch one with `psu`, or resume a raw session by id with `psu --resume=<session-id>`.');
    process.exit(1);
  }
  const { search } = await import('@inquirer/prompts');
  const rows = resumable.map((s) => ({
    name:
      `${s.id != null ? `#${s.id}  ·  ` : ''}${s.agent}  ·  ${s.planSlug ? `plan ${s.planSlug}` : 'no plan'}  ·  ${s.cwd}  ·  ${fmtAge(s.startedAt)}` +
      `${s.endedAt ? '' : '  · active'}`,
    value: s,
  }));
  const picked = await search({
    message: 'Resume which session?',
    source: async (term) => filterRows(rows, term),
  });
  // Re-pin the gateway account (prompt when interactive / honor --account) before
  // resuming — the pin is spawn-env only, otherwise lost on resume (option 1).
  const acct = await chooseResumeAccount(picked, args);
  if (args.fork) { await launchTrackedFork(picked, args, acct); return; }
  launchResume(picked, { passthrough: args.passthrough, addDir: args.addDir, accountEnv: { env: acct.env, notice: acct.notice } });
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
    // EI-908: the brain pin is workspace-scoped. Pass our workspace when one
    // was given so a non-active-workspace `psu --brain` resolves ITS pin;
    // omitted → the server defaults to the active workspace (the dock case).
    const brainQ = args.workspace ? `?workspace=${encodeURIComponent(args.workspace)}` : '';
    pin = (await api(`/api/agent-mcp/console/bootstrap-su/brain${brainQ}`))?.brainSessionId ?? null;
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
    // EI-155: the brain's transcript lives in its per-session isolated config dir
    // (keyed by coordOwnerId), not the shared ~/.claude — check there, else every
    // dock open would see "no transcript" and fork a fresh brain forever.
    const brainConfigDir = tracked?.coordOwnerId ? sessionClaudeConfigDir(tracked.coordOwnerId) : null;
    if (tracked && (tracked.agent !== 'claude' || claudeStoreHasSession(pin, { configDir: brainConfigDir }))) {
      launchResume(tracked, { brain: true });
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
        launchResume(untracked, { brain: true });
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
    agent = args.agent;
    workspace = args.workspace || null;
    // No --harness = a WORKSPACE-LEVEL role session (owner-confirmed,
    // hive-agent-tabs P-003: operator/planner launch harness-less — the SU
    // model). bootstrap-role still 400s a feature-consuming role without one.
    harness = args.harness || null;
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
    // Force the native session id the spec minted (claude only) so the session's
    // conversation id is known up-front and wake-executor can `--resume <uuid>`
    // EXACTLY it — never `--continue`'s most-recent-in-cwd peer on the shared
    // tree (unify-launch-mechanics P-003 invariant d).
    nativeSessionId: res.envelopeEnv?.PAPERCUSP_NATIVE_SESSION_ID || null,
    // P-014: REPLACE_CLAUDE_BASE — bootstrap-role resolves the flag server-side and threads
    // it via envelopeEnv (same env the fleet + su paths read). Off/absent ⇒ --append (today).
    replaceClaudeBase: res.envelopeEnv?.PAPERCUSP_REPLACE_CLAUDE_BASE === '1',
  });
  if (args.addDir?.length && res.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  // First-class --add-dir (claude/codex) + generic `--` passthrough, forwarded to the
  // backend CLI after psu's role flags — parity with the su (launchFreshSu) + resume paths.
  const roleArgs = [...launchArgs, ...addDirArgs(res.agent, args.addDir || []), ...(args.passthrough || [])];
  console.error(
    `psu: ${res.role} on ${res.agent}  ·  ${res.feature ? `feature ${res.feature}` : (res.planSlug ? `plan ${res.planSlug}` : 'no feature')}` +
      `  ·  ${res.harnessSlug ? `harness ${res.harnessSlug}` : 'workspace-level (no harness)'}  ·  session ${res.sessionId ?? '?'}`,
  );
  console.error(`psu: cwd ${res.cwd}  —  role-scoped MCP (${res.role}); resume from here`);
  // Role sessions are AGENT sessions across all backends: the marker arms the
  // hook-level scheduler guard (bash gate / omp coord-hook / codex hooks.json)
  // (native-scheduler-lockout P-010).
  runWrapper({
    wrapperBin: bin,
    args: roleArgs,
    cwd: res.cwd,
    envelopeEnv: { ...res.envelopeEnv, PAPERCUSP_AGENT_SESSION: '1' },
  });
}

/** True when an --agent value can't back a role session (claude/omp/codex can). */
export function agentInvalidForRole(agent) {
  return agent !== 'claude' && agent !== 'omp' && agent !== 'codex';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --fork only has meaning when resuming an existing session — warn (don't fail)
  // so a stray `psu --fork` on a fresh launch doesn't silently look honored.
  if (args.fork && !args.resume) {
    console.error('psu: --fork only applies with --resume (it branches an existing session); ignoring it for this fresh launch.');
  }
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
    // psu-account-chooser P-005: offer a pool-account pin when one is meaningful
    // (gateway on + a non-empty pool). pickAccount returns null — and prompts
    // nothing — otherwise, so the default launch stays byte-identical.
    if (!args.account) args.account = await pickAccount(workspace);
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
      // psu-account-chooser P-001: pin this session to a pool account. The server
      // validates it (pool membership + session-override allow-list) and, when the
      // gateway is on, folds gatewaySpawnEnv into the launch envelope; fail-soft.
      ...(args.account ? { account: args.account } : {}),
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
  // psu-account-chooser: surface whether the `--account` pin took effect (or the
  // fail-soft reason it was skipped) so the user is never silently unpinned.
  if (res.accountNotice) console.error(`psu: account — ${res.accountNotice}`);

  // P-020: exec the RAW backend (not a *-su wrapper) with the engineer
  // playbook (res.promptFile) + flags. MCP + lock hooks are user-level for
  // claude/omp (they survive a raw launch); codex runs in res.codexHome.
  const { bin, args: baseArgs } = suLaunchArgs(res.agent, {
    promptFile: res.promptFile,
    coordExtPath: res.coordExtPath,
    // Force the recorded native session id on a FRESH launch — but not when
    // this invocation is itself resuming one: claude rejects --session-id with
    // --resume/--continue *unless* --fork-session is also present (that exception
    // is what launchTrackedFork relies on; see resumeArgsFor).
    nativeSessionId: args.resumeSession ? null : res.nativeSessionId,
    // P-014: REPLACE_CLAUDE_BASE — bootstrap-su resolves the flag server-side and
    // threads it via envelopeEnv (same env name the fleet path reads). Off/absent ⇒
    // suLaunchArgs uses --append (byte-identical to today).
    replaceClaudeBase: res.envelopeEnv?.PAPERCUSP_REPLACE_CLAUDE_BASE === '1',
  });
  // model/resume passthrough (raw-CLI flags: claude/omp --model/-r, codex -m/resume).
  const extra = suWrapperExtraArgs(res.agent, { model: args.model, resumeSession: args.resumeSession });
  if (args.addDir?.length && res.agent === 'omp') {
    console.error('psu: omp has no --add-dir; ignoring it. Pass a backend flag verbatim with `-- <flag>` if omp supports one.');
  }
  // First-class --add-dir (claude/codex) then the generic `--` passthrough — both
  // forwarded verbatim to the backend CLI after psu's own flags.
  const launchArgs = [...baseArgs, ...extra, ...addDirArgs(res.agent, args.addDir || []), ...(args.passthrough || [])];
  // The brain (Queen) is an AGENT riding the su launch machinery — it gets the
  // native-scheduler lockout the human su session deliberately keeps (D-003).
  if (brain && res.agent === 'claude') launchArgs.push(NATIVE_SCHEDULER_DENY_FLAG);
  // A kickoff launch-context (server-generated) layers in as a SECOND system
  // prompt for claude/omp; codex would need it folded into AGENTS.md (deferred).
  if (args.launchContext && res.agent !== 'codex') {
    launchArgs.push(res.agent === 'claude' ? '--append-system-prompt-file' : '--append-system-prompt', args.launchContext);
  }

  // codex's superuser bearer is baked into its per-session config.toml
  // server-side (D-006); nothing for psu to export here.
  runWrapper({
    wrapperBin: bin,
    args: launchArgs,
    cwd: res.cwd,
    // The brain (Queen) is an agent: arm the hook-level scheduler guard. A
    // plain human su launch never sets the marker (native-scheduler-lockout
    // D-003).
    envelopeEnv: { ...res.envelopeEnv, ...(brain ? { PAPERCUSP_AGENT_SESSION: '1' } : {}) },
  });
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

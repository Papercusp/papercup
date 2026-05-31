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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENTS = ['claude', 'omp', 'codex'];
/** Sentinel value for the "NO PLAN" picker row. Uses non-slug chars
 *  (`<`/`>`) so it can never collide with a real plan slug. */
export const NO_PLAN = '<no-plan>';

const OPERATOR_URL = process.env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070';

/** Parse the scripting-escape flags. Pure — exported for tests. */
export function parseArgs(argv) {
  const out = { picker: true, resume: false, agent: null, workspace: null, harness: null, plan: null, noPlan: false };
  for (const a of argv) {
    if (a === '--no-picker') out.picker = false;
    else if (a === '--resume') out.resume = true;
    else if (a === '--no-plan') out.noPlan = true;
    else if (a.startsWith('--agent=')) out.agent = a.slice('--agent='.length);
    else if (a.startsWith('--workspace=')) out.workspace = a.slice('--workspace='.length);
    else if (a.startsWith('--harness=')) out.harness = a.slice('--harness='.length);
    else if (a.startsWith('--plan=')) out.plan = a.slice('--plan='.length);
  }
  return out;
}

/**
 * Per-agent resume command. Pure — exported for tests. Returns the
 * `*-su` wrapper to exec + the resume args. Semantics: claude/omp
 * continue the most recent conversation in the session's cwd (omp can
 * target an exact thread when one was captured); codex resumes its most
 * recent session.
 */
export function resumeArgsFor(session) {
  const wrapperBin = { claude: 'claude-su', omp: 'omp-su', codex: 'codex-su' }[session.agent];
  if (!wrapperBin) throw new Error(`unknown agent: ${session.agent}`);
  let args;
  if (session.agent === 'omp') args = session.ompThreadId ? ['-r', session.ompThreadId] : ['-c'];
  else if (session.agent === 'codex') args = ['resume', '--last'];
  else args = ['--continue'];
  return { wrapperBin, args };
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
  try {
    res = await fetch(OPERATOR_URL + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
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
    throw new Error(json.error || `HTTP ${res.status} from ${path}`);
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

function runWrapper({ wrapperBin, args = [], cwd, envelopeEnv }) {
  const child = spawn(wrapperBin, args, {
    cwd,
    env: { ...process.env, ...envelopeEnv },
    stdio: 'inherit',
  });
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

// `psu --resume`: pick a recent tracked session, cd to its recorded cwd,
// and resume the agent there — so resume works no matter where the
// session was launched from.
async function resumeFlow() {
  const { search } = await import('@inquirer/prompts');
  const data = await api('/api/adv/sessions/resumable');
  const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);
  if (sessions.length === 0) {
    console.error('psu: no resumable sessions found — launch one with `psu` first.');
    process.exit(1);
  }
  const rows = sessions.map((s) => ({
    name:
      `${s.agent}  ·  ${s.planSlug ? `plan ${s.planSlug}` : 'no plan'}  ·  ${s.cwd}  ·  ${fmtAge(s.startedAt)}` +
      `${s.endedAt ? '' : '  · active'}`,
    value: s,
  }));
  const picked = await search({
    message: 'Resume which session?',
    source: async (term) => filterRows(rows, term),
  });

  const { wrapperBin, args } = resumeArgsFor(picked);
  console.error(`psu: resuming ${picked.agent} in ${picked.cwd}  (${wrapperBin} ${args.join(' ')})`);
  runWrapper({
    wrapperBin,
    args,
    cwd: picked.cwd,
    envelopeEnv: {
      PAPERCUSP_AGENT: picked.agent,
      ...(picked.id != null ? { PAPERCUSP_ADV_SESSION_ID: String(picked.id) } : {}),
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.resume) {
    await resumeFlow();
    return;
  }
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

  const res = await api('/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    body: JSON.stringify({
      agent: selections.agent,
      workspace: selections.workspace,
      harness_slug: selections.harness,
      plan_slug: selections.plan,
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
    `psu: ${res.agent} -> ${res.wrapperBin}  ·  ${res.planSlug ? `plan ${res.planSlug}` : 'no plan'}` +
      `  ·  session ${res.sessionId ?? '?'}`,
  );
  console.error(`psu: cwd ${res.cwd}  —  resume this session by running the agent's resume command from here`);
  runWrapper({ wrapperBin: res.wrapperBin, cwd: res.cwd, envelopeEnv: res.envelopeEnv });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (e && (e.name === 'ExitPromptError' || /force closed/i.test(e.message || ''))) {
      console.error('psu: cancelled');
      process.exit(130);
    }
    console.error('psu: ' + (e?.message || e));
    process.exit(1);
  });
}

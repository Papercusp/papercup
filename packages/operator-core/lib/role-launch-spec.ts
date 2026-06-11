/**
 * role-launch-spec.ts — `buildRoleLaunchSpec`: the one place that turns
 * (role, harness, feature) into everything a launcher needs to start a
 * role-scoped agent session — the prompt, a signed role-scoped MCP URL,
 * and the cwd. The keystone of agent-launch-unification (D-003).
 *
 * It is a thin COMPOSITION of the functions the rest of the system
 * already shares, so a psu interactive role session is assembled from
 * the same primitives as the orchestrator + the operator brains — no
 * parallel reimplementation, no drift:
 *
 *   - prompt → `assembleRolePrompt` (`@papercusp/orchestrator/role-prompt`),
 *     the same shared assembler the operator's brain dispatchers
 *     (`agent-chats`) already use. `resolvePromptFile` +
 *     `buildPrompt` underneath — the same leaves `invoke()` uses.
 *   - MCP URL → the operator's `signSpawnParams` (HMAC key shared with
 *     the MCP handler's `verifySpawnParams`), over the SAME param set
 *     (`harness/workspace/role/run/spawn/[feature]`) the orchestrator's
 *     `writeSignedSpawnMcp` signs. Because the URL carries `role=<role>`
 *     (NOT `?superuser=1`), the dispatch layer enforces that role's
 *     tool-allowlist — true role-scoping, identical to an orchestrator
 *     agent (D-001).
 *   - cwd → `resolveProjectDir` (the harness's registered project dir).
 *
 * `invoke()` (autonomous spawns) keeps its own richer inline assembly
 * (substrate + feature-history + notes + identity, appropriate for a
 * headless run); the shared LEAVES (`buildPrompt`, `resolvePromptFile`, the
 * signing key, the role `.md` files) are what both paths hold in common.
 *
 * ASSESSED (unify-launch-mechanics follow-on, prompt-assembly fold): the fold is
 * intentionally NOT a goal, not a deferred TODO. The convergence that matters is
 * already done — BOTH paths build their prompt through the SAME `resolvePromptFile`
 * + `buildPrompt` leaves over the SAME role `.md` personas; there is no duplicate
 * prompt builder. What differs is mode-specific CONTEXT fed into that one builder,
 * and it SHOULD differ: the autonomous path injects substrate + feature-history +
 * the G3 `<untrusted-peer-content>` security wrapping (a headless agent has no
 * human to ask, and the G3 boundary is load-bearing), while the chat path injects
 * planContext + brief (a human drives + asks). Folding them would regress —
 * either bloating the interactive prompt with substrate it doesn't need or
 * stripping the autonomous prompt of state it requires (and blurring G3). Keep
 * the two callers; the shared leaf is the right unification layer.
 *
 * Server-only.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { assembleRolePrompt, resolvePromptFiles } from '@papercusp/orchestrator/role-prompt';
import { harnessRoot } from '@papercusp/harness/paths';
import { promptsDir } from './prompt-assembly';
import {
  sessionClaudeConfigDir,
  sessionMcpDir,
} from '@papercusp/orchestrator/session-launch-dirs';
import { signSpawnParams } from './spawn-signing';
import { resolveProjectDir } from './spawn-config';
import { getPromptOverride } from './harness-prompt-overrides';
import { renderSuPlaybook } from './desktop-install/papercusp-files';
import { composeLaunchContext } from './su-launch-context';
import { readSuperuserToken } from './superuser-token';
import { papercuspPathForWorkspace } from './papercusp-root';

export interface BuildRoleLaunchSpecInput {
  /** Pipeline/kernel role id (worker, validator, reviewer, …). */
  role: string;
  /** Active workspace id. */
  workspaceId: string;
  /**
   * Harness the role runs against. null/omitted = a WORKSPACE-LEVEL role
   * session (operator/planner — owner-confirmed, hive-agent-tabs P-003):
   * cwd = the workspace root, the MCP URL carries no harness param (ctx
   * lands as the `'*'` unscoped sentinel; harness-scoped tools answer
   * `harness_required` until a per-call harness is named — the SU model).
   */
  harnessSlug?: string | null;
  /** Operator base URL the signed MCP URL points at (e.g. http://localhost:3070). */
  operatorBaseUrl: string;
  /** Optional feature scope (required for feature-consuming roles — caller gates via roleConsumes). */
  featureId?: string | null;
  /** Optional plan context already fetched by the caller (operator has PG access). */
  planContext?: string;
  /** Queen-authored brief: the situational overlay the bee is MISSING. P-060: passed at placement time. */
  brief?: string;
  /** Extra runtime-context bullets, e.g. ['MODE=replan']. */
  extras?: readonly string[];
  /** Signed-URL TTL; defaults to the signer's 24h. */
  ttlSec?: number;
}

export interface RoleLaunchSpec {
  role: string;
  runId: string;
  spawnId: string;
  /** null = a workspace-level (harness-less) role session. */
  harnessSlug: string | null;
  featureId: string | null;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  /** Full role prompt (persona + tools + runtime context), chat-mode. */
  promptText: string;
  /** Which prompt file resolved (diagnostics). */
  promptFile: string;
  /** Signed, role-scoped MCP URL (role-allowlist enforced at dispatch). */
  mcpUrl: string;
  /** `.mcp.json` contents the launcher writes to `cwd` for the agent to discover. */
  mcpJsonContents: string;
  // ── Launch invariants (unify-launch-mechanics-2026-06-09 P-002) ──────────
  // The HOW: the launch-mechanics properties EVERY agent type needs, produced
  // by the ONE primitive so the wake/coord system reads a consistent setup
  // regardless of which trigger fired the launch. The caller materializes them
  // per-agent (claude/codex/omp differ) but the VALUES live here.
  /**
   * Per-session coord/lock owner id (`PAPERCUSP_SID` / `adv_sessions.coord_owner_id`).
   * Keys coord:inbox-wake, presence, the lock owner — and the per-session
   * config dirs below, so launch and the wake-executor resume leg agree.
   */
  sid: string;
  /**
   * Forced native session UUID for EXACT resumability (`claude --session-id`).
   * Recorded as `adv_sessions.session_id` so wake-executor resumes THIS
   * conversation (never `--continue`'s most-recent-in-cwd, which on the shared
   * tree resumes a random peer). claude-specific; codex recovers its uuid from
   * the rollout, omp resumes by thread id.
   */
  nativeSessionId: string;
  /**
   * Per-session `CLAUDE_CONFIG_DIR` (keyed by `sid`) — transcript + plugin
   * isolation (the EI-153 fix, D-002). The caller provisions it
   * (`writeSpawnClaudeConfig`) for a claude launch and points the resume leg at
   * the same path.
   */
  claudeConfigDir: string;
  /**
   * Per-session signed-MCP config dir (keyed by `sid`). The launch writes
   * `<dir>/.mcp.json`; the resume leg remounts it (`--mcp-config … --strict-mcp-config`)
   * so a woken session keeps its role-scoped tool surface.
   */
  sessionMcpDir: string;
}

/**
 * Build the launch spec for a role-scoped session. Throws if the harness
 * isn't registered (via `assembleRolePrompt`) — the caller surfaces it.
 */
export async function buildRoleLaunchSpec(
  input: BuildRoleLaunchSpecInput,
): Promise<RoleLaunchSpec> {
  const spawnId = randomUUID();
  const featureId = input.featureId?.trim() || null;
  const harnessSlug = input.harnessSlug?.trim() || null;

  // Placement deciders get the LIVE model-tier menu in their runtime context
  // (queen-model-tier-selection-2026-06-11): the user's actual tier names,
  // specs, and per-tier `when` guidance from /settings/agent — so the queen's
  // rubric tracks the configured menu instead of a static default that goes
  // stale the moment the user renames a tier. Best-effort (falls back to the
  // committed default menu inside the helper).
  let extras = input.extras;
  if (input.role === 'queen' || input.role === 'operator') {
    const { tierMenuRuntimeLines } = await import('./fleet/model-tiers');
    extras = [...(input.extras ?? []), ...(await tierMenuRuntimeLines())];
  }

  // Launch-mechanics identity (P-002): the per-session coord/lock owner +
  // forced native session id. Minted HERE (the one primitive) — not by each
  // caller — so the identity, the config-dir key, and the resume key are all
  // derived from the same `sid`. `role-` prefix mirrors the prior bootstrap-role
  // value so coord/lock owners read identically.
  const sid = `role-${randomUUID()}`;
  const nativeSessionId = randomUUID();

  let cwd: string;
  let promptText: string;
  let promptFile: string;
  let runId: string;

  if (harnessSlug) {
    // 0. Resolve the project dir IN-PROCESS, workspace-aware. The operator is
    //    the workspace authority (PG/registry-backed `resolveProjectDir`), so
    //    we resolve here and hand it to `assembleRolePrompt` — otherwise the
    //    assembler falls back to its workspace-BLIND `lookupProjectDir`, which
    //    (a) can't see an active non-`default` workspace's harnesses and
    //    (b) makes the :3070 host synchronously curl :3055 (itself) mid-request,
    //    which fails for harnesses absent from the legacy registry. Null here
    //    means the harness isn't registered in this workspace — surface it.
    const projectDir = await resolveProjectDir(harnessSlug, input.workspaceId);
    if (!projectDir) {
      throw new Error(
        `buildRoleLaunchSpec: harness "${harnessSlug}" is not registered in workspace "${input.workspaceId}"`,
      );
    }

    // 0b. Workspace-owned prompt override (D-7): resolve the per-(workspace,
    //     harness,role) override from PG and hand it to the assembler, which
    //     prefers it over the config.json fallback. Best-effort — a store miss
    //     leaves it undefined and the assembler uses the committed default.
    let promptOverrideText: string | undefined;
    try {
      promptOverrideText =
        (await getPromptOverride(input.workspaceId, harnessSlug, input.role)) ?? undefined;
    } catch { /* store unavailable → assembler falls back to config.json */ }

    // 1. Prompt (chat mode — a human drives this session). Same shared
    //    assembler the orchestrator's prompt path + operator brains use, but
    //    with the in-process projectDir so it skips the blind lookup.
    const assembled = assembleRolePrompt({
      slug: harnessSlug,
      role: input.role,
      projectDir,
      mode: 'chat',
      featureId: featureId ?? undefined,
      extras,
      planContext: input.planContext,
      brief: input.brief,
      promptOverrideText,
    });
    runId = assembled.meta.runId;
    promptText = assembled.text;
    promptFile = assembled.meta.promptFile;

    // 2. cwd — the harness's project dir (resolved above).
    cwd = assembled.meta.projectDir || projectDir || process.cwd();
  } else {
    // WORKSPACE-LEVEL role session (owner-confirmed, hive-agent-tabs P-003):
    // operator/planner launch WITHOUT a harness. cwd = the workspace root
    // (mirrors buildSuLaunchSpec); the prompt is the workspace-level persona.
    runId = `${Math.floor(Date.now() / 1000)}-${input.role}`;
    cwd = papercuspPathForWorkspace(input.workspaceId);
    const ws = assembleWorkspaceRolePrompt({
      role: input.role,
      workspaceId: input.workspaceId,
      extras,
      planContext: input.planContext,
      brief: input.brief,
    });
    promptText = ws.text;
    promptFile = ws.promptFile;
  }

  // 3. Signed role-scoped MCP URL — same param set + signing key the
  //    orchestrator's writeSignedSpawnMcp uses, so the MCP handler's
  //    verifySpawnParams accepts it and dispatch enforces role's allowlist.
  //    A workspace-level session signs WITHOUT the harness param — ctx lands
  //    as the '*' unscoped sentinel (parseRequestContext defaults it).
  const params = new URLSearchParams();
  if (harnessSlug) params.set('harness', harnessSlug);
  params.set('workspace', input.workspaceId);
  params.set('role', input.role);
  params.set('run', runId);
  params.set('spawn', spawnId);
  // EI-4 fix: bind the session's coord identity to the MCP URL as the stable
  // `client=` param, so the URL owner === PAPERCUSP_SID === the lock-hook owner
  // === the codex-home baked client. Without it a role session's MCP-call owner
  // (signed-spawn-derived) and its lock-hook owner (role-<uuid>) diverged — the
  // self-deadlock class the SU path already eliminated (P-022).
  params.set('client', sid);
  if (featureId) params.set('feature', featureId);
  await signSpawnParams(params, input.ttlSec ? { ttlSec: input.ttlSec } : {});
  const base = input.operatorBaseUrl.replace(/\/$/, '');
  const mcpUrl = `${base}/api/mcp?${params.toString()}`;
  const mcpJsonContents = JSON.stringify(
    { mcpServers: { papercusp: { type: 'http', url: mcpUrl } } },
    null,
    2,
  );

  return {
    role: input.role,
    runId,
    spawnId,
    harnessSlug,
    featureId,
    cwd,
    promptText,
    promptFile,
    mcpUrl,
    mcpJsonContents,
    sid,
    nativeSessionId,
    claudeConfigDir: sessionClaudeConfigDir(sid),
    sessionMcpDir: sessionMcpDir(sid),
  };
}

/**
 * Assemble the prompt for a WORKSPACE-LEVEL (harness-less) role session
 * (hive-agent-tabs P-003 — owner-confirmed: operator/planner launch without a
 * harness). Source preference:
 *
 *   1. The CHAT-SURFACE persona (`apps/operator/prompts/<role>.persona.md`,
 *      + `<role>.tools.md` when present) — the operator/oracle personas the
 *      desktop chat already uses. The per-tool catalog section is skipped on
 *      purpose: an interactive psu/Claude session lists the MCP catalog
 *      natively, and dispatch enforces the role allowlist server-side.
 *   2. The SPAWN persona (`<harness-install>/prompts/<role>.md`, default tier
 *      only — no project config exists to resolve a phase/dept variant) — the
 *      planner and pipeline roles.
 *
 * Neither resolves → throw (the caller 400s: this role needs a harness).
 */
export function assembleWorkspaceRolePrompt(opts: {
  role: string;
  workspaceId: string;
  extras?: readonly string[];
  planContext?: string;
  brief?: string;
}): { text: string; promptFile: string } {
  let persona: string | null = null;
  let promptFile = '';

  const chatPersonaPath = path.join(promptsDir(), `${opts.role}.persona.md`);
  if (fsSync.existsSync(chatPersonaPath)) {
    persona = fsSync.readFileSync(chatPersonaPath, 'utf8');
    promptFile = chatPersonaPath;
    const toolsMdPath = path.join(promptsDir(), `${opts.role}.tools.md`);
    if (fsSync.existsSync(toolsMdPath)) {
      persona += `\n\n---\n\n${fsSync.readFileSync(toolsMdPath, 'utf8')}`;
    }
  } else {
    // Layered spawn persona (audit P-019): base/<role>.md first when present,
    // the concrete prompt last — joined like prompt-build does.
    const spawnPersonaFiles = resolvePromptFiles(
      { harnessDir: harnessRoot(), phase: '', dept: '' },
      opts.role,
    );
    if (spawnPersonaFiles.length > 0) {
      persona = spawnPersonaFiles
        .map((f) => fsSync.readFileSync(f, 'utf8'))
        .join('\n\n---\n\n');
      promptFile = spawnPersonaFiles[spawnPersonaFiles.length - 1];
    }
  }
  if (persona == null) {
    throw new Error(
      `buildRoleLaunchSpec: role "${opts.role}" has no workspace-level persona ` +
        `(no ${opts.role}.persona.md chat persona and no prompts/${opts.role}.md) — pass a harness`,
    );
  }

  const lines = [
    'MODE=chat (an interactive psu session — a human drives this terminal)',
    `ROLE=${opts.role}`,
    `WORKSPACE=${opts.workspaceId} — workspace-level session, NO harness scope: ` +
      'harness-scoped tools answer harness_required until you name one per call ' +
      "(pass `harness: '<slug>'`, or `harness: 'all'` for the operator-level surface).",
    ...(opts.extras ?? []),
  ];
  let text = `${persona.replace(/\n+$/, '')}\n\n---\n## Runtime context\n${lines
    .map((l) => `- ${l}`)
    .join('\n')}\n`;
  if (opts.planContext?.trim()) {
    text += `\n---\n## Plan context\n\n${opts.planContext.trim()}\n`;
  }
  if (opts.brief?.trim()) {
    text += `\n---\n## Brief\n\n${opts.brief.trim()}\n`;
  }
  return { text, promptFile };
}

/**
 * `su` launch input — the engineer/collaborator superuser session. NOT a
 * pipeline role: the prompt is the SU playbook (not a role persona) and
 * the MCP URL is the loopback `?superuser=1` door (not a signed,
 * role-scoped URL). See D-001: `su` is `buildLaunchSpec` at the superuser
 * tier — same builder, prompt = playbook, scope = superuser.
 */
export interface BuildSuLaunchSpecInput {
  kind: 'su';
  /** Client whose tooling overlay is spliced into the playbook (omp/claude/codex). */
  agent: string;
  /** Active workspace id (baked into the superuser MCP URL as a default scope). */
  workspaceId: string;
  /** Operator base URL the superuser MCP door points at. */
  operatorBaseUrl: string;
  /** Harness scope, or null/omitted for a workspace-level su session. */
  harnessSlug?: string | null;
  /** Playbook profile: 'engineer' (default) | 'power'. */
  profile?: string;
  /** Plan binding for the launch-context addendum (optional). */
  planSlug?: string | null;
  planTitle?: string | null;
  planNow?: { state: string; next: string } | null;
  /** Test override forwarded to `renderSuPlaybook`. */
  operatorAppRoot?: string;
}

export type BuildLaunchSpecInput =
  | (BuildRoleLaunchSpecInput & { kind: 'role' })
  | BuildSuLaunchSpecInput;

/**
 * The unified launch spec — a superset of `RoleLaunchSpec` that also
 * carries the `kind` discriminator. `harnessSlug` is nullable here
 * because an `su` session may be workspace-level (no harness).
 */
export interface LaunchSpec {
  kind: 'su' | 'role';
  /** Pipeline role for kind:'role'; the literal 'su' for kind:'su'. */
  role: string;
  runId: string;
  spawnId: string;
  harnessSlug: string | null;
  featureId: string | null;
  cwd: string;
  promptText: string;
  /** Resolved prompt source path (role `.md`, or the su base playbook). */
  promptFile: string;
  mcpUrl: string;
  mcpJsonContents: string;
}

/**
 * THE single entry point that turns a launch request into everything a
 * launcher needs (prompt, MCP config, cwd). Dispatches on `kind`:
 *
 *   - `'role'` → `buildRoleLaunchSpec` verbatim: shared role-prompt
 *     assembler + signed role-scoped MCP URL (role-allowlist enforced).
 *   - `'su'`   → the engineer playbook (`renderSuPlaybook`, the SAME
 *     prompts files the installer writes) + a per-launch scope/plan
 *     addendum + the loopback `?superuser=1` MCP door with the bearer.
 *
 * Two params (prompt source + MCP scope) separate the two — not two
 * mechanisms. This is the D-001 collapse: `psu` is the only launcher,
 * `su` is just its superuser tier.
 */
export async function buildLaunchSpec(input: BuildLaunchSpecInput): Promise<LaunchSpec> {
  if (input.kind === 'role') {
    const spec = await buildRoleLaunchSpec(input);
    return { kind: 'role', ...spec };
  }
  return buildSuLaunchSpec(input);
}

async function buildSuLaunchSpec(input: BuildSuLaunchSpecInput): Promise<LaunchSpec> {
  const spawnId = randomUUID();
  const runId = randomUUID();
  const harnessSlug = input.harnessSlug?.trim() || null;

  // 1. cwd — the harness project dir if scoped, else the workspace root.
  //    Matches console-launcher's superuser shell: a *given* slug must
  //    resolve (a typo shouldn't silently fall back to workspace level).
  let cwd: string;
  if (harnessSlug) {
    const projectDir = await resolveProjectDir(harnessSlug, input.workspaceId);
    if (!projectDir) {
      throw new Error(
        `buildLaunchSpec(su): harness "${harnessSlug}" is not registered in workspace "${input.workspaceId}"`,
      );
    }
    cwd = projectDir;
  } else {
    // Workspace-only launch: the SELECTED workspace's root, not the global
    // active one (same fix as console-launcher — input.workspaceId may differ
    // from activeWorkspaceId()).
    cwd = papercuspPathForWorkspace(input.workspaceId);
  }

  // 2. Prompt — the engineer/power playbook (base + per-agent tooling
  //    overlay), rendered fresh from the SAME prompts files the installer
  //    splices (renderSuPlaybook → spliceToolingOverlay), plus the
  //    per-launch scope/plan addendum the wrappers used to compose.
  //
  //    Project-guide splice (psu-isolation P-001 / D-002): the ENGINEER profile
  //    auto-resolves papercup's own CLAUDE.md (renderSuPlaybook default). The
  //    POWER profile manages an EXTERNAL repo, so its guide is the launch cwd's
  //    CLAUDE.md/AGENTS.md — resolved here and passed explicitly; '' (no guide)
  //    when the managed repo carries neither, so we never splice papercup's
  //    guide into a session steering a different repo.
  let projectGuideSource: string | undefined;
  if ((input.profile ?? 'engineer') === 'power') {
    projectGuideSource = '';
    for (const cand of [path.join(cwd, 'CLAUDE.md'), path.join(cwd, 'AGENTS.md')]) {
      try {
        await fs.access(cand);
        projectGuideSource = cand;
        break;
      } catch {
        /* next candidate */
      }
    }
  }
  const rendered = await renderSuPlaybook({
    agent: input.agent,
    profile: input.profile,
    operatorAppRoot: input.operatorAppRoot,
    projectGuideSource,
  });
  const launchCtx = composeLaunchContext({
    harnessSlug,
    planSlug: input.planSlug ?? null,
    planTitle: input.planTitle ?? null,
    planNow: input.planNow ?? null,
  });
  const promptText = launchCtx
    ? rendered.text.replace(/\n+$/, '') + '\n\n' + launchCtx
    : rendered.text;

  // 3. Superuser MCP — the existing loopback door (NOT a signed,
  //    role-scoped URL): `?superuser=1&workspace=<ws>` + the bearer from
  //    ~/.papercusp/superuser-token. Same `.mcp.json` shape
  //    console-launcher writes for the "+" superuser console.
  const token = readSuperuserToken();
  const mcpUrl = new URL(`${input.operatorBaseUrl.replace(/\/$/, '')}/api/mcp`);
  mcpUrl.searchParams.set('superuser', '1');
  mcpUrl.searchParams.set('workspace', input.workspaceId);
  const mcpUrlStr = mcpUrl.toString();
  const mcpJsonContents = JSON.stringify(
    {
      mcpServers: {
        papercusp: {
          url: mcpUrlStr,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      },
    },
    null,
    2,
  );

  return {
    kind: 'su',
    role: 'su',
    runId,
    spawnId,
    harnessSlug,
    featureId: null,
    cwd,
    promptText,
    promptFile: rendered.baseSource,
    mcpUrl: mcpUrlStr,
    mcpJsonContents,
  };
}

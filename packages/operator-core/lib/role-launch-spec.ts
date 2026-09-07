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

// su-context-size-variants: the always-loaded core spine the codex 'trimmed' variant
// advertises via ?tools= (the only trim lever codex has — it has no native discovery).
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';
// WI-2140338: the live projected-tool registry — the steward seed derives its
// exact names from it at spec-build time instead of hand-maintaining a list.
import { listMcpProjections } from '@papercusp/agent-mcp';
import { normalizeSuContextSize } from './su-context-size.mjs';

/**
 * gui-chat-session-controls-2026-07-25 P-010: chat:ask_choice UNCONDITIONALLY
 * seeded onto every su/psu session's tool surface, on top of the shared
 * CORE_MCP_TOOL_NAMES spine — NOT added to the spine itself, because that
 * array is shared by every headless pipeline-role launch too (fleet workers,
 * validators, …) where a blocking human-facing card tool has no demand-
 * evidence case (CORE_MCP_TOOL_NAMES's own convention: every entry there
 * carries call-count justification).
 *
 * Every su/psu session is reachable from a live GUI chat (SessionChatModal —
 * apps/operator/app/_components/chat/SessionChatModal.tsx), where P-008
 * already wires an agent-presented option set to render as a real clickable
 * card (via the chat:ask_choice → durable coord-escalation → OtherDetail
 * path, apps/operator-docs/.../agent-insights/inbox-cards.mdx). Before this,
 * chat:ask_choice was reachable only via a `tools:find` discovery round trip
 * (dynamic-tool-surface-2026-07-01) — every OTHER surface that already relies
 * on it (operator-converse's ALL_AGENT_MCP_TOOLS, oracle's
 * ORACLE_ALLOWED_TOOLS) gets it unconditionally in a static `--allowed-tools`
 * list, with no discovery step required. Without this seed, P-011's persona
 * instruction ("reach for chat:ask_choice when putting an option set to the
 * owner") is inert for any su session that hasn't already discovered the tool
 * — the exact "never advertise the CREATE and hide the UNDO"-style
 * discoverability trap CORE_MCP_TOOL_NAMES's own EI-10946 note warns about.
 */
export const SU_EXTRA_MCP_TOOL_NAMES: readonly string[] = [
  'chat:ask_choice',
  // Model selection can fork a Codex session onto a fresh MCP connection. Keep
  // the normal file-lock release verb on the SU-only seed so an idempotent
  // cleanup does not depend on a prior connection's dynamically activated
  // wrapper. This stays out of CORE_MCP_TOOL_NAMES: automatic file-lock hooks
  // make it unnecessary for the shared headless role spine.
  'locks:release',
  // consult-revival-and-honest-min-2026-08-18 P-005 [owner 2026-08-18 21:23Z
  // interactive: "how do we get agents to use our get_feedback tool ad-hoc? adding
  // it to the trimmed tool list or is there another way?"]: the consult verbs are
  // seeded for su/psu sessions so an ad-hoc "who knows more than me about THIS?"
  // costs zero discovery round-trips. Friction evidence: a consult:reply from a
  // trimmed su session cost a failed tools:invoke schema-discovery round-trip
  // (2026-08-18). SU-extra, not CORE: the shared spine is also every headless
  // pipeline-role launch, where there is no call-count demand evidence yet
  // (CORE's own convention) — su sessions are the population the owner's
  // adoption push targets, and P-006's success metric (ad-hoc calls outnumber
  // vetting-mandate calls in 1 week) measures exactly them. All FOUR verbs ride
  // together per the spine's own EI-10946 rule (never advertise the ASK and
  // hide the ANSWER/DECLINE/CLOSE): a routed consult wakes a PEER su session,
  // which must be able to reply/decline from its seed, and the requester must
  // be able to close.
  'consult:get_feedback',
  'consult:reply',
  'consult:decline',
  'consult:close',
];

/**
 * WI-2140338 [owner 2026-09-01]: the `steward` intermediate seed — verb FAMILIES
 * a long-lived goal-holder/steward session predictably needs, expanded to exact
 * tool names against the LIVE registry at spec-build time (derived-truth ladder
 * rung 1: the registry owns the names; only this family judgment is curated).
 * Measured friction basis: graded goal-mode windows show the holder burning
 * turns on tools:find round-trips + colon-form discovery dead-ends for exactly
 * these families. NOT 'full' — the whole-catalog launch was retired 2026-08-27
 * (WI-4608 prompt-too-long deaths; codex code-mode IPC frame overflow, and the
 * holder IS codex). ~10-40 verbs per family; the seed stays growable, so an
 * omitted family costs a discovery round-trip, never reachability.
 */
export const STEWARD_MCP_TOOL_FAMILIES: readonly string[] = [
  'goals', // own goal state, tripwires, kill criteria
  'plans', // full plan lifecycle: audit, decisions, rubric ship gates
  'pot', // pot linkage — a standing goal spans pots
  'fleet', // fleet launch / leadership / assignments — the holder's fan-out duty
  'coord', // full coordination beyond the CORE subset (escalate, handoff, wake…)
  'work_items', // full ledger beyond the CORE subset (checkpoint, comment, release…)
  'scheduler', // get_next — the pull loop
  'events', // await / emit / catalog — gates and parks
  'blender', // route-idea / grade-idea / ideation-feedback — steward grading rails
  'scorecards', // card emits + freshness reads
  'rubrics', // list / search / propose
  'facts', // standing conclusions (assert / list / retract)
  'state', // live cells (read / subscribe)
  'loop', // arm / end / status / checkpoint — the holder's wake source
  'mode', // auto/ideate/drain registration
  'locks', // acquire / release / queue
  'memory', // remember / search
  'sessions', // self-recall across carry-respawns (search / read)
  'improvements', // capture — the standing filing reflex
  'watch', // create — the unified subscription primitive
];

/**
 * Expand the steward families against the live projected-tool registry.
 * `listings` is injectable for tests; production passes nothing and reads
 * `listMcpProjections()` (populated by the operator's startup side-effect
 * import of agent-tools/index.ts — the same registry the MCP handler serves).
 * Union with CORE + SU_EXTRA, deduped, CORE-first so the spine's ordering
 * (and any downstream prefix heuristics) are preserved.
 */
export function stewardSeedToolNames(listings?: readonly { name: string }[]): string[] {
  const all = listings ?? listMcpProjections();
  const familyNames = all
    .map((t) => t.name)
    .filter((n) => {
      const i = n.indexOf(':');
      return i > 0 && STEWARD_MCP_TOOL_FAMILIES.includes(n.slice(0, i));
    });
  return [...new Set([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES, ...familyNames])];
}
import { assembleRolePrompt, resolvePromptFiles } from '@papercusp/orchestrator/role-prompt';
import { harnessRoot } from '@papercusp/harness/paths';
import { resolveAgentMcpBaseUrl } from './mcp-base-url';
import { promptsDir } from './prompt-assembly';
import { PSU_CACHE_BOUNDARY } from './inference-gateway/cache-policy';
import { sessionClaudeConfigDir, sessionMcpDir } from '@papercusp/orchestrator/session-launch-dirs';
import { signSpawnParams } from './spawn-signing';
import { resolveProjectDir } from './spawn-config';
import { getPromptOverride } from './harness-prompt-overrides';
import { renderSuPlaybook } from './desktop-install/papercusp-files';
import { composeLaunchContext } from './su-launch-context';
import { lintInstructionText, type InstructionLintReport } from './instruction-lint';
import { readSuperuserToken } from './superuser-token';
import { papercuspPathForWorkspace } from './papercusp-root';
import { tagTurnForInjection } from './turn-provenance/turn-provenance';

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
  /**
   * The ONE bounded spawn/wake-hydration block (directed-wake-honesty P-021/P-012):
   * predecessor handoff + hive-roster snapshot + work-item carry-note, assembled by
   * assembleSpawnHydration and carrying its own `## Handoff` heading. Harness-scoped
   * (the caller hydrates it before building the spec). Rendered verbatim in the
   * volatile tail. Only meaningful for a harness-scoped launch.
   */
  handoff?: string;
  /** Extra runtime-context bullets, e.g. ['MODE=replan']. */
  extras?: readonly string[];
  /** Signed-URL TTL; defaults to the signer's 24h. */
  ttlSec?: number;
  /**
   * Initial MCP tool-surface size. There is only ONE effective value —
   * 'trimmed' — for EVERY role (trimmed-only-agent-context-launch-2026-08-27
   * P-001/P-002). It seeds the signed MCP URL with `?tools=<CORE_MCP_TOOL_NAMES>`
   * so the launched agent's FIRST tools/list carries the core spine instead of
   * the whole catalog. The seed GROWS at runtime via ctx.activateTools
   * (tools:find) and tools:invoke reaches anything unseeded, so trimmed means
   * LAZY, never restricted.
   *
   * 'full' is a DEPRECATED COMPATIBILITY ALIAS, not a mode: `normalizeSuContextSize`
   * maps it to 'trimmed' before anything is persisted or spawned, so a legacy CLI
   * argument or stored launch row cannot open a doomed terminal. It used to
   * eagerly advertise the entire catalog, which is what produced the repeated
   * "Prompt is too long" deaths (WI-4608) and, for Codex, an invalid transport
   * frame once the code-mode IPC payload exceeded its limit.
   *
   * Omitted → 'trimmed'. Do NOT reintroduce a role-based auto-select or offer
   * 'full' in new UI/API schemas; accept the legacy spelling only at durable and
   * CLI boundaries. Canonical policy + normalizer: `su-context-size.mjs`.
   *
   * 'steward' (WI-2140338) is accepted at this TYPE boundary (HTTP callers pass
   * loose strings) but REFUSED at runtime for pipeline roles — it is an
   * su/goal-holder seed with no pipeline-role demand evidence.
   */
  contextSize?: 'full' | 'trimmed' | 'steward' | null;
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
  /** The RESOLVED context size. Always 'trimmed': it comes from
   *  `normalizeSuContextSize`, which maps the legacy 'full' alias down before it
   *  can reach a spawn. Typed as the single value rather than the input union so
   *  the EFFECTIVE mode cannot silently widen back to 'full' — the type is the
   *  guard that a legacy alias never becomes a launch mode. Diagnostic + lets a
   *  caller surface it (mirrors `LaunchSpec.personaTier` on the su path). */
  contextSize: 'trimmed';
}

/**
 * Build the launch spec for a role-scoped session. Throws if the harness
 * isn't registered (via `assembleRolePrompt`) — the caller surfaces it.
 */
export async function buildRoleLaunchSpec(input: BuildRoleLaunchSpecInput): Promise<RoleLaunchSpec> {
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
  if (input.role === 'mug' || input.role === 'operator') {
    const { tierMenuRuntimeLines } = await import('./fleet/model-tiers');
    extras = [...(input.extras ?? []), ...(await tierMenuRuntimeLines())];
  }

  // All roles use the growable trimmed seed. Historical callers may still pass
  // `full`; normalize it before signing the MCP URL so no role can eagerly load
  // the catalog or hit a client transport ceiling. `steward` (WI-2140338) is an
  // SU/goal-holder seed with no pipeline-role demand evidence — refuse it loudly
  // here rather than silently downgrading a config that asked for it.
  const normalizedContextSize = normalizeSuContextSize(input.contextSize);
  if (!normalizedContextSize.ok) throw new Error(normalizedContextSize.error);
  if (normalizedContextSize.contextSize !== 'trimmed') {
    throw new Error(
      `buildRoleLaunchSpec: context size '${normalizedContextSize.contextSize}' is not a pipeline-role mode (roles launch trimmed; 'steward' is an su/goal-holder seed)`,
    );
  }
  const contextSize = normalizedContextSize.contextSize;

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
      promptOverrideText = (await getPromptOverride(input.workspaceId, harnessSlug, input.role)) ?? undefined;
    } catch {
      /* store unavailable → assembler falls back to config.json */
    }

    // Hive-INSTANCE prompt override (domain-generic-agent-personas-2026-06-17 P-003 /
    // D-003): a Hive instance specializes its roles' personas via hive_settings
    // (federated, keyed by the home-Hive slug). Resolve the harness's home Hive and
    // APPEND its override after the workspace/config override — it SPECIALIZES the
    // persona (rides buildPrompt's "specialization" section), never replaces it. This
    // is the per-instance layer on top of the blueprint→ancestors→base file chain
    // (the reusable blueprint persona stays a file + generic). Best-effort.
    try {
      const { potHomeSlugForHarness } = await import('./hive-federation');
      const potSlug = await potHomeSlugForHarness(input.workspaceId, harnessSlug);
      if (potSlug) {
        const { getHiveInstancePromptOverride } = await import('./hive-settings-store');
        const inst = await getHiveInstancePromptOverride(input.workspaceId, potSlug, input.role);
        if (inst) promptOverrideText = promptOverrideText ? `${promptOverrideText}\n\n${inst}` : inst;
      }
    } catch {
      /* best-effort: a resolve/store miss leaves the override untouched */
    }

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
      handoff: input.handoff,
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

  // P-002 enrollment: the role prompt is delivered by the launcher through a
  // system-prompt file, but native CLI transcript adapters can persist that
  // content as a user-shaped row.  Enroll the exact bytes with the sid minted
  // above before the caller materializes the file.  The ledger write is
  // fail-soft by contract; the envelope still prevents a clean prompt from
  // falling through to the owner-interactive residual at ingest.
  promptText = tagTurnForInjection({ sid, origin: 'role-prompt', text: promptText }).taggedText;

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
  // WI-4608: the SAME dynamic-tool-surface seed lever buildSuLaunchSpec applies —
  // `tools` is NOT in the signed-param allowlist (spawn-signing-core.ts), so it is
  // safe to set before or after signing; set it here so it rides the same params
  // object the rest of the URL is built from. `getSessionSurface` grows the seed
  // at runtime (tools:find / ctx.activateTools), so this never hard-caps the role.
  params.set('tools', CORE_MCP_TOOL_NAMES.join(','));
  await signSpawnParams(params, input.ttlSec ? { ttlSec: input.ttlSec } : {});
  // WI-573: route the spawned agent's MCP through the resilient proxy when the env opts in
  // (PAPERCUSP_MCP_PROXY_BASE), else the operator base unchanged. Survives a :3070 deploy restart.
  const base = resolveAgentMcpBaseUrl(input.operatorBaseUrl);
  const mcpUrl = `${base}/api/mcp?${params.toString()}`;
  const mcpJsonContents = JSON.stringify({ mcpServers: { papercusp: { type: 'http', url: mcpUrl } } }, null, 2);

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
    contextSize,
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
    const spawnPersonaFiles = resolvePromptFiles({ harnessDir: harnessRoot(), phase: '', dept: '' }, opts.role);
    if (spawnPersonaFiles.length > 0) {
      persona = spawnPersonaFiles.map((f) => fsSync.readFileSync(f, 'utf8')).join('\n\n---\n\n');
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
  let text = `${persona.replace(/\n+$/, '')}\n\n---\n## Runtime context\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
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
  /** Playbook profile: 'engineer' (default) | 'power' | 'generic'. */
  profile?: string;
  /** Initial-context size. 'trimmed' is the only effective value, on every model
   *  tier; there is no longer a tier-derived trim and no frontier-gets-'full'
   *  branch (trimmed-only-agent-context-launch-2026-08-27 P-001/P-002). 'full' is
   *  accepted here ONLY as a deprecated alias for old CLI args and stored rows,
   *  and `normalizeSuContextSize` maps it to 'trimmed' before launch. 'steward'
   *  (WI-2140338) is the explicit opt-in intermediate seed: core spine + the
   *  steward verb families, expanded against the live registry above. */
  contextSize?: 'full' | 'trimmed' | 'steward' | null;
  /** The model spec the session launches with (e.g. `ollama/ornith-35b:IQ3_M` or
   *  `anthropic/claude-opus-4-8`). Drives the model-capability tier that gates the
   *  lite tooling tier — the `?tools=` catalog trim below and, downstream, the
   *  lite-schema / named-JSON / grammar / examples levers. OMP runs weak AND strong
   *  models, so the tier comes from THIS, never the client (D-004). Omitted →
   *  frontier (full catalog): the safe, no-regression default. */
  model?: string | null;
  /**
   * Persona TIER (context-trimming-tiers P-017/P-018). 'full' = today's
   * playbook; 'fleet' = the fleet-member tier (FULL-ONLY sections stripped,
   * compact always-AUTO clause, spine wire schemas). Omitted → AUTO-SELECT
   * from the model window: a ≤200k-window model (e.g. sonnet) gets 'fleet'
   * so the persona + catalog + repo guide fit; a [1m] model gets 'full'.
   */
  personaTier?: 'full' | 'fleet' | null;
  /**
   * identities-v1 P-012: the fleet role this session launches INTO (`member` for a
   * `psu --fleet=<slug>` join, `leader` for a fresh `--fleet-name`), so the FIRST render
   * already carries the bound fleet-posture layer (`suSessionBinding`) — the "inclusion
   * in the next full render" half of an inject-now attach. Null / omitted ⇒ no posture
   * bound (a plain su launch); take-leadership mid-session attaches the leader posture
   * through the control-anchor channel instead.
   */
  fleetRole?: string | null;
  /**
   * identities-v1 P-021: the registry modes this session launches WITH (`--auto` ⇒ auto,
   * `--mode=drain` ⇒ auto + drain, a fleet member ⇒ auto — the same set bootstrap-su
   * registers in `agent_modes`), so the FIRST render already carries each mode's definition
   * identity on its axis slot (`suSessionBinding({ modes })`). Null / omitted ⇒ no mode
   * layer bound; a later `mode:set` attaches through the control-anchor channel instead.
   */
  modes?: readonly string[] | null;
  /** Plan binding for the launch-context addendum (optional). */
  planSlug?: string | null;
  planTitle?: string | null;
  planNow?: { state: string; next: string } | null;
  /**
   * EI-996 (owner ask 2026-06-17): a short ROLE ADDENDUM appended to the rendered
   * su playbook, so a role can run as a full SU agent (engineer playbook +
   * superuser MCP) with "just a few lines added about their role" rather than
   * getting a separate, role-scoped prompt + MCP tier.
   *
   * Appended LAST — after the playbook and after the hive-instance su override —
   * so the role's focus is the final word the agent reads. Omitted/blank ⇒ the
   * spec is byte-identical to a plain su launch.
   */
  roleAddendum?: string | null;
  /** Persona/role id used to select `roles[].stack` from the pot blueprint. */
  roleId?: string | null;
  /** Explicit `slot:id` binding. Null/omitted uses the selected role's default. */
  stack?: readonly string[] | null;
  /** Test override forwarded to `renderSuPlaybook`. */
  operatorAppRoot?: string;
}

export type BuildLaunchSpecInput = (BuildRoleLaunchSpecInput & { kind: 'role' }) | BuildSuLaunchSpecInput;

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
  /** Canonical launch-time identity binding that produced the prompt. */
  stack: string[];
  /** Resolved prompt source path (role `.md`, or the su base playbook). */
  promptFile: string;
  mcpUrl: string;
  mcpJsonContents: string;
  /** Resolved persona tier (su path; context-trimming-tiers P-017/P-020) — the
   *  launch route reads it to prune the fleet member's plugin surface. */
  personaTier?: 'full' | 'fleet';
  /** Launch-time lint over the final compiled instruction text. This is
   * diagnostic and bounded; it never silently rewrites policy. */
  instructionLint?: InstructionLintReport;
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
    return { kind: 'role', stack: [], ...spec };
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

  // identities-v1 P-008: one launch binding for every client. An explicit
  // `--stack` wins; otherwise the selected role inherits the pot blueprint's
  // `roles[].stack`. Parse through the live slot registry before any prompt or
  // launch artifact is written so malformed/conflicting bindings fail visibly.
  let stackRefs = input.stack == null ? null : [...input.stack];
  if (stackRefs == null && harnessSlug) {
    const blueprintPath = path.join(cwd, '.papercusp', 'blueprint.yaml');
    if (fsSync.existsSync(blueprintPath)) {
      const { loadBlueprintFromFile } = await import('@papercusp/orchestrator/blueprint');
      const loaded = loadBlueprintFromFile(blueprintPath);
      const roleId = input.roleId?.trim() || 'su';
      stackRefs = [...(loaded.blueprint.roles.find((role) => role.id === roleId)?.stack ?? [])];
    }
  }
  stackRefs ??= [];
  const { stackBindingFromRefs } = await import('@papercusp/orchestrator/blueprint');
  const requestedStack = stackBindingFromRefs(stackRefs);

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
  //    The GENERIC profile (domain-generic-hive-architecture P-025) is a
  //    NON-CODING work hive: it splices NO repo guide at all (projectGuideSource '')
  //    — its domain context comes from the per-hive su override appended below
  //    (D-010: papercup specifics live in the hive override, never the base). This
  //    is the ADDITIVE half of P-025; the engineer-profile default is unchanged
  //    (dropping engineer's papercup CLAUDE.md splice is gated to the dogfood pass).
  // Coerce to a valid playbook profile at the boundary: `input.profile` is a loose
  // `string` (it crosses the HTTP body boundary in bootstrap-su, validated there at
  // runtime), so narrow it to the actual union here — any unrecognized value falls
  // back to 'engineer'. This also gives `launchProfile` the union type that
  // composeLaunchContext/renderSuPlaybook require (a peer tightened those params from
  // `string` to the union; this is the matching narrow at the source, WI-4596 gate-green).
  const launchProfile: 'engineer' | 'power' | 'generic' =
    input.profile === 'power' || input.profile === 'generic' ? input.profile : 'engineer';
  let projectGuideSource: string | undefined;
  if (launchProfile === 'generic') {
    projectGuideSource = ''; // non-coding hive → no repo guide; domain rides the hive override
  } else if (launchProfile === 'power') {
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
  // domain-generic-agent-personas-2026-06-17 P-006 (SU_BLUEPRINT_PERSONA, DEFAULT-ON —
  // FLAG_DEFAULTS is derived as `!DARK_FLAGS.has(key)` and this flag is not dark; the
  // comment here read "default-off" long after that inverted, which is exactly how an
  // author concludes a blueprint-persona edit was a no-op and goes hunting elsewhere):
  // resolve the su persona via the blueprint prompt-resolve chain (blueprints/base/prompts/
  // su.md) instead of the hardcoded papercusp-su playbook; the per-agent overlay + generated
  // sections still splice (overlayDir = the operator prompts dir where papercusp-su.<agent>.md
  // lives). Flag OFF ⇒ renderSuPlaybook resolves the playbook as today (byte-identical).
  let suBaseSource: string | undefined;
  let suOverlayDir: string | undefined;
  let suBaseText: string | undefined;
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (await getFlag(FLAGS.SU_BLUEPRINT_PERSONA, input.workspaceId)) {
      const files = resolvePromptFiles({ harnessDir: harnessRoot(), phase: '', dept: '' }, 'su');
      if (files.length > 0) {
        suBaseSource = files[files.length - 1];
        suOverlayDir = promptsDir();
        // identities-v1 P-003 — the KERNEL SEAL: the su source is the SLOT STACK composed from
        // su.md's tiles + the kernel base text (`agent-base-preamble.md`) rendered with the
        // kernel LAST under an explicit precedence statement (`composeSuStackSource`). The
        // generated sections still splice by marker below (the seams live in the tiles). A
        // compose failure — a drifted tiling, a BLOCK-tier lint finding — falls back to su.md
        // as-is, loudly: the seal is the default, not a silent flag.
        try {
          // Loaded lazily, like the flags above: the blueprint barrel pulls the loader (and its
          // harness-path resolution) which this module otherwise never needs at import time.
          const { composeSuStackSource, normalizeStackBinding, suSessionBinding } = await import('@papercusp/orchestrator/blueprint');
          const harnessDir = path.resolve(suBaseSource, '..', '..', '..', '..'); // <root>/blueprints/base/prompts/su.md
          // P-012 / P-021: the launch-time stack binding — the fleet posture the session
          // launches into and the definition identity of each mode it launches with — is
          // part of the FIRST render (an inject-now layer also renders in place on every
          // full render). Derived from the same facts presence + agent_modes carry.
          const derived = suSessionBinding({ fleetRole: input.fleetRole ?? null, modes: input.modes ?? null });
          const launchBinding = normalizeStackBinding([...requestedStack.layers, ...derived.layers]);
          suBaseText = composeSuStackSource({
            harnessDir,
            binding: launchBinding,
          }).text;
        } catch (e) {
          console.warn(`[role-launch-spec] su slot-stack compose failed — rendering su.md unsealed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch {
    /* flag/resolve miss → fall through to today's playbook (byte-identical) */
  }
  // P-017/P-018 persona tier: explicit ask wins; else auto-select 'fleet' for a
  // KNOWN ≤200k-window model (the sonnet-fleet death mode: full persona +
  // catalog + guide left no headroom before the first turn). An OMITTED model
  // stays 'full' — interactive launches often name no model, and the safe
  // default is today's playbook, byte-identical.
  const { modelWindowForSpec } = await import('./agent-config-constants');
  const personaTier: 'full' | 'fleet' =
    input.personaTier ?? (input.model && modelWindowForSpec(input.model) <= 200_000 ? 'fleet' : 'full');
  // identities-v1 P-022: the Project guide is selected by the WEARER'S STACK, not by
  // harness alone. The wearer is the same binding the first render composes from —
  // the su static layers (domain / stance / practice) + the session binding (fleet
  // posture, mode axes) — expanded to addressing tokens; the composer reads the
  // `harness_doc_parts` rows addressed to any of them and splices them after the
  // default guide through `projectGuideAtBudget`. No addressed rows ⇒ the default guide,
  // byte-identical. A guide-less profile (generic; power with no repo guide) never
  // composes — renderSuPlaybook only calls the seam when a guide resolved. The rows are
  // read from the doc the default guide was projected from: the ENGINEER profile splices
  // papercusp's own CLAUDE.md, so its parts live under the projector's harness
  // (PAPERCUSP_HARNESS_SLUG, default 'papercusp'); the POWER profile's guide is the
  // managed repo's, so its parts live under that harness.
  const composeProjectGuide = await (async () => {
    if (launchProfile === 'generic') return undefined;
    const guideHarness =
      launchProfile === 'engineer' ? (process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp') : harnessSlug;
    if (!guideHarness) return undefined;
    try {
      const { SU_STATIC_LAYERS, suSessionBinding } = await import('@papercusp/orchestrator/blueprint');
      const { projectGuideComposerForWearer } = await import('./doc-projection/addressed-project-guide');
      const binding = suSessionBinding({ fleetRole: input.fleetRole ?? null, modes: input.modes ?? null });
      return projectGuideComposerForWearer({
        wearer: { role: 'su', layers: [...SU_STATIC_LAYERS, ...binding.layers] },
        workspaceId: input.workspaceId,
        harnessSlug: guideHarness,
        client: input.agent,
        onError: (err) => {
          console.warn(
            `[role-launch-spec] addressed project-guide read failed — splicing the default guide: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      });
    } catch (e) {
      console.warn(`[role-launch-spec] project-guide addressing unavailable — default guide: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  })();
  const rendered = await renderSuPlaybook({
    agent: input.agent,
    profile: input.profile,
    operatorAppRoot: input.operatorAppRoot,
    tier: personaTier,
    projectGuideSource,
    baseSource: suBaseSource,
    baseText: suBaseText,
    overlayDir: suOverlayDir,
    composeProjectGuide,
  });
  if (rendered.projectGuideAddressed) {
    const a = rendered.projectGuideAddressed;
    console.log(
      `[role-launch-spec] project guide addressed: ${a.partKeys.length} part(s) (+${a.addedChars} chars) for ` +
        `${a.tokens.join(', ')}: ${a.partKeys.join(', ')}`,
    );
  }
  // domain-generic-agent-personas-2026-06-17 P-008 (su-path hive-instance override): when the
  // su persona came from the blueprint (flag-on), append the launch hive's INSTANCE override for
  // su — its project-specifics (e.g. the Papercusp hive's Tauri/:3070/endpoint-system content),
  // stored in the federated hive_settings layer (same as the harness-role path, P-003).
  // Best-effort; flag-off (suBaseSource undefined) or no hive ⇒ skipped (byte-identical).
  let suPersonaText = rendered.text;
  if (suBaseSource && harnessSlug) {
    try {
      const { potHomeSlugForHarness } = await import('./hive-federation');
      const { getHiveInstancePromptOverride } = await import('./hive-settings-store');
      const potSlug = await potHomeSlugForHarness(input.workspaceId, harnessSlug);
      if (potSlug) {
        const inst = await getHiveInstancePromptOverride(input.workspaceId, potSlug, 'su');
        if (inst) suPersonaText = `${suPersonaText.replace(/\n+$/, '')}\n\n${inst}`;
      }
    } catch {
      /* best-effort hive-instance su override */
    }
  }
  // EI-996 (owner ask 2026-06-17): append the ROLE ADDENDUM last, so a role running on
  // the su tier reads the full engineer playbook first and its own focus as the final
  // word. Deliberately part of the STABLE prefix (above the launch-context seam below):
  // the addendum is fixed per role, so a cohort of same-role sessions still shares one
  // byte-identical cache entry — it just shares a role-specific one. An omitted/blank
  // addendum leaves suPersonaText untouched, so a plain su launch stays byte-identical.
  const roleAddendum = input.roleAddendum?.trim();
  if (roleAddendum) {
    suPersonaText = `${suPersonaText.replace(/\n+$/, '')}\n\n${roleAddendum}\n`;
  }
  const launchCtx = composeLaunchContext({
    harnessSlug,
    planSlug: input.planSlug ?? null,
    planTitle: input.planTitle ?? null,
    planNow: input.planNow ?? null,
    profile: launchProfile,
  });
  // gateway-cache-plane-shared-prefix-ttl-2026-07-19 P-004: mark the seam between the STABLE
  // playbook (byte-identical across a cohort — renderSuPlaybook is deterministic) and the
  // per-session launch context. The cache-proxy / inference-gateway split the system block here
  // and move the cache_control to the stable side, so the ~66k-token playbook prefix becomes an
  // org-shared cache entry instead of being written fresh every launch (MEASURED: a subsequent
  // cohort session's write dropped 89k → 8k). The sentinel is an HTML comment, so if a request
  // ever reaches Anthropic without being split (proxy off / a non-splitting path) it is inert.
  // No sentinel when there is no launch context — the whole prompt is then stable and Claude
  // Code's own end-of-block breakpoint already shares it.
  // Gated on the same flag the proxy/gateway split on, so PAPERCUSP_CACHE_SPLIT_BOUNDARY=0 yields
  // a prompt byte-identical to today (clean reversible cutover). A flag mismatch across the
  // launcher vs the forward point is harmless either way: an unsplit sentinel is an inert comment,
  // and a missing sentinel just means the split no-ops.
  const emitBoundary = process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY !== '0';
  const promptText = launchCtx
    ? suPersonaText.replace(/\n+$/, '') +
      '\n\n' +
      (emitBoundary ? PSU_CACHE_BOUNDARY + '\n\n' : '') +
      launchCtx
    : suPersonaText;
  const instructionLint = lintInstructionText(promptText);

  // 3. Superuser MCP — the existing loopback door (NOT a signed,
  //    role-scoped URL): `?superuser=1&workspace=<ws>` + the bearer from
  //    ~/.papercusp/superuser-token. Same `.mcp.json` shape
  //    console-launcher writes for the "+" superuser console.
  const token = readSuperuserToken();
  // WI-573: prefer the resilient proxy base when the env opts in (see resolveAgentMcpBaseUrl).
  const mcpUrl = new URL(`${resolveAgentMcpBaseUrl(input.operatorBaseUrl)}/api/mcp`);
  mcpUrl.searchParams.set('superuser', '1');
  mcpUrl.searchParams.set('workspace', input.workspaceId);
  // dynamic-tool-surface-2026-07-01 (D-010, "default all to trimmed"): the small
  // CORE-SPINE seed (`?tools=` → filterListingsByAllowlist in the MCP handler) is now
  // the DEFAULT for EVERY client + tier. It's a SEED, not a hard cap — the server
  // (getSessionSurface) treats it as a growable floor:
  //   • tools:find (in the spine) surfaces the tail by intent → fires
  //     notifications/tools/list_changed → a listChanged-capable client re-fetches
  //     tools/list and calls the tool NATIVELY;
  //   • tools:invoke (also in the spine) calls anything by name for a client that
  //     doesn't re-fetch — the UNIVERSAL reachability fallback;
  //   • a compact CAPABILITY MAP in the MCP initialize instructions
  //     (mcpInstructionsForServer) gives the model the "menu" (categories) so it
  //     knows WHAT exists to search for — discoverability at ~1-2k instead of ~165k.
  // Net: ~165k→~10k tokens with reachability + discoverability preserved. The token
  // cost of loading all ~581 tool names+descriptions up-front is pure waste (a session
  // uses ~15-30), and it's WORST for claude — native ToolSearch defers SCHEMAS but
  // leaves all names+descriptions inline (~165k MEASURED), which DOA'd sonnet-window
  // sessions with "Prompt is too long". So claude is seeded too now.
  //
  const normalizedContextSize = normalizeSuContextSize(input.contextSize);
  if (!normalizedContextSize.ok) throw new Error(normalizedContextSize.error);
  // P-010: su sessions ALWAYS get chat:ask_choice on top of the shared core
  // spine. The seed is growable and therefore preserves full reachability.
  // WI-2140338: an explicit 'steward' opt-in widens the seed to the steward verb
  // families, expanded against the live registry. An empty expansion (registry
  // not populated) on an EXPLICIT steward request is a process-configuration
  // error — refuse loudly rather than silently launching a trimmed session the
  // caller believes is steward-seeded.
  let seedToolNames: readonly string[];
  if (normalizedContextSize.contextSize === 'steward') {
    const steward = stewardSeedToolNames();
    if (steward.length <= CORE_MCP_TOOL_NAMES.length + SU_EXTRA_MCP_TOOL_NAMES.length) {
      throw new Error(
        'buildSuLaunchSpec: contextSize=steward requested but the projected-tool registry expanded no steward-family names — the registry is not populated in this process',
      );
    }
    seedToolNames = steward;
  } else {
    seedToolNames = [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES];
  }
  mcpUrl.searchParams.set('tools', seedToolNames.join(','));
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
    stack: stackRefs,
    promptFile: rendered.baseSource,
    mcpUrl: mcpUrlStr,
    mcpJsonContents,
    personaTier,
    instructionLint,
  };
}

/**
 * /api/harness/:slug/agent-chats — multi-turn conversational sessions
 * with role-scoped agents. Phase A2 (endpoint-hono-elimination-2026-05-21).
 * Ported off `_hono/agent-chats.ts` (mounted via `registerAgentChats`).
 * URLs unchanged.
 *
 *   GET    /api/harness/:slug/agent-chats
 *   POST   /api/harness/:slug/agent-chats
 *   GET    /api/harness/:slug/agent-chats/:chatId
 *   DELETE /api/harness/:slug/agent-chats/:chatId
 *   POST   /api/harness/:slug/agent-chats/:chatId/messages   → SSE stream
 *
 * `auth: 'public'` — the legacy `harness` sub-app gated none of these.
 */
import { join } from 'node:path';
import { sseResponse } from '@papercusp/sse';
import { dispatchProjectedToolStream, lookupByMcpName } from '@papercusp/agent-mcp';
import { getLegacyClient } from '@papercusp/db-org';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { getPromptOverride } from '../../../harness-prompt-overrides';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildMemoryContextBlock } from '../../../memory/injection';
import { projectDirForSlug } from '../../../operator-notes';
import {
  readFeatureLockState,
  rowToChat,
  type ChatRow,
  type TranscriptTurn,
} from '../../../agent-chats-data';
import '../../../agent-tools/index';
import {
  acquireAgentChatLock,
  releaseAgentChatLock,
  type AgentChatLockHandle,
} from '../../../agent-chat-lock';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Per-chat streaming lock — see agent-chat-lock.ts (WI-7139). PG-backed, not a
 * module-scoped Map: :3070 is a 16-worker `node:cluster` release cluster, so an
 * in-memory lock is only effective within ONE of the 16 workers and is
 * defeated by two POSTs for the same chat landing on different ones. A second
 * message POST while a prior one is streaming (on ANY worker) returns 409 —
 * prevents duplicate spawn-and-append races.
 */

/**
 * P-008 (work-item-chat-context-modernize-2026-07-18, D-003/D-004): race any
 * best-effort context-injection read against a hard budget so a slow/wedged
 * leg degrades that ONE section, never the chat turn itself. Shared by the
 * memory-recall pull below and the work-item dossier pull further down —
 * both are inline on the hot chat-reply path, so both must be capped.
 */
function withTimeoutBudget<T>(p: Promise<T>, budgetMs: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs).unref?.()),
  ]);
}

function dbForSlug(slug: string) {
  return getLegacyClient(slug);
}

/**
 * work-item-chat-context-modernize P-003: resolve `chat.feature_id` to its OWN
 * harness BEFORE keying the dossier/checkpoint/plan-context/lock lookups below.
 * The route's `:slug` is the CHAT's harness — but a cross-harness queue/view
 * (an aggregated inbox spanning multiple harnesses) can open a chat for a work
 * item that actually lives in a DIFFERENT harness. Using `slug` directly for
 * those lookups silently keyed every one of them to the wrong harness for such
 * a chat, so the item's own context never resolved — and failed SILENTLY
 * (empty section, no notice), which is exactly what this fix + the loud-miss
 * notice below address together. `getWorkItem` (no harness arg) resolves an
 * id across every harness in the active workspace; falls back to `slug` when
 * the item can't be resolved (no feature_id, an id that doesn't exist yet, or
 * a lookup failure) so a miss here never blocks the chat.
 */
async function resolveItemHarness(
  slug: string,
  featureId: string | null | undefined,
): Promise<{ harness: string; isLegacyBlueprint: boolean }> {
  let harness = slug;
  if (featureId) {
    try {
      const { getWorkItem } = await import('../../../work-items');
      const wi = await getWorkItem(featureId);
      if (wi?.harness) harness = wi.harness;
    } catch { /* best-effort — fall back to the chat's own harness */ }
  }
  let isLegacyBlueprint = true;
  try {
    const { loadHarnessRegistry } = await import('../../../harness-registry');
    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === harness);
    // A `harness_kind:'hive'` harness runs the Mug/cup pot pipeline, never the
    // legacy per-feature `harness_features.taken_by` worktree-claim + the
    // `.papercusp/notes` mechanics (this is the SAME signal D-001 used to
    // characterize "NOT the legacy 3-phase coding blueprint").
    isLegacyBlueprint = project?.harness_kind !== 'hive';
  } catch { /* best-effort — default to legacy-safe (today's unconditional behavior) */ }
  return { harness, isLegacyBlueprint };
}

/** Per-harness chat cost cap from the effective harness config (blueprint ⊕
 *  workspace-PG instance — `deprecate-harness-config-json-2026-06-06`). */
async function readChatCostCap(slug: string): Promise<{ perChatUsd?: number; aggregateUsd?: number }> {
  try {
    const { loadHarnessRegistry } = require('../../../harness-registry') as typeof import('../../../harness-registry');
    const { activeWorkspaceId } = require('../../../workspace-registry') as typeof import('../../../workspace-registry');
    const { readEffectiveHarnessConfig } = require('../../../harness-effective-config') as typeof import('../../../harness-effective-config');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return {};
    const cfg = await readEffectiveHarnessConfig(slug, activeWorkspaceId(), projectDir);
    const out: { perChatUsd?: number; aggregateUsd?: number } = {};
    if (typeof cfg.maxChatCostUsd === 'number' && cfg.maxChatCostUsd > 0) out.perChatUsd = cfg.maxChatCostUsd;
    if (typeof cfg.maxAggregateChatCostUsd === 'number' && cfg.maxAggregateChatCostUsd > 0) {
      out.aggregateUsd = cfg.maxAggregateChatCostUsd;
    }
    return out;
  } catch {
    return {};
  }
}

/** Strict-mode lock policy — default false (soft-warn). */
async function readChatLockPolicy(slug: string): Promise<boolean> {
  try {
    const { loadHarnessRegistry } = require('../../../harness-registry') as typeof import('../../../harness-registry');
    const { activeWorkspaceId } = require('../../../workspace-registry') as typeof import('../../../workspace-registry');
    const { readEffectiveHarnessConfig } = require('../../../harness-effective-config') as typeof import('../../../harness-effective-config');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return false;
    const cfg = await readEffectiveHarnessConfig(slug, activeWorkspaceId(), projectDir);
    const parallelChat = cfg.parallelChat as Record<string, unknown> | undefined;
    return parallelChat?.respectFeatureLocks === true;
  } catch {
    return false;
  }
}

/** Sum of cents across all non-archived chats in this harness. */
async function aggregateChatCostCents(slug: string): Promise<number> {
  try {
    const db = dbForSlug(slug);
    const row = (await db
      .prepare('SELECT COALESCE(SUM(total_cost_usd_cents), 0)::bigint AS total FROM agent_chats WHERE archived_at IS NULL')
      .get()) as { total: number | bigint };
    return typeof row.total === 'bigint' ? Number(row.total) : (row.total ?? 0);
  } catch {
    return 0;
  }
}

const listChatsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats',
  auth: 'public',
  async handler(req, ctx) {
    const { listChats } = await import('../../../agent-chats-data');
    const sp = new URL(req.url).searchParams;
    const parseNum = (v: string | null): number | undefined => {
      if (v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const result = await listChats({
      slug: ctx.params.slug,
      includeArchived: sp.get('include') === 'archived',
      limit: parseNum(sp.get('limit')),
      offset: parseNum(sp.get('offset')),
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const createChatRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats',
  auth: 'loopback',
  async handler(req, ctx) {
    const { createChat } = await import('../../../agent-chats-data');
    let body: { role?: string; feature_id?: string; title?: string };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }); }
    const result = await createChat({
      slug: ctx.params.slug,
      role: body.role ?? '',
      feature_id: body.feature_id,
      title: body.title,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data, { status: 201 });
  },
});

const getChatRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'public',
  async handler(_req, ctx) {
    const { getChat } = await import('../../../agent-chats-data');
    const result = await getChat({ slug: ctx.params.slug, chatId: ctx.params.chatId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const archiveChatRoute = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'loopback',
  async handler(_req, ctx) {
    const { archiveChat } = await import('../../../agent-chats-data');
    const result = await archiveChat({ slug: ctx.params.slug, chatId: ctx.params.chatId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const messagesRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/messages',
  auth: 'loopback',
  // Pure SSE transport — don't flood route_invocations per chat turn.
  sampleRate: 0,
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const chatId = ctx.params.chatId;
    let body: { content?: string; mode?: string };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }); }
    const userContent = (body.content ?? '').trim();
    if (!userContent) return Response.json({ error: 'content is required' }, { status: 400 });

    // Acquire the lock HERE (atomic, cross-worker) rather than only checking —
    // acquiring at the point of the check, not later right before spawn, also
    // closes the intra-process TOCTOU window the old check-then-set-much-later
    // pattern left open (everything between the old check and the old `set`
    // below is async and could interleave two requests on the SAME worker).
    const chatLock: AgentChatLockHandle | null = await acquireAgentChatLock(chatId, activeWorkspaceId());
    if (!chatLock) {
      return Response.json({ error: 'chat already has an in-flight assistant response' }, { status: 409 });
    }
    // From here on, every return path MUST release chatLock. The whole
    // pre-flight sequence below (load chat, cost caps, feature-lock, persist
    // user turn, assemble prompt) has many early-return branches; rather than
    // thread a release call through each one, it's wrapped in one IIFE that
    // either returns an early Response (caller releases + returns it) or the
    // data the spawn step below needs (caller keeps the lock and proceeds).
    type Preflight = Response | {
      chat: ChatRow;
      itemHarness: Awaited<ReturnType<typeof resolveItemHarness>>;
      baseTranscript: TranscriptTurn[];
      projectDir: string;
      assembled: { text: string; runId: string };
    };
    const preflight: Preflight = await (async (): Promise<Preflight> => {
    let chat: ChatRow;
    try {
      const db = dbForSlug(slug);
      const row = (await db.prepare('SELECT * FROM agent_chats WHERE id = ?').get(chatId)) as any;
      if (!row) return Response.json({ error: 'chat not found' }, { status: 404 });
      chat = rowToChat(row);
      if (chat.archived_at) return Response.json({ error: 'chat is archived' }, { status: 410 });
    } catch (e) {
      return Response.json({ error: `failed to load chat: ${(e as Error).message}` }, { status: 500 });
    }

    // Cost-cap checks — per-chat + aggregate.
    const cap = await readChatCostCap(slug);
    if (cap.perChatUsd !== undefined && chat.total_cost_usd_cents >= cap.perChatUsd * 100) {
      return Response.json({
        error: 'per-chat cost cap reached',
        chat_cost_usd: chat.total_cost_usd_cents / 100,
        cap_usd: cap.perChatUsd,
        hint: 'increase config.json `maxChatCostUsd` or archive this chat',
      }, { status: 402 });
    }
    if (cap.aggregateUsd !== undefined) {
      const aggCents = await aggregateChatCostCents(slug);
      if (aggCents >= cap.aggregateUsd * 100) {
        return Response.json({
          error: 'aggregate chat cost cap reached for this harness',
          aggregate_cost_usd: aggCents / 100,
          cap_usd: cap.aggregateUsd,
          hint: 'increase config.json `maxAggregateChatCostUsd` or archive other chats',
        }, { status: 402 });
      }
    }

    // P-003: resolve the item's OWN harness ONCE — `slug` is the chat's/queue-
    // view's harness, which a cross-harness view can differ from.
    const itemHarness = await resolveItemHarness(slug, chat.feature_id);

    // Concurrency awareness — feature-lock state for the prompt notice / strict gate.
    // Keyed to the ITEM's own harness (not `slug`): a legacy per-feature lock only
    // ever lives in ITS OWNING harness's `harness_features` table.
    const featureLock = chat.feature_id
      ? await readFeatureLockState(itemHarness.harness, chat.feature_id)
      : null;
    if (featureLock?.active) {
      const respectLocks = await readChatLockPolicy(itemHarness.harness);
      if (respectLocks) {
        const guidance = itemHarness.isLegacyBlueprint
          ? `drop a note via POST /api/harness/${itemHarness.harness}/features/${chat.feature_id}/notes if you want guidance picked up on the next worker tick`
          : `leave a comment on ${chat.feature_id} (\`work_items:comment\`) so whoever picks it up next sees it`;
        return Response.json({
          error: 'feature_locked',
          feature_id: chat.feature_id,
          taken_by: featureLock.taken_by,
          taken_at: featureLock.taken_at,
          expires_at: featureLock.expires_at,
          hint: `Feature is currently being worked on autonomously by ${featureLock.taken_by}. Wait for the lock to release, or ${guidance}. Disable strict mode by removing parallelChat.respectFeatureLocks from .papercusp/config.json.`,
        }, { status: 409 });
      }
    }

    // Append the user turn before streaming so a client reload sees it.
    const userTurn: TranscriptTurn = { role: 'user', content: userContent, ts: new Date().toISOString() };
    const baseTranscript = [...chat.transcript, userTurn];
    try {
      const db = dbForSlug(slug);
      await db.prepare(`UPDATE agent_chats SET transcript = ?::jsonb, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(baseTranscript), Date.now(), chatId);
    } catch (e) {
      return Response.json({ error: `failed to persist user turn: ${(e as Error).message}` }, { status: 500 });
    }

    // Resolve the project dir IN-PROCESS (workspace-aware, live registry)
    // BEFORE assembly. Without it the assembler falls back to its
    // workspace-blind `lookupProjectDir`, which curls the operator base
    // (default :3055 — not an API port) mid-request and then the legacy
    // ~/.restart-harness-projects.json — so any harness that exists only in
    // the live registry fails to assemble (same class as role-launch-spec
    // step 0 / EI-220).
    const projectDir = await projectDirForSlug(slug);
    if (!projectDir) {
      return Response.json({
        error: `harness "${slug}" is not registered in workspace "${activeWorkspaceId()}"`,
      }, { status: 404 });
    }

    // Assemble the role prompt + transcript history.
    let assembled: { text: string; runId: string };
    try {
      // Workspace-owned prompt override (D-7), best-effort (miss → default).
      let chatOverride: string | undefined;
      try {
        chatOverride = (await getPromptOverride(activeWorkspaceId(), slug, chat.role)) ?? undefined;
      } catch { /* fall back to config.json default */ }
      const r = assembleRolePrompt({
        slug,
        role: chat.role,
        projectDir,
        featureId: chat.feature_id ?? undefined,
        // 'discuss' (client sends it per message) reframes the worker to
        // advise-first; anything else is the default interactive chat.
        mode: body.mode === 'discuss' ? 'discuss' : 'chat',
        promptOverrideText: chatOverride,
      });
      const lockNoticeGuidance = itemHarness.isLegacyBlueprint
        ? `add a note (it lands in \`.papercusp/notes/${chat.feature_id}.md\`, which the next worker tick reads)`
        : `leave a comment on ${chat.feature_id} (\`work_items:comment\`) for whoever is working it`;
      const lockNotice = featureLock?.active
        ? `\n---\n\n## ⚠ Concurrent autonomous run\n\nFeature ${chat.feature_id} is currently being worked on autonomously (taken_by=${featureLock.taken_by}, taken_at=${featureLock.taken_at}). The autonomous loop holds the worktree lock; you do not. **Do not propose code changes**; the user is asking you for advice or context. If they want guidance the autonomous worker should pick up, tell them to ${lockNoticeGuidance}.\n`
        : '';
      const historyBlock = baseTranscript.length > 1
        ? '\n---\n\n## Conversation history\n\n' +
          baseTranscript.slice(0, -1).map((t) => `${t.role === 'user' ? 'User' : 'You (assistant)'}: ${t.content}`).join('\n\n') +
          '\n'
        : '';
      // P-008 (D-003 ground truth): buildMemoryContextBlock previously ran
      // with NO outer budget on this inline chat-reply path — its own
      // internal MEMORY_INJECT_TIMEOUT_MS (5s) bounds each of its 3
      // sequential legs (available/hive-resolve/search) individually, so a
      // cold operator (just-restarted mem0 client) could legitimately stack
      // up to ~15s of sequential waiting, measured live at ~6.7s. Race it
      // against the same 3s budget the dossier pull below uses so a slow
      // recall degrades to "no memory section" instead of stalling the reply.
      const memBlock = await withTimeoutBudget(
        buildMemoryContextBlock({
          userId: null,
          workspaceId: activeWorkspaceId(),
          queryContext: `${chat.role} agent: ${userContent}`,
          heading: 'Agent memory (relevant entries)',
        }),
        3_000,
      );
      const memorySection = memBlock ? `\n---\n\n${memBlock}\n` : '';

      // Plan context — inject for worker/validator/reviewer roles on
      // plan-derived features. Best-effort; 3 s timeout; empty on miss.
      const CHAT_PLAN_ROLES = new Set(['worker', 'validator', 'reviewer']);
      let planContextSection = '';
      if (CHAT_PLAN_ROLES.has(chat.role) && chat.feature_id) {
        try {
          const { getPlanContextForFeature } = await import('../../../plan-context-for-feature');
          const planCtx = await getPlanContextForFeature(itemHarness.harness, chat.feature_id);
          if (planCtx) planContextSection = `\n---\n\n${planCtx.section}\n`;
        } catch { /* best-effort */ }
      }

      // Work-item dossier + carry-note (WI-5125). A chat opened from a work
      // item's Chat button used to arrive knowing NOTHING about that item: the
      // plan-context block above only fires for plan-derived features, so a WI-*
      // chat agent had to be told its own task by the user. The autonomous cup
      // waking on the same item already gets this precomputed — item text, the
      // linked plan item, the `blocks` edges it gates, topics, recent thread
      // comments, the peer roster, standing facts — via computeCupWakeDossier,
      // plus any in-flight checkpoint. Reuse BOTH here (rather than growing a
      // second chat-only context builder) so the human's chat agent and the
      // autonomous worker reason from the SAME world-state and cannot drift.
      //
      // Both are best-effort with an explicit timeout: this runs inline on the
      // chat turn, so a slow/wedged read must degrade the CONTEXT, never hang or
      // fail the reply. Anything missing simply leaves the agent with its tools.
      let dossierSection = '';
      if (chat.feature_id) {
        try {
          const [{ computeCupWakeDossier }, { getWorkItemCheckpoint }] = await Promise.all([
            import('../../../pot/cup-wake-dossier'),
            import('../../../work-item-checkpoint'),
          ]);
          const ws = activeWorkspaceId();
          const [dossier, checkpoint] = await Promise.all([
            withTimeoutBudget(
              computeCupWakeDossier({ workspaceId: ws, harness: itemHarness.harness, workItemId: chat.feature_id }),
              3_000,
            ),
            withTimeoutBudget(
              getWorkItemCheckpoint({ workspaceId: ws, harness: itemHarness.harness, workItemId: chat.feature_id }),
              3_000,
            ),
          ]);
          if (dossier && dossier.trim()) dossierSection += `\n---\n\n${dossier.trim()}\n`;
          if (checkpoint && checkpoint.trim()) {
            dossierSection +=
              `\n---\n\n## In-flight checkpoint for ${chat.feature_id}\n\n` +
              'The last carry-note written on this item — what the agent working it had ' +
              'done, what was left, and any gotchas. It is a SNAPSHOT and may be stale; ' +
              'trust the live item state above where they disagree.\n\n' +
              `${checkpoint.trim()}\n`;
          }
        } catch { /* best-effort — the agent still has its read tools */ }

        // P-003: a SILENT miss here (a timeout, a resolve failure, or the item
        // genuinely not found under `itemHarness.harness`) previously left the
        // model with NO indication its item context is missing — it would just
        // answer as if the item didn't exist, with no cue to reach for its own
        // read tools. Render a loud notice instead whenever nothing loaded.
        if (!dossierSection) {
          dossierSection =
            `\n---\n\n## ⚠ No dossier available for ${chat.feature_id}\n\n` +
            `Could not load this item's dossier (identity, plan links, recent activity, ` +
            `peer roster) or in-flight checkpoint from harness "${itemHarness.harness}" — ` +
            'the lookup timed out, the item may not exist there yet, or a transient error ' +
            'occurred. You do NOT have this item pre-loaded; use your `work_items:get` tool ' +
            `to look up ${chat.feature_id} directly before answering.\n`;
        }
      }

      // work-item-chat-context-modernize P-002: the work-item dossier LEADS the task
      // framing — it identifies WHAT this chat is even about — so it is placed
      // immediately after the persona, before the lock notice / plan context /
      // memory / history. Previously it sat last (after planContextSection),
      // effectively an appendix the model could reach only after wading through
      // lock/plan boilerplate for a feature it may not even recognize yet.
      const promptText = `${r.text}${dossierSection}${lockNotice}${planContextSection}${memorySection}${historyBlock}\n---\n\n## User\n\n${userContent}\n`;
      assembled = { text: promptText, runId: r.meta.runId };
    } catch (e) {
      return Response.json({ error: `failed to assemble prompt: ${(e as Error).message}` }, { status: 500 });
    }

    return { chat, itemHarness, baseTranscript, projectDir, assembled };
    })();

    if (preflight instanceof Response) {
      await releaseAgentChatLock(chatLock);
      return preflight;
    }
    const { chat, itemHarness, baseTranscript, projectDir, assembled } = preflight;

    const tool = lookupByMcpName('agent_chats:chat');
    if (!tool) {
      await releaseAgentChatLock(chatLock);
      return Response.json({ error: 'agent_chats:chat tool not registered' }, { status: 500 });
    }

    // EI-259: a chat turn is a real agent invocation — track it in the durable
    // nursery (harness_shared.spawned_agents) like every other spawn path, so
    // it shows in fleet:tree / intel:spawn_tree and counts a provider slot.
    // Best-effort: tracking failure never blocks the chat (null ⇒ untracked).
    const { beginChatSpawnTracking, resolveChatRunOutcome } =
      await import('../../../fleet/chat-spawn-tracking');
    const spawnTracking = await beginChatSpawnTracking({
      chatId,
      workspaceId: activeWorkspaceId(),
      harnessSlug: slug,
      childRole: chat.role,
      runId: assembled.runId,
      featureId: chat.feature_id ?? null,
      projectDir,
    });

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        let assistantText = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let costUsd = 0;
        let unreportedFrames = 0;
        let lastErrorMessage: string | null = null;
        let lastErrorStderr: string | undefined;
        let toolError: { code: string; message: string } | null = null;
        let sawDone = false;
        let threwMessage: string | null = null;

        try {
          const dispatchCtx = {
            workspaceId: activeWorkspaceId(),
            harnessSlug: slug,
            role: 'operator' as const,
            runId: assembled.runId,
            spawnId: spawnTracking?.spawnId ?? `agent_chats-${chatId}`,
            log: () => { /* */ },
            progress: () => { /* */ },
            emit: () => { /* overridden by dispatcher */ },
            signal: req.signal,
            spawn: async () => { throw new Error('spawn not available in agent_chats shim'); },
            secret: async () => null,
            projectDir: projectDir ?? '',
            stateDir: '',
          };

          for await (const ev of dispatchProjectedToolStream(
            tool,
            'agent_chats:chat',
            // P-004: `harness` scopes + attaches the read-mostly agentmcp
            // surface (work_items:get/list, plans:get, docs:search,
            // memory:search — mcp-config.ts) to the item's OWN harness
            // (itemHarness.harness, per P-003 scoping — NOT the cross-harness
            // queue-view `slug`). Best-effort on the tool side: an
            // unprovisioned build silently runs with no attached MCP tools.
            { promptText: assembled.text, cwd: projectDir ?? undefined, harness: itemHarness.harness },
            dispatchCtx as never,
            {},
          )) {
            if (ev.kind === 'event') {
              if (ev.name === 'delta') {
                const text = (ev.data as { text?: string })?.text ?? '';
                assistantText += text;
                sink.event('delta', { text });
              } else if (ev.name === 'tool_call') {
                const d = ev.data as { name?: string; input?: unknown };
                if (d.name) sink.event('tool_call', { name: d.name, input: d.input });
              } else if (ev.name === 'error') {
                const d = ev.data as { message?: string; stderr?: string };
                lastErrorMessage = d.message ?? 'unknown error';
                lastErrorStderr = d.stderr;
              }
            } else if (ev.kind === 'done') {
              sawDone = true;
              try {
                const blob = ev.result?.content?.[0];
                if (blob && 'text' in blob && typeof blob.text === 'string') {
                  const parsed = JSON.parse(blob.text) as {
                    finalText?: string; tokensIn?: number; tokensOut?: number; costUsd?: number;
                    unreportedFrames?: number;
                  };
                  if (parsed.finalText && parsed.finalText.length > assistantText.length) {
                    assistantText = parsed.finalText;
                  }
                  if (typeof parsed.tokensIn === 'number' && Number.isFinite(parsed.tokensIn)) tokensIn = parsed.tokensIn;
                  if (typeof parsed.tokensOut === 'number' && Number.isFinite(parsed.tokensOut)) tokensOut = parsed.tokensOut;
                  if (typeof parsed.costUsd === 'number' && Number.isFinite(parsed.costUsd)) costUsd = parsed.costUsd;
                  if (typeof parsed.unreportedFrames === 'number' && Number.isSafeInteger(parsed.unreportedFrames) && parsed.unreportedFrames > 0) {
                    unreportedFrames += parsed.unreportedFrames;
                  }
                }
              } catch { /* malformed tool result — keep what we accumulated */ }
            } else if (ev.kind === 'error') {
              toolError = ev.error;
            }
          }
        } catch (e) {
          threwMessage = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          await releaseAgentChatLock(chatLock);
          if (spawnTracking) {
            const outcome = resolveChatRunOutcome({
              sawDone,
              toolErrorMessage: toolError?.message ?? null,
              lastErrorMessage,
              threwMessage,
              aborted: req.signal.aborted,
            });
            await spawnTracking.finish({
              ...outcome,
              outputTail: assistantText ? assistantText.slice(-400) : null,
            });
          }
        }

        // A turn that failed (rate-limit, backend/dispatch error) persists a
        // failure-marker assistant turn — otherwise the transcript keeps only the
        // user turn and a reload / second viewer sees a silent gap. The live
        // sender ALSO gets the inline error event below. Best-effort: a persist
        // failure must not swallow the error signal itself.
        const failureMessage = toolError?.message ?? lastErrorMessage;
        if (failureMessage) {
          const failureTurn: TranscriptTurn = {
            role: 'assistant',
            content: failureMessage,
            ts: new Date().toISOString(),
            tokens_in: 0,
            tokens_out: 0,
            cost_cents: 0,
            error: true,
          };
          try {
            const db = dbForSlug(slug);
            await db.prepare(`UPDATE agent_chats SET transcript = ?::jsonb, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify([...baseTranscript, failureTurn]), Date.now(), chatId);
          } catch { /* best-effort — still emit the error event */ }
          sink.event('error', { message: failureMessage, ...(lastErrorStderr ? { stderr: lastErrorStderr } : {}) });
          sink.close();
          return;
        }

        const finalAssistantTurn: TranscriptTurn = {
          role: 'assistant',
          content: assistantText,
          ts: new Date().toISOString(),
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_cents: Math.round(costUsd * 100),
          ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
        };
        const finalTranscript = [...baseTranscript, finalAssistantTurn];

        try {
          const db = dbForSlug(slug);
          await db.prepare(
            `UPDATE agent_chats
               SET transcript = ?::jsonb,
                   total_input_tokens = total_input_tokens + ?,
                   total_output_tokens = total_output_tokens + ?,
                   total_cost_usd_cents = total_cost_usd_cents + ?,
                   updated_at = ?
             WHERE id = ?`,
          ).run(
            JSON.stringify(finalTranscript),
            tokensIn,
            tokensOut,
            finalAssistantTurn.cost_cents ?? 0,
            Date.now(),
            chatId,
          );
        } catch (e) {
          sink.event('error', { message: `failed to persist assistant turn: ${(e as Error).message}` });
          sink.close();
          return;
        }

        sink.event('done', {
          run_id: assembled.runId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_cents: finalAssistantTurn.cost_cents,
          ...(unreportedFrames > 0 ? { unreportedFrames } : {}),
        });
        sink.close();
      },
    });
  },
});

export default [listChatsRoute, createChatRoute, getChatRoute, archiveChatRoute, messagesRoute];

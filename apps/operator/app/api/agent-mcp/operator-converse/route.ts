/**
 * POST /api/agent-mcp/operator-converse
 *
 * SSE stream of the operator's next conversational turn.
 *
 * Request body:
 *   {
 *     messages: [{ role: 'user'|'assistant'|'system', content }],
 *     trigger:  'user_message' | 'silence_nudge' | 'silence_check' | 'quiet_wait_resume' | 'open_canvas',
 *     mayAskActive: boolean,
 *   }
 *
 * SSE events emitted:
 *   - delta:  { text }                  — token-streamed model output
 *   - done:   { costUsd? }              — stream complete
 *   - error:  { message }               — fatal
 *
 * The shape matches Oracle's /api/oracle/chat so the client-side
 * stream-parser is shared via <ChatConversation>. Only routes + prompt
 * differ — Oracle uses scanner.md / oracle-specific instructions;
 * Operator uses operator.converse.md + operator.persona.md.
 *
 * Tag parsing (<say>, <set_mode>, <sleep>) happens client-side from
 * the buffered delta stream — see lib/operator-converse-tags.ts. The
 * route does NOT pre-parse, so the same wire format works for both
 * the text path and the future voice-realtime path.
 */

import { NextRequest } from 'next/server';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { checkBudget, recordSpend } from '@/lib/operator-budget';
import { parseOperatorTurn } from '@/lib/operator-converse-tags';
import { readSystemPrincipal } from '@/lib/system-principal';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';
import {
  loadRolePersona,
  loadRoleToolsMd,
  loadRoleConverse,
  renderToolsCatalog,
} from '@/lib/prompt-assembly';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'silence_nudge' | 'silence_check' | 'quiet_wait_resume' | 'open_canvas';
  mayAskActive?: boolean;
  /**
   * UI client id of the originating browser tab. The chat surface
   * passes this through so the agent's MCP URL is bound to that tab
   * — `ctx.uiClientId` is populated and `ui:*` tools default to it.
   */
  uiClientId?: string;
}

const HISTORY_KEEP = 30; // last 30 messages — bounds token cost on long convos
const MAX_USER_TURN_CHARS = 8_000; // soft guard against pasted dumps

function buildPrompt(body: ConverseRequestBody): string {
  const messages = (body.messages ?? [])
    .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
    .slice(-HISTORY_KEEP);

  const trigger = body.trigger ?? 'user_message';
  const mayAskActive = !!body.mayAskActive;

  const sections: string[] = [];

  // Phase 3 of the tool-guidance arc: the server brain reads from the
  // .md files via prompt-assembly (single source of truth for human
  // edits). The voice path (lib/voice-engines/*) keeps the condensed
  // OPERATOR_PERSONA_PROMPT TS constant because EL Conv AI's shell
  // agent runs on Haiku with a tight token budget — see comments in
  // lib/operator-persona.ts. Two different LLMs, two different
  // prompts.
  sections.push(loadRoleConverse('operator'));
  sections.push(loadRolePersona('operator'));

  // Tools catalog with per-tool guidance from defineTool({ guidance }).
  // Phase 1a of the tool-guidance arc — renders only the tools the
  // operator is allowed to call. Each ALL_AGENT_MCP_TOOLS entry is the
  // claude-code-visible form (mcp__agentmcp__<name>); we strip the
  // server-alias prefix and pass both candidate forms (claude-code's
  // underscored `orchestrator_spawn` and the registry's dotted
  // `orchestrator.spawn`) so the catalog resolves regardless of the
  // dot-to-underscore translation that claude-code applies. Empty
  // guidance → description-only, so unmigrated tools are
  // backwards-identical to pre-guidance.
  const operatorToolNames: string[] = [];
  for (const fullName of ALL_AGENT_MCP_TOOLS) {
    const stripped = fullName.replace(/^mcp__agentmcp__/, '');
    operatorToolNames.push(stripped);
    if (stripped.includes('_')) {
      // orchestrator_spawn → orchestrator.spawn (registry's canonical
      // MCP name uses `.` for plugin tools, claude-code uses `_`).
      operatorToolNames.push(stripped.replace(/_/g, '.'));
    }
  }
  const catalog = renderToolsCatalog('operator', operatorToolNames);
  if (catalog) sections.push(catalog);

  // Cross-tool playbook + named workflows (Phase 1c). Loaded from
  // operator.tools.md; falls back to empty if the file is missing.
  const playbook = loadRoleToolsMd('operator');
  if (playbook) sections.push(playbook);

  // Conversation history — minimal serialization. Roles are preserved
  // so the model can reason about who said what.
  if (messages.length > 0) {
    const transcript = messages
      .map((m) => {
        const truncated = m.content.length > MAX_USER_TURN_CHARS
          ? m.content.slice(0, MAX_USER_TURN_CHARS) + '…'
          : m.content;
        return `[${m.role}]\n${truncated}`;
      })
      .join('\n\n');
    sections.push(`## Conversation history (oldest first; last ${messages.length} turns)\n\n${transcript}`);
  }

  // Trigger context — tells the model whether this is a normal user
  // message, a self-fired silence nudge, or a quiet-wait resume.
  const triggerLines: Record<NonNullable<ConverseRequestBody['trigger']>, string> = {
    user_message: 'Trigger: user_message — the user just said something. React per the ladder.',
    silence_nudge: 'Trigger: silence_nudge — the user has been silent ~10s. Say a brief silence prompt ("Still with me?", etc). Do not repeat your previous question.',
    silence_check: 'Trigger: silence_check — the user has been silent ~30s after your nudge. Ask once: "Do you want me to go into passive mode?". Do not self-flip.',
    quiet_wait_resume: 'Trigger: quiet_wait_resume — the user just re-engaged after a long silence. Reference where you left off in your first sentence, then continue the thread.',
    open_canvas: 'Trigger: open_canvas — fresh chat with no prior history. Open the conversation per ladder rung 5: ask one open-ended question about what they\'re noticing, hoping for, or quietly worried about. Keep it warm and short — they just opened the panel.',
  };
  sections.push(`## Trigger\n\n${triggerLines[trigger]}`);

  if (mayAskActive) {
    sections.push(`## [may_ask_active]\n\nThe runtime allows you to ask "Do you want me to go back into active mode?" at the end of your reply this turn — turns_in_last_2_min ≥ 3 AND sleep timer expired. Use only if it fits.`);
  }

  return sections.join('\n\n---\n\n');
}

export async function POST(req: NextRequest) {
  let body: ConverseRequestBody = {};
  try {
    body = (await req.json()) as ConverseRequestBody;
  } catch {
    return new Response('invalid JSON body', { status: 400 });
  }

  const promptText = buildPrompt(body);

  // Budget gate. operator-converse fires on every user turn AND on
  // silence-ladder timers AND through ask_operator from voice; without
  // a cap this is the easiest way to burn through the daily budget.
  const budget = await checkBudget();
  if (budget.state && budget.exceeded) {
    return new Response(
      `Operator daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      { status: 402 },
    );
  }

  const ctrl = new AbortController();
  // Tear down the spawn if the client disconnects mid-stream.
  req.signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: Record<string, unknown>) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller closed (client disconnected) */
        }
      };

      try {
        // Wire the agent-mcp server in, same shape as operator-scan.
        // The operator brain needs orchestrator.spawn / poll / cancel
        // to delegate work the user asks for via voice or text — this
        // route is the brain for both transports (text chat directly,
        // voice via the EL ask_operator client tool).
        //
        // If the principal isn't provisioned (fresh install), fall back
        // to the lean tool-less path so conversation still works — the
        // operator just can't spawn until /api/agent-mcp/provision runs.
        const principal = await readSystemPrincipal('operator');
        const workspaceId = activeWorkspaceId();
        const principalOk =
          principal !== null && principal.workspaceId === workspaceId;
        // HTTP MCP transport — points at the operator's own /api/mcp
        // route (apps/operator/app/api/[transport]/route.ts), which
        // exposes the full plugin catalog (orchestrator.spawn et al).
        //
        // Uses ?superuser=1 + Authorization: Bearer <superuser-token>
        // (commit 0ccac7cf) since operator-converse runs at chrome
        // scope (no specific harness/spawn/run context). The bypass
        // turns off role-allowlist + quota gates — the operator role
        // could spawn anything anyway, and we don't have a real spawn
        // to derive runId from. Token lives at ~/.papercusp/superuser-token
        // and is read by the operator process itself, never sent to
        // remote agents.
        // Pass the originating tab's client_id through to the agent's
        // MCP URL so ctx.uiClientId is set and `ui:dispatch` can default
        // to it. Validated as a UUID-ish — anything else is dropped to
        // avoid passing arbitrary attacker-controlled query through.
        const uiClientId = typeof body.uiClientId === 'string' && /^[0-9a-fA-F-]{16,128}$/.test(body.uiClientId)
          ? body.uiClientId
          : null;
        const mcpUrl =
          'http://127.0.0.1:3055/api/mcp?superuser=1' +
          (uiClientId ? `&client=${encodeURIComponent(uiClientId)}` : '');
        let superuserToken: string | null = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          superuserToken = require('node:fs').readFileSync(
            require('node:path').join(require('node:os').homedir(), '.papercusp', 'superuser-token'),
            'utf8',
          ).trim();
          if (!superuserToken || superuserToken.length < 16) superuserToken = null;
        } catch { superuserToken = null; }
        const mcpConfig = principalOk && superuserToken
          ? {
              mcpServers: {
                // omp silently drops type:'http' MCP servers — bridge
                // through mcp-remote (stdio→HTTP) which is the same
                // pattern voice-mode and hindsight already use in
                // ~/.omp/agent/mcp.json. claude-code can also speak
                // this format, so it works for both backends.
                agentmcp: {
                  type: 'stdio',
                  command: 'npx',
                  args: [
                    '-y',
                    'mcp-remote@latest',
                    mcpUrl,
                    '--header',
                    `Authorization:Bearer ${superuserToken}`,
                  ],
                },
              },
            }
          : undefined;
        const allowedTools: readonly string[] =
          principalOk && superuserToken ? ALL_AGENT_MCP_TOOLS : [];

        const events = runAgentChat({
          promptText,
          mcpConfig,
          allowedTools: [...allowedTools],
          permissionMode: 'bypassPermissions',
          signal: ctrl.signal,
        });

        let totalCost = 0;
        let assembled = '';
        for await (const ev of events) {
          if (ctrl.signal.aborted) break;
          if (ev.type === 'delta') {
            send('delta', { text: ev.text });
            assembled += ev.text;
          } else if (ev.type === 'tool_call') {
            // Strip the mcp__agentmcp__ prefix to keep the wire format
            // identical to operator-scan's tool_call events. Sidebar can
            // render "operator delegated to a worker" inline.
            const name = ev.name.startsWith('mcp__agentmcp__')
              ? ev.name.replace(/^mcp__agentmcp__/, '')
              : ev.name;
            send('tool_call', { name, input: ev.input });
          } else if (ev.type === 'result') {
            totalCost = ev.costUsd ?? 0;
            void recordSpend(totalCost);
          }
        }
        // Server-side <spawn> tag dispatch. Parsing the assembled
        // turn here (rather than only in the client provider) ensures
        // the voice path also triggers spawns — EL's ask_operator
        // handler returns the say body to EL, but it never invokes
        // our client-side parser. The HTTP API call here is what makes
        // the spawn actually happen for both text and voice surfaces.
        try {
          const parsed = parseOperatorTurn(assembled);
          for (const sp of parsed.spawns) {
            const params = new URLSearchParams({
              workspace: workspaceId, // resolved earlier from activeWorkspaceId()
              harness: 'system',
              role: 'operator',
              run: `op-converse-${Date.now()}`,
              spawn: `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            });
            const body: Record<string, unknown> = { role: sp.role };
            if (sp.featureId) body.featureId = sp.featureId;
            if (sp.chunkId) body.chunkId = sp.chunkId;
            if (sp.extras.length > 0) body.extras = sp.extras;
            void fetch(`http://127.0.0.1:3055/api/plugins/orchestrator/spawn?${params.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }).catch((err) => {
              console.warn('[operator-converse] spawn dispatch failed', err);
            });
          }
        } catch (err) {
          console.warn('[operator-converse] spawn parse/dispatch error', err);
        }
        send('done', { costUsd: totalCost });
      } catch (err) {
        if (!ctrl.signal.aborted) {
          send('error', { message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      ctrl.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}

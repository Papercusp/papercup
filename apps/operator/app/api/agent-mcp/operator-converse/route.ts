/**
 * POST /api/agent-mcp/operator-converse
 *
 * SSE stream of the operator's next conversational turn.
 *
 * Request body:
 *   {
 *     messages: [{ role: 'user'|'assistant'|'system', content }],
 *     trigger:  'user_message' | 'silence_nudge' | 'silence_check' | 'quiet_wait_resume',
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
import { runClaudeChat } from '@/lib/claude-chat-stream';
import { OPERATOR_CONVERSE_PROMPT } from '@/lib/operator-converse-prompt';
import { OPERATOR_PERSONA_PROMPT } from '@/lib/operator-persona';
import { checkBudget, recordSpend } from '@/lib/operator-budget';
import { readSystemPrincipal } from '@/lib/system-principal';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ConverseRequestBody {
  messages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  trigger?: 'user_message' | 'silence_nudge' | 'silence_check' | 'quiet_wait_resume';
  mayAskActive?: boolean;
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

  // Substrate-owned + persona — shared with the voice path.
  sections.push(OPERATOR_CONVERSE_PROMPT);
  sections.push(OPERATOR_PERSONA_PROMPT);

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
        const mcpUrl = 'http://127.0.0.1:3055/api/mcp?superuser=1';
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

        const events = runClaudeChat({
          promptText,
          mcpConfig,
          allowedTools: [...allowedTools],
          permissionMode: 'bypassPermissions',
          signal: ctrl.signal,
        });

        let totalCost = 0;
        for await (const ev of events) {
          if (ctrl.signal.aborted) break;
          if (ev.type === 'delta') {
            send('delta', { text: ev.text });
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

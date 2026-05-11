/**
 * Operator-side wrapper around the shared agent chat-stream runner.
 *
 * The runtime lives in `@restart/papercup-shared/agent/chat-stream` so
 * apps/papercup can call it too (visitor chatbot at /api/_hono/
 * public-papercup.ts). This file just hooks the operator's
 * /settings/agent persistence (`agent-config.ts`) into the shared
 * runner so saved backend/cmd/models settings land in process.env on
 * the first spawn after a server restart.
 *
 * Existing imports (`from '@/lib/agent-chat-stream'`) keep working —
 * we re-export the same symbols.
 */
import {
  runAgentChat,
  setAgentConfigBootstrap,
  type AgentBackend,
  type ChatEvent,
  type RunAgentChatOptions,
} from '@restart/papercup-shared/agent';
import { applyToProcessEnv, readAgentConfig } from './agent-config';

setAgentConfigBootstrap(async () => applyToProcessEnv(await readAgentConfig()));

export { runAgentChat };
export type { AgentBackend, ChatEvent, RunAgentChatOptions };

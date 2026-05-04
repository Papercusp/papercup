/**
 * Browser-side leader bridge.
 *
 * When the local tab is the elected leader for its workspace, this
 * module subscribes to the server's SSE channel and runs any commands
 * the server pushes — POSTing their results back via the result endpoint.
 *
 * Followers (non-leader tabs) do nothing. When a tab gains/loses
 * leadership it opens/closes the SSE stream accordingly.
 *
 * See plan §3.3 (multi-tab arbitration).
 */

import { runCommand, runQuery, get } from './registry';
import type { AgentId, CommandContext, CommandResult } from './types';

interface BridgeOptions {
  /** Active workspace id. The bridge re-opens its stream when this changes. */
  getWorkspace: () => string;
  /** True when this tab is the elected leader. */
  isLeader: () => boolean;
  /** Subscribe to leader-state changes; returns an unsubscribe function. */
  onLeaderChange: (cb: () => void) => () => void;
  /** Stable tab id used as sessionId on the server side. */
  tabId: string;
}

interface IncomingCommand {
  requestId: string;
  command: { id: string; args: unknown };
}

let active: { close: () => void } | null = null;

export function startLeaderBridge(opts: BridgeOptions): () => void {
  const reconnect = () => {
    active?.close();
    if (!opts.isLeader()) {
      active = null;
      return;
    }
    const workspace = opts.getWorkspace();
    active = openStream(workspace, opts.tabId);
  };

  reconnect();
  const unsubLeader = opts.onLeaderChange(reconnect);

  return () => {
    active?.close();
    active = null;
    unsubLeader();
  };
}

function openStream(workspace: string, tabId: string): { close: () => void } {
  const url = `/api/agent-mcp/run-command/sse?workspace=${encodeURIComponent(workspace)}&sessionId=${encodeURIComponent(tabId)}`;
  const es = new EventSource(url);

  es.addEventListener('command', (evt) => {
    try {
      const msg = JSON.parse((evt as MessageEvent).data) as IncomingCommand;
      void handleIncoming(msg, workspace, tabId);
    } catch (err) {
      console.warn('[leader-bridge] failed to parse incoming command', err);
    }
  });

  es.addEventListener('hello', () => {
    // server confirmed registration; no-op
  });

  es.addEventListener('heartbeat', () => {
    // server is alive; nothing else to do
  });

  es.addEventListener('error', () => {
    // EventSource auto-reconnects; let it.
  });

  return {
    close: () => {
      try {
        es.close();
      } catch { /* already closed */ }
    },
  };
}

async function handleIncoming(
  msg: IncomingCommand,
  workspace: string,
  tabId: string,
): Promise<void> {
  const def = get(msg.command.id);
  let result: CommandResult;
  if (!def) {
    result = {
      ok: false,
      error: { code: 'unknown', message: `no such command on this tab: ${msg.command.id}`, retryable: false },
    };
  } else {
    const ctx: CommandContext = {
      // Cross-process callers will mostly be Oracle / EL webhook → 'oracle' / 'operator'.
      // We accept the server's authority on agent identity by defaulting to 'operator';
      // future iteration may pass agent through the SSE payload.
      agent: 'operator' as AgentId,
      workspace,
      sessionId: tabId,
      requestId: msg.requestId,
    };
    result =
      def.kind === 'command'
        ? await runCommand(msg.command.id, msg.command.args, ctx)
        : await runQuery(msg.command.id, msg.command.args, ctx);
  }
  await postResult(msg.requestId, result);
}

async function postResult(requestId: string, result: CommandResult): Promise<void> {
  try {
    await fetch('/api/agent-mcp/run-command/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, result }),
    });
  } catch (err) {
    console.warn('[leader-bridge] failed to post result', err);
  }
}

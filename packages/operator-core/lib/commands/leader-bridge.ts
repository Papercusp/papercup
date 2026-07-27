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

import { createResilientEventSource } from '@papercusp/sse';
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

// A plain module-level `let` is NOT sufficient to guarantee only one live
// stream: if this module is ever evaluated more than once in the same page
// (e.g. reached through two different bundler-resolved specifiers for the
// same file — a dual-bundling edge case, see EI-18758340172989350), each
// evaluation gets its OWN copy of the variable, so one instance's
// `reconnect()` closes only ITS OWN stream and never sees the other
// instance's — leaving both connected. That is exactly the "2 identical
// EventSources, same tabId" symptom observed 2026-07-27 (a duplicated
// leader-bridge stream contributing to WebKit's 6-per-host connection
// budget being exhausted). Park the singleton on `globalThis` under a fixed
// key instead, so every evaluation of this module — however many there
// turn out to be — reads and writes the SAME live-stream handle.
const ACTIVE_KEY = '__papercuspLeaderBridgeActive__';
interface ActiveStream { close: () => void }
function getActiveStream(): ActiveStream | null {
  return (globalThis as Record<string, unknown>)[ACTIVE_KEY] as ActiveStream | null ?? null;
}
function setActiveStream(next: ActiveStream | null): void {
  (globalThis as Record<string, unknown>)[ACTIVE_KEY] = next;
}

export function startLeaderBridge(opts: BridgeOptions): () => void {
  const reconnect = () => {
    getActiveStream()?.close();
    if (!opts.isLeader()) {
      setActiveStream(null);
      return;
    }
    const workspace = opts.getWorkspace();
    setActiveStream(openStream(workspace, opts.tabId));
  };

  reconnect();
  const unsubLeader = opts.onLeaderChange(reconnect);

  return () => {
    getActiveStream()?.close();
    setActiveStream(null);
    unsubLeader();
  };
}

function openStream(workspace: string, tabId: string): { close: () => void } {
  const url = `/api/agent-mcp/run-command/sse?workspace=${encodeURIComponent(workspace)}&sessionId=${encodeURIComponent(tabId)}`;
  const source = createResilientEventSource({
    url,
    handlers: {
      command: (data) => {
        try {
          const msg = JSON.parse(data) as IncomingCommand;
          void handleIncoming(msg, workspace, tabId);
        } catch (err) {
          console.warn('[leader-bridge] failed to parse incoming command', err);
        }
      },
      hello: () => { /* server confirmed registration */ },
      heartbeat: () => { /* keepalive — wrapper resets its zombie watchdog */ },
    },
  });
  return { close: () => source.close() };
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

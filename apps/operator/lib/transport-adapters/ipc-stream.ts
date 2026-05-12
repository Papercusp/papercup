/**
 * Tauri IPC transport adapter. Used on desktop when isTauri() returns
 * true AND PAPERCUSP_FORCE_HTTP_TRANSPORT is not set.
 *
 * Wire path: webview JS → Tauri invoke('endpoint_invoke') → Rust
 * IpcClient → Unix socket / named pipe → Node IPC server →
 * dispatchProjectedToolStream → ctx.emit() → frame → Rust reader →
 * Channel<EndpointEvent> → here.
 *
 * The Rust side ships binary events as base64 (Tauri's IPC serializer
 * is JSON-based). We decode back to Uint8Array on yield, so consumers
 * see a uniform `EndpointStreamEvent` shape across transports.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
} from './types';

/** Wire shape on the JS side of the Tauri Channel<EndpointEvent>. */
type RustEndpointEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'binary'; name: string; data: string /* base64 */ }
  | { kind: 'done'; result: { content: Array<{ type: string; [k: string]: unknown }> } }
  | { kind: 'error'; code: string; message: string };

function base64ToUint8(b64: string): Uint8Array {
  // Tauri webview is Chromium; atob is available. Keep this path simple
  // — if we need to support Node-side callers later, we can branch.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function* dispatchEndpointStreamIpc<TInput>(
  toolName: string,
  input: TInput,
  options: DispatchEndpointStreamOptions = {},
): AsyncIterable<EndpointStreamEvent> {
  const queue: EndpointStreamEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  const channel = new Channel<RustEndpointEvent>();
  channel.onmessage = (msg) => {
    if (msg.kind === 'binary') {
      queue.push({ kind: 'binary', name: msg.name, data: base64ToUint8(msg.data) });
    } else if (msg.kind === 'done' || msg.kind === 'error') {
      queue.push(msg);
      done = true;
    } else {
      queue.push(msg);
    }
    wake?.();
    wake = null;
  };

  let callId: number;
  try {
    callId = await invoke<number>('endpoint_invoke', {
      toolName,
      input,
      channel,
    });
  } catch (err) {
    yield {
      kind: 'error',
      code: 'invoke_failed',
      message: err instanceof Error ? err.message : String(err),
    };
    return;
  }

  // Wire the caller's AbortSignal to send a CANCEL frame.
  const onAbort = (): void => {
    void invoke('endpoint_cancel', { callId }).catch(() => { /* ignore */ });
  };
  if (options.signal) {
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (true) {
      if (queue.length === 0 && !done) {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      while (queue.length > 0) {
        const ev = queue.shift()!;
        yield ev;
        if (ev.kind === 'done' || ev.kind === 'error') return;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (!done) {
      // Consumer broke out of the iterator before terminal — tell the
      // server to abort the call.
      onAbort();
    }
  }
}

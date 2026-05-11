/**
 * Batch H — operator-side iframe surface for WASM/sandboxed plugins.
 *
 * Renders a sandboxed iframe whose HTML is templated by the operator
 * (per rev3 plan A2: single-origin + operator-templated wrapper). The
 * iframe's HTML is served from /api/plugins/<slug>/iframe/<entry> so
 * the document's origin is the operator's origin (CSP applies; cookies
 * accessible only via host-mediated channels).
 *
 * postMessage bridge:
 *   - rpc-request → invokePluginAction (via /api/plugins/host/invoke)
 *   - event-subscribe → wires onto SSE stream from /api/plugins/host/events
 *   - query → /api/plugins/host/query (PG read)
 *   - iframe:navigate → checked against runtime.iframeNavigateOrigins +
 *     iframe:navigate:<origin> cap from manifest+grants
 *
 * Source-window check: every inbound message is rejected unless
 * event.source === iframeRef.current.contentWindow.
 *
 * Per-iframe nonce: generated at mount, embedded in the script tag,
 * checked on every postMessage envelope (defense-in-depth in case the
 * source-window check is bypassed via cross-origin scripts).
 */
'use client';

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  pluginName: string;
  installSlug: string;
  /** Manifest's ui[].iframeEntry (relative path inside the plugin dir). */
  iframeEntry: string;
  /** Origins the iframe is permitted to top-navigate to (Batch H5). */
  navigateOrigins?: string[];
  height?: number | string;
  width?: number | string;
}

/**
 * Pure cap-check for iframe top-navigation requests (Batch H5,
 * `iframe:navigate:<origin>`). Exported so the OAuth-roundtrip smoke
 * test can exercise it without rendering React or simulating
 * postMessage. Returns null on a denied or invalid URL; the parsed
 * URL on allow.
 */
export function isNavigateAllowed(navigateOrigins: string[], url: string): URL | null {
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  const allowed = navigateOrigins.some((o) => o === target.origin || o === '*');
  return allowed ? target : null;
}

interface RpcRequest { kind: 'rpc-request'; id: string; action: string; payloadB64: string; nonce: string }
type RpcResponse =
  | { kind: 'rpc-response'; id: string; ok: true; payloadB64: string; nonce: string }
  | { kind: 'rpc-response'; id: string; ok: false; error: { tag: string; message: string }; nonce: string };
interface EventSub { kind: 'event-subscribe'; name: string; nonce: string }
interface EventUnsub { kind: 'event-unsubscribe'; name: string; nonce: string }
interface EventMsg { kind: 'event'; name: string; payloadB64: string; nonce: string }
interface QueryMsg { kind: 'query'; query: string; id: string; nonce: string }
interface QueryResult { kind: 'query-result'; id: string; rows: unknown[]; nonce: string }
interface NavigateReq { kind: 'iframe-navigate'; url: string; nonce: string }
type Inbound = RpcRequest | EventSub | EventUnsub | QueryMsg | NavigateReq;

function genNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function PluginIframe({
  pluginName,
  installSlug,
  iframeEntry,
  navigateOrigins = [],
  height = '100%',
  width = '100%',
}: Props): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [nonce] = useState(genNonce);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subs = new Map<string, EventSource>(); // event-name → SSE handle

    const send = (msg: object): void => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage({ ...msg, nonce }, '*');
    };

    const onMessage = async (ev: MessageEvent): Promise<void> => {
      // Source-window check: only accept from our own iframe.
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data as Partial<Inbound> | null;
      if (!data || typeof data !== 'object') return;
      // Per-iframe nonce check.
      if ((data as { nonce?: string }).nonce !== nonce) return;

      switch (data.kind) {
        case 'rpc-request': {
          const r = data as RpcRequest;
          try {
            const res = await fetch('/api/plugins/host/invoke', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                pluginName,
                installSlug,
                actionName: r.action,
                payloadB64: r.payloadB64,
                surface: 'iframe',
              }),
            });
            const json = (await res.json()) as { ok: boolean; payloadB64?: string; error?: string };
            const reply: RpcResponse = json.ok && json.payloadB64 != null
              ? { kind: 'rpc-response', id: r.id, ok: true, payloadB64: json.payloadB64, nonce }
              : { kind: 'rpc-response', id: r.id, ok: false, error: { tag: 'plugin-error', message: json.error ?? 'unknown' }, nonce };
            send(reply);
          } catch (e: unknown) {
            const reply: RpcResponse = {
              kind: 'rpc-response',
              id: r.id,
              ok: false,
              error: { tag: 'plugin-error', message: e instanceof Error ? e.message : String(e) },
              nonce,
            };
            send(reply);
          }
          break;
        }
        case 'event-subscribe': {
          const e = data as EventSub;
          if (subs.has(e.name)) return;
          const url = `/api/plugins/host/events?plugin=${encodeURIComponent(pluginName)}&install=${encodeURIComponent(installSlug)}&name=${encodeURIComponent(e.name)}`;
          const sse = new EventSource(url);
          sse.addEventListener('message', (msg) => {
            const evt: EventMsg = { kind: 'event', name: e.name, payloadB64: btoa(msg.data ?? ''), nonce };
            send(evt);
          });
          subs.set(e.name, sse);
          break;
        }
        case 'event-unsubscribe': {
          const e = data as EventUnsub;
          subs.get(e.name)?.close();
          subs.delete(e.name);
          break;
        }
        case 'query': {
          const q = data as QueryMsg;
          try {
            const res = await fetch('/api/plugins/host/query', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ pluginName, installSlug, query: q.query }),
            });
            const json = (await res.json()) as { rows?: unknown[]; error?: string };
            const reply: QueryResult = { kind: 'query-result', id: q.id, rows: json.rows ?? [], nonce };
            send(reply);
          } catch {
            const reply: QueryResult = { kind: 'query-result', id: q.id, rows: [], nonce };
            send(reply);
          }
          break;
        }
        case 'iframe-navigate': {
          // Batch H5 — iframe:navigate:<origin> capability check.
          const n = data as NavigateReq;
          const target = isNavigateAllowed(navigateOrigins, n.url);
          if (!target) {
            console.warn(`[PluginIframe] navigation denied for ${n.url} (manifest iframeNavigateOrigins=${navigateOrigins.join(',')})`);
            return;
          }
          // Top-navigate the parent. CSP gates which destinations
          // are reachable; the cap check above is the manifest gate.
          window.location.href = n.url;
          break;
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      for (const sse of subs.values()) sse.close();
    };
    // navigateOrigins is an array — joining stringifies the dependency
    // so a new-but-equal array on re-render doesn't tear down the
    // postMessage listener + SSE handles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, pluginName, installSlug, navigateOrigins.join(',')]);

  if (error) {
    return <div style={{ padding: 24, color: 'red' }}>{error}</div>;
  }

  // Operator-templated source URL — single origin, CSP enforced server-side.
  // The /api/plugins/<plugin>/iframe/<entry> route serves the plugin's
  // HTML wrapped in an operator-controlled <head> with the per-iframe
  // nonce embedded as a meta tag the iframe SDK reads.
  // iframeEntry is a relative path that may contain '/' (e.g.
  // 'iframe/index.html'). The route is a catch-all `[...entry]`, so
  // encoding each segment individually is safest — preserves slashes
  // as path separators while encoding any reserved chars in the
  // segment names. Path-traversal segments ('..') are caught by the
  // wrapper route's startsWith guard.
  const entryEncoded = iframeEntry
    .split('/')
    .filter((p) => p.length > 0)
    .map(encodeURIComponent)
    .join('/');
  const src = `/api/plugins/${encodeURIComponent(pluginName)}/iframe/${entryEncoded}?install=${encodeURIComponent(installSlug)}&nonce=${nonce}`;

  return (
    <iframe
      ref={iframeRef}
      src={src}
      // sandbox attribute set per rev3 A2 (single-origin + sandbox).
      // allow-scripts is required for the SDK; allow-same-origin is
      // omitted so the iframe document gets a unique opaque origin
      // that can't read parent cookies.
      sandbox="allow-scripts allow-forms"
      style={{ border: 0, width, height, background: 'transparent' }}
      title={`${pluginName} iframe`}
      onError={() => setError(`failed to load iframe entry: ${iframeEntry}`)}
    />
  );
}

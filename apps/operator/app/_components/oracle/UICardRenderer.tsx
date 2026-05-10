/**
 * UICardRenderer — renders an mcp-ui UIResource inline.
 *
 * Phase E pilot scope: static rendering only. Accepts an HTML string
 * (mimeType `text/html`) or an external URL (`text/html` with iframeUrl).
 * No bidirectional MCP-app bridge yet — when a use case needs the
 * interactive `text/html;profile=mcp-app` profile, swap this for
 * @mcp-ui/client's AppRenderer / AppFrame and pass an AppBridge.
 *
 * Sandbox attribute is intentionally minimal:
 *   allow-scripts          — JS can run inside the card
 *   (no allow-same-origin) — so the card cannot read the operator's
 *                            cookies or call same-origin endpoints
 *   (no allow-top-navigation) — card can't yank the user away
 */

'use client';

import { useEffect, useRef, useState } from 'react';

export interface UICardRendererProps {
  /** UIResource as returned by an MCP tool/call. */
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, unknown>;
  };
  /** Optional fallback height in pixels. Default 240. */
  defaultHeight?: number;
  /** Optional className to forward to the wrapper. */
  className?: string;
}

function decodeBlob(b64: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return atob(b64);
  } catch {
    return '';
  }
}

function isExternalUrl(text: string): string | null {
  // mcp-ui externalUrl encoding: a single `<iframe src="...">` or a bare URL
  // string. Heuristic: treat it as external if the entire content is a URL.
  const trimmed = text.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'https:' || u.protocol === 'http:') return trimmed;
  } catch {
    /* not a URL */
  }
  return null;
}

export function UICardRenderer({
  resource,
  defaultHeight = 240,
  className,
}: UICardRendererProps) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(defaultHeight);

  // Some mcp-ui hosts listen for postMessage size hints from the guest;
  // keep a minimal listener so cards that send `{ type: 'mcpUi:size', height }`
  // can resize themselves up to a reasonable cap.
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== ref.current?.contentWindow) return;
      const d = ev.data as Record<string, unknown> | null;
      if (
        d &&
        typeof d === 'object' &&
        d.type === 'mcpUi:size' &&
        typeof d.height === 'number'
      ) {
        const h = Math.min(800, Math.max(80, d.height));
        setHeight(h);
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const text = resource.text ?? (resource.blob ? decodeBlob(resource.blob) : '');
  const externalUrl = isExternalUrl(text);

  return (
    <div
      className={className}
      style={{
        border: '1px solid var(--pc-border, rgba(255,255,255,.08))',
        borderRadius: 8,
        overflow: 'hidden',
        background: 'transparent',
      }}
      data-mcp-ui-uri={resource.uri}
    >
      <iframe
        ref={ref}
        title={`mcp-ui: ${resource.uri}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{ width: '100%', height, border: 0, display: 'block' }}
        {...(externalUrl
          ? { src: externalUrl }
          : { srcDoc: text })}
      />
    </div>
  );
}

/** Convenience: detect whether a tool/call content entry is a UIResource. */
export function isUIResourceContent(c: unknown): c is {
  type: 'resource';
  resource: UICardRendererProps['resource'];
} {
  return (
    !!c &&
    typeof c === 'object' &&
    (c as { type?: unknown }).type === 'resource' &&
    typeof (c as { resource?: unknown }).resource === 'object' &&
    typeof ((c as { resource?: { uri?: unknown } }).resource?.uri) === 'string' &&
    String((c as { resource: { uri: string } }).resource.uri).startsWith('ui://')
  );
}

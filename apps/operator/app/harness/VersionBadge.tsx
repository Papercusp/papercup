'use client';

import { useEffect, useRef, useState } from 'react';
import './VersionBadge.css';

interface VersionInfo {
  appVersion: string;
  sidecarSha: string;
  sidecarStartedAtMs: number;
  nowMs: number;
  isDesktop: boolean;
}

const POLL_MS = 30_000;

export function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [stale, setStale] = useState(false);
  const initialShaRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const r = await fetch('/api/desktop/version', { cache: 'no-store' });
        if (!r.ok) return;
        const data = (await r.json()) as VersionInfo;
        if (cancelled) return;
        setInfo(data);
        if (initialShaRef.current === null) {
          initialShaRef.current = data.sidecarSha;
        } else if (data.sidecarSha !== initialShaRef.current) {
          setStale(true);
        }
      } catch {
        // network blip — keep prior value
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!info) return null;

  const onClick = () => {
    if (stale) window.location.reload();
  };

  const title = stale
    ? 'Sidecar restarted with new code — click to reload'
    : `app v${info.appVersion} · sidecar ${info.sidecarSha}\nstarted ${new Date(info.sidecarStartedAtMs).toLocaleString()}\n${info.isDesktop ? 'desktop' : 'browser'}`;

  return (
    <button
      type="button"
      className={`version-badge${stale ? ' is-stale' : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      <span className="version-badge__app">v{info.appVersion}</span>
      <span className="version-badge__sep">·</span>
      <span className="version-badge__sha">{info.sidecarSha}</span>
      {stale && <span className="version-badge__reload">↻ reload</span>}
    </button>
  );
}

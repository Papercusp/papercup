'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  loadVoicePrefsClient,
  setVoicePrefsClient,
  subscribeVoicePrefsClient,
} from '@/app/_components/voice/voice-prefs-client';
import type { VoicePrefs } from '@/lib/voice-prefs';

type AudienceMode = 'engineer' | 'novice';

const LS_KEY = 'pc:audienceMode';

async function saveAudienceMode(mode: AudienceMode): Promise<void> {
  // Broadcast to other tabs before the fetch so the storage event fires promptly.
  try { localStorage.setItem(LS_KEY, mode); } catch { /* private browsing */ }
  const r = await fetch('/api/agent-mcp/operator-voice-prefs', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audienceMode: mode }),
  });
  if (r.ok) {
    const next = await r.json() as VoicePrefs;
    setVoicePrefsClient(next);
  }
}

export function AudienceModeSelector() {
  const [mode, setMode] = useState<AudienceMode>('engineer');

  useEffect(() => {
    setMode(loadVoicePrefsClient().audienceMode ?? 'engineer');
    // Same-tab sync: fires when this tab calls setVoicePrefsClient.
    const unsub = subscribeVoicePrefsClient((next) => {
      setMode(next.audienceMode ?? 'engineer');
    });
    // Cross-tab sync: fires when another tab writes LS_KEY.
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY && (e.newValue === 'engineer' || e.newValue === 'novice')) {
        setMode(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsub();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const select = useCallback((next: AudienceMode) => {
    setMode(next);
    void saveAudienceMode(next);
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <div className="audience-mode-selector" role="group" aria-label="Audience mode">
        <button
          type="button"
          className={`audience-mode-btn${mode === 'engineer' ? ' audience-mode-btn--active' : ''}`}
          onClick={() => select('engineer')}
          aria-pressed={mode === 'engineer'}
          title="Engineer mode — peer-level, terse, full technical vocabulary"
        >
          Engineer
        </button>
        <button
          type="button"
          className={`audience-mode-btn${mode === 'novice' ? ' audience-mode-btn--active' : ''}`}
          onClick={() => select('novice')}
          aria-pressed={mode === 'novice'}
          title="Novice mode — plain language, outcome-first, no implementation questions"
        >
          Novice
        </button>
      </div>
    </>
  );
}

const CSS = `
.audience-mode-selector {
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(125, 211, 252, 0.20));
  overflow: hidden;
  flex-shrink: 0;
}
.audience-mode-btn {
  flex: 1;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background: transparent;
  border: none;
  color: var(--fg-mute, #94a3b8);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  white-space: nowrap;
}
.audience-mode-btn + .audience-mode-btn {
  border-left: 1px solid var(--border, rgba(125, 211, 252, 0.20));
}
.audience-mode-btn:hover {
  background: rgba(125, 211, 252, 0.08);
  color: var(--fg, #e7eef7);
}
.audience-mode-btn--active {
  background: rgba(56, 189, 248, 0.14);
  color: var(--accent-strong, #7dd3fc);
}
`;

'use client';

/**
 * Listens for `operator:delegation-complete` events (dispatched by the
 * delegate_to_claude command in lib/commands/defs/delegation.ts) and:
 *   1. Stores the latest delegation result in operator-shared-state
 *      so the panel can render it.
 *   2. Opens the panel if voicePanelAutoOpen is true.
 *
 * Mounted once at the chrome shell level; no UI of its own.
 */

import { useEffect } from 'react';

export default function OperatorDelegationListener() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onDelegation = async (evt: Event) => {
      const detail = (evt as CustomEvent).detail as
        | { fullText?: string; claudeSessionId?: string | null; costUsd?: number }
        | undefined;
      if (!detail) return;

      // Read pref to decide auto-open. Don't block the panel update on it.
      let autoOpen = true;
      try {
        const r = await fetch('/api/agent-mcp/operator-voice-prefs');
        if (r.ok) {
          const prefs = await r.json();
          autoOpen = prefs.voicePanelAutoOpen !== false;
        }
      } catch { /* default true */ }

      try {
        const { setOperatorState } = await import('./operator-shared-state');
        // Stash the latest delegation result on the shared state so the
        // panel can render it. We extend the state object with a
        // best-effort structural cast — older readers ignore unknown keys.
        setOperatorState({
          ...(autoOpen ? { open: true } : {}),
          // @ts-expect-error: lastDelegation is added in PR 3 but the
          // shared-state type is in libs/papercusp; widen later.
          lastDelegation: {
            fullText: detail.fullText ?? '',
            claudeSessionId: detail.claudeSessionId ?? null,
            costUsd: detail.costUsd ?? 0,
            ts: Date.now(),
          },
        });
      } catch { /* ignore */ }
    };

    window.addEventListener('operator:delegation-complete', onDelegation as EventListener);
    return () =>
      window.removeEventListener('operator:delegation-complete', onDelegation as EventListener);
  }, []);

  return null;
}

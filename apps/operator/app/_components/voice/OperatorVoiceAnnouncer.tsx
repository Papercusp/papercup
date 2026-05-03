'use client';

/**
 * OperatorVoiceAnnouncer (Phase 3c, v4 §2d).
 *
 * Closed-panel cadence-bound spoken status. When the panel is CLOSED
 * and voice mode is `always-on` AND `speakCadenceStatus` toggle is on,
 * speak:
 *   - "Scanning..." on background scan start
 *   - "Surfaced N suggestions, M auto-dispatched" on scan done
 *
 * When the panel is OPEN, the panel itself owns suggestion-arrival
 * announcements; this component stays silent to avoid double-speech.
 *
 * Listens to background-scan SSE via a shared event mechanism (the
 * BackgroundScanner exposes scan lifecycle via window CustomEvents).
 */

import { useEffect, useRef } from 'react';
import { speak, getVoiceState } from './voice-mode';
import { sharedState } from '../operator-shared-state';
import { loadVoicePrefsClient } from './voice-prefs-client';

type ScanEvent = { kind: 'scan-start' } | { kind: 'scan-done'; suggestions: number; autoDispatched: number };
void (null as unknown as ScanEvent); // type used in event detail shape; kept for documentation

export function OperatorVoiceAnnouncer(): null {
  const lastScanStartRef = useRef<number>(0);

  useEffect(() => {
    const onScan = (e: Event) => {
      const ce = e as CustomEvent<{ kind: string; suggestions?: number; autoDispatched?: number }>;
      const detail = ce.detail;
      if (!detail) return;

      // Gate: voice mode = always-on, panel CLOSED, toggle on
      const v = getVoiceState();
      if (v.mode !== 'always-on') return;
      if (sharedState.open) return;
      const prefs = loadVoicePrefsClient();
      if (!prefs.speakCadenceStatus) return;

      if (detail.kind === 'scan-start') {
        // Dedup back-to-back scan-starts (debounce window collapses)
        const now = Date.now();
        if (now - lastScanStartRef.current < 30_000) return;
        lastScanStartRef.current = now;
        speak('Scanning workspace.', 'system:operator', 'polite');
      } else if (detail.kind === 'scan-done') {
        const n = detail.suggestions ?? 0;
        const m = detail.autoDispatched ?? 0;
        const phrase = n === 0
          ? 'Scan complete. No new suggestions.'
          : m > 0
            ? `Scan complete. Surfaced ${n} suggestion${n === 1 ? '' : 's'}, ${m} auto-dispatched.`
            : `Scan complete. Surfaced ${n} suggestion${n === 1 ? '' : 's'}.`;
        speak(phrase, 'system:operator', 'polite');
      }
    };

    window.addEventListener('operator:scan', onScan as EventListener);
    return () => window.removeEventListener('operator:scan', onScan as EventListener);
  }, []);

  return null;
}

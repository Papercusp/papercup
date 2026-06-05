'use client';

/**
 * Operator background scanner (Phase 3a/3b/3d/3f of the v5 operator plan).
 *
 * Mounted in the chrome layout. Polls trigger-state every 30s; on a
 * fingerprint change starts a debounced scan (trailing 60s, max-stall
 * 5min). Background scans hit the operator-scan endpoint with
 * `?background=1` so the server applies the per-workspace rate limit,
 * the 503 circuit breaker, and the idle short-circuit.
 *
 * Auto-fire toasts: when a tier=low / standing-approved suggestion comes
 * back with `auto_dispatch=true`, we render a Sonner toast with a 5s
 * Cancel countdown. Cancel within 5s → undo-cancel (audit-only, no
 * preferences entry). Pass through → dispatch via the same
 * /api/admin/execute-action path the panel uses.
 *
 * Pause respects globally: when sharedState.paused is true, this stops
 * polling entirely (no LLM burn, no toasts).
 */

import { useEffect, useRef } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isAutoAcceptedByThreshold, pushAutoAcceptEvent, sharedState, subscribeOperatorState } from '@papercusp/operator-core/lib/operator-shared-state';
import { speak, getVoiceState } from './voice/voice-mode';
import { registerVoiceConsumer } from './voice/VoiceAppBridge';
import { loadVoicePrefsClient } from './voice/voice-prefs-client';

const POLL_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 60_000;
const MAX_STALL_MS = 5 * 60_000;
const UNDO_WINDOW_MS_VISUAL = 5_000;
const UNDO_WINDOW_MS_VOICE = 8_000;  // v4 §2c: extended for STT latency

interface SuggestionEvent {
  id: string;
  title: string;
  why: string;
  reason: string;
  action: 'send_directive' | 'navigate' | 'inform';
  capability?: string | null;
  target_harness?: string;
  directive_kind?: 'Directive' | 'Decision' | 'Priority';
  directive_subject?: string;
  directive_body?: string;
  auto_dispatch: boolean;
}

export function OperatorBackgroundScanner() {
  const lastFpRef = useRef<string | null>(null);
  const lastChangeAtRef = useRef<number>(0);
  const lastScanCompletedRef = useRef<number>(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<{ close: () => void } | null>(null);
  const pausedRef = useRef<boolean>(sharedState.paused);
  const autoAcceptRef = useRef<typeof sharedState.autoAccept>(sharedState.autoAccept);
  // Server-side pause flag (CLI `operator pause` / API POST). Cached so
  // each tick doesn't pay an HTTP round-trip; refreshed on mount and
  // whenever the SSE bus signals `operatorPauseFlag` invalidation.
  const cliPausedRef = useRef<boolean>(false);

  useEffect(() => {
    return subscribeOperatorState((s) => {
      if (typeof s.paused === 'boolean') pausedRef.current = s.paused;
      if (s.autoAccept) autoAcceptRef.current = s.autoAccept;
    });
  }, []);

  // Pause-flag via useQuery with the SSE-keyed cache prefix. The
  // SSEAdapter mounted by HarnessZeroProvider (root layout) matches
  // queryKey[1] === 'operatorPauseFlag' on the invalidate event from
  // setPaused/setResumed and triggers a refetch. Tick reads the
  // cached ref so the per-tick HTTP round-trip is gone.
  const pauseFlagQuery = useQuery<{ paused?: boolean }>({
    queryKey: ['sync', 'operatorPauseFlag', {}],
    queryFn: async ({ signal }) => {
      const r = await fetch('/api/agent-mcp/operator-pause-flag', { signal });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    staleTime: Infinity, // refetch only on SSE invalidate
  });
  useEffect(() => {
    cliPausedRef.current = pauseFlagQuery.data?.paused === true;
  }, [pauseFlagQuery.data]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const triggerScan = () => {
      if (inFlightRef.current) return;
      if (pausedRef.current) return;
      // Background scans run unconditionally now — the threshold gates
      // auto-fire, not whether scans run at all. Cards can still surface
      // for user review even when autoAccept is 'off'.
      try {
        window.dispatchEvent(new CustomEvent('operator:scan', { detail: { kind: 'scan-start' } }));
      } catch { /* ignore */ }
      let suggestionsCount = 0;
      let autoDispatchedCount = 0;
      // One-shot scan stream: disable visibility-pause (we want it to complete
      // even if the tab is briefly hidden) and disable failure escalation
      // (the underlying endpoint emits a single 'done' and closes).
      const source = createResilientEventSource({
        url: '/api/agent-mcp/operator-scan?background=1&request=Background+scan%3A+surface+next-action+suggestions.',
        maxConsecutiveFailures: 0,
        handlers: {
          suggestion: (data) => {
            try {
              const s = JSON.parse(data) as SuggestionEvent;
              suggestionsCount++;
              const tierAllowed = isAutoAcceptedByThreshold(s.actualTier, autoAcceptRef.current);
              const shouldAutoFire = tierAllowed;
              if (s.auto_dispatch || shouldAutoFire) autoDispatchedCount++;
              if (!shouldAutoFire) return;
              armAutoFireToast(s);
            } catch { /* ignore */ }
          },
          done: () => {
            source.close();
            inFlightRef.current = null;
            lastScanCompletedRef.current = Date.now();
            try {
              window.dispatchEvent(new CustomEvent('operator:scan', {
                detail: { kind: 'scan-done', suggestions: suggestionsCount, autoDispatched: autoDispatchedCount },
              }));
            } catch { /* ignore */ }
          },
        },
        onError: () => {
          source.close();
          inFlightRef.current = null;
          lastScanCompletedRef.current = Date.now();
        },
      });
      inFlightRef.current = source;
    };

    const scheduleScan = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(triggerScan, DEBOUNCE_MS);
    };

    const tick = async () => {
      if (pausedRef.current) return;
      // Tick runs the periodic poll regardless of autoAccept — the threshold
      // controls auto-firing of cards, not whether scans run.
      // CLI pause sentinel: respect `operator pause` even when the panel
      // hasn't been opened (so sharedState.paused never flipped). Pulled
      // from the cached ref refreshed via SSE — the previous per-tick
      // fetch is gone (notify-driven now).
      if (cliPausedRef.current) return;
      try {
        const r = await fetch('/api/agent-mcp/operator-trigger-state');
        if (!r.ok) return;
        const { fingerprint } = (await r.json()) as { fingerprint: string };
        const now = Date.now();
        if (lastFpRef.current === null) {
          // First observation — anchor without firing.
          lastFpRef.current = fingerprint;
          lastChangeAtRef.current = now;
          return;
        }
        if (fingerprint !== lastFpRef.current) {
          lastFpRef.current = fingerprint;
          lastChangeAtRef.current = now;
          scheduleScan();
          return;
        }
        // Fingerprint unchanged. Force-fire on max-stall: if change anchor
        // is older than MAX_STALL_MS and we haven't scanned since.
        if (
          lastChangeAtRef.current > 0 &&
          now - lastChangeAtRef.current > MAX_STALL_MS &&
          now - lastScanCompletedRef.current > MAX_STALL_MS
        ) {
          lastChangeAtRef.current = now;
          scheduleScan();
        }
      } catch {
        /* network blip — try again next tick */
      }
    };

    timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();

    return () => {
      if (timer) clearInterval(timer);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (inFlightRef.current) {
        inFlightRef.current.close();
        inFlightRef.current = null;
      }
    };
  }, []);

  return null;
}

function armAutoFireToast(s: SuggestionEvent) {
  let cancelled = false;
  const id = `op-toast-${s.id}`;

  // Voice gate: per v4 §2c, when voice mode is on AND speakBackgroundToasts
  // toggle is on, BOTH the visual ring and the underlying commit deadline
  // extend to 8s. Visual matches truth.
  const voiceState = getVoiceState();
  const prefs = loadVoicePrefsClient();
  const voiceActive = voiceState.mode !== 'off' && prefs.speakBackgroundToasts;
  const undoMs = voiceActive ? UNDO_WINDOW_MS_VOICE : UNDO_WINDOW_MS_VISUAL;

  // Conditional `<harness>: <title>` prefix per v4 §2c (#9): only for
  // variants with target_harness. inform speaks unprefixed.
  const spokenTitle = s.target_harness && (s.action === 'send_directive' || s.action === 'navigate')
    ? `${s.target_harness}: ${s.title}`
    : s.title;
  const cue = ' Say cancel to skip.';
  if (voiceActive) {
    speak(`${spokenTitle}.${cue}`, 'system:operator', 'polite');
  }

  // Toast voice consumer: register a background-toast-priority handler
  // that listens for "cancel" within the window and triggers cancellation.
  let toastDereg: (() => void) | null = null;
  if (voiceActive) {
    toastDereg = registerVoiceConsumer(
      `background-toast-${s.id}`,
      'background-toast',
      (utterance: string) => {
        const lower = utterance.trim().toLowerCase();
        if (lower === 'cancel') {
          cancelled = true;
          // v4 §2m: voice-initiated cancel — actor_method='voice'.
          void fetch('/api/agent-mcp/operator-audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cardId: s.id, kind: 'undo_cancel', actorMethod: 'voice' }),
          });
          toast.dismiss(id);
          if (toastDereg) { toastDereg(); toastDereg = null; }
        }
      },
    );
  }

  toast(spokenTitle, {
    id,
    description: s.why.slice(0, 280),
    duration: undoMs,
    action: {
      label: 'Cancel',
      onClick: () => {
        cancelled = true;
        void fetch('/api/agent-mcp/operator-audit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cardId: s.id, kind: 'undo_cancel' }),
        });
        toast.dismiss(id);
        if (toastDereg) { toastDereg(); toastDereg = null; }
      },
    },
  });

  setTimeout(() => {
    if (toastDereg) { toastDereg(); toastDereg = null; }
    if (cancelled) return;
    void dispatchSuggestion(s);
    toast(`Dispatched: ${spokenTitle}`, { duration: 3_000 });
  }, undoMs);
}

async function dispatchSuggestion(s: SuggestionEvent) {
  if (s.action !== 'send_directive' || !s.target_harness) return;
  const r = await fetch('/api/agent-mcp/operator-dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      actionId: `${s.id}:dispatch`,
      op: 'send_message',
      to: [s.target_harness],
      kind: s.directive_kind ?? 'Directive',
      subject: s.directive_subject ?? s.title,
      body: s.directive_body ?? '',
      reason: s.reason,
    }),
  });
  if (r.ok) {
    pushAutoAcceptEvent({
      id: s.id,
      title: s.title,
      tier: s.actualTier,
      targetHarness: s.target_harness,
      acceptedAt: Date.now(),
      source: 'auto-fire',
    });
    void fetch('/api/agent-mcp/operator-audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cardId: s.id,
        kind: 'accepted',
        context: { action: s.action, capability: s.capability ?? null, target: s.target_harness, source: 'auto-fire' },
      }),
    });
  } else {
    const text = await r.text().catch(() => '');
    void fetch('/api/agent-mcp/operator-audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cardId: s.id,
        kind: 'accept_failed',
        context: { action: s.action, target: s.target_harness, reason: text || `HTTP ${r.status}`, source: 'auto-fire' },
      }),
    });
  }
}

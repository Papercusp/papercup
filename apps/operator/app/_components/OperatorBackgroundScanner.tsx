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
import { toast } from 'sonner';
import { sharedState, subscribeOperatorState } from './operator-shared-state';

const POLL_INTERVAL_MS = 30_000;
const DEBOUNCE_MS = 60_000;
const MAX_STALL_MS = 5 * 60_000;
const UNDO_WINDOW_MS = 5_000;

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
  const inFlightRef = useRef<EventSource | null>(null);
  const pausedRef = useRef<boolean>(sharedState.paused);

  useEffect(() => {
    return subscribeOperatorState((s) => {
      if (typeof s.paused === 'boolean') pausedRef.current = s.paused;
    });
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const triggerScan = () => {
      if (inFlightRef.current) return;
      if (pausedRef.current) return;
      const es = new EventSource('/api/agent-mcp/operator-scan?background=1&request=Background+scan%3A+surface+next-action+suggestions.');
      inFlightRef.current = es;
      es.addEventListener('suggestion', (ev: MessageEvent) => {
        try {
          const s = JSON.parse(ev.data) as SuggestionEvent;
          if (!s.auto_dispatch) return; // ask-first → wait for the user to open the panel
          armAutoFireToast(s);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener('done', () => {
        es.close();
        inFlightRef.current = null;
        lastScanCompletedRef.current = Date.now();
      });
      es.addEventListener('error', () => {
        es.close();
        inFlightRef.current = null;
        lastScanCompletedRef.current = Date.now();
      });
    };

    const scheduleScan = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(triggerScan, DEBOUNCE_MS);
    };

    const tick = async () => {
      if (pausedRef.current) return;
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
  const toastId = toast(
    `Operator queued: ${s.title}`,
    {
      id,
      description: s.why.slice(0, 280),
      duration: UNDO_WINDOW_MS,
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
        },
      },
    },
  );
  void toastId;
  setTimeout(() => {
    if (cancelled) return;
    void dispatchSuggestion(s);
    toast(`Dispatched: ${s.title}`, { duration: 3_000 });
  }, UNDO_WINDOW_MS);
}

async function dispatchSuggestion(s: SuggestionEvent) {
  if (s.action !== 'send_directive' || !s.target_harness) return;
  void fetch('/api/agent-mcp/operator-audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cardId: s.id,
      kind: 'dispatched',
      context: { action: s.action, capability: s.capability ?? null, target: s.target_harness },
    }),
  });
  const r = await fetch('/api/admin/execute-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 'send_message',
      to: [s.target_harness],
      kind: s.directive_kind ?? 'Directive',
      subject: s.directive_subject ?? s.title,
      body: s.directive_body ?? '',
      reason: s.reason,
    }),
  });
  if (r.ok) {
    void fetch('/api/agent-mcp/operator-audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId: s.id, kind: 'acked' }),
    });
  }
}

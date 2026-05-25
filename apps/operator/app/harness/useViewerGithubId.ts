'use client';

/**
 * useViewerGithubId — Phase 8 P-047 client helper.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 *
 * Fetches the current viewer's `github_user_id` from /api/auth/me. The
 * session-user shape carries `github_user_id` once the user has bound
 * via OAuth (Phase 1b); otherwise returns 0.
 *
 * Returns 0 while the request is in flight + on any failure. Consumers
 * gate features on `> 0` rather than waiting for a separate "loaded"
 * flag — the UI is fine showing the viewer-anonymous variant during
 * the brief load window.
 *
 * Pure: fetchImpl injectable for tests; SWR-free intentionally so the
 * hook can run in any client context.
 */

import { useEffect, useState } from 'react';

export interface UseViewerGithubIdOpts {
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
}

interface AuthMeResponse {
  user?: {
    github_user_id?: number | string | null;
  };
}

function coerceUserId(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function useViewerGithubId(opts: UseViewerGithubIdOpts = {}): number {
  const [id, setId] = useState(0);
  const fetchImpl = opts.fetchImpl ?? fetch;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetchImpl('/api/auth/me');
        if (!res.ok) return;
        const body = (await res.json().catch(() => ({}))) as AuthMeResponse;
        if (cancelled) return;
        const ghId = coerceUserId(body.user?.github_user_id);
        if (ghId > 0) setId(ghId);
      } catch {
        // Hold at 0 — caller's anonymous-viewer branch handles it.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  return id;
}

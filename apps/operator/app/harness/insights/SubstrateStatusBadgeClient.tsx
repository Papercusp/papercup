'use client';

/**
 * SubstrateStatusBadgeClient — fetch + render wrapper.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Polls /api/admin/dogfood-substrate-status and renders
 * SubstrateStatusBadge with the right mode:
 *
 *   - enabled=false                   → disabled
 *   - enabled=true, slug missing      → booting
 *   - enabled=true, slug in booted    → booted
 *
 * When `slug` is omitted, treats `bootedCount > 0` as booted.
 *
 * Pure-UI testability: fetchImpl + refresh interval injectable.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  SubstrateStatusBadge,
  type SubstrateStatus,
} from './SubstrateStatusBadge';

export interface SubstrateStatusBadgeClientProps {
  /** Filter to one harness. Omit for workspace-wide. */
  slug?: string;
  /** Poll interval in ms. Default 5000. Set to 0 to fetch once. */
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface StatusResponse {
  enabled?: boolean;
  booted?: Array<{ workspaceId: string; harnessSlug: string }>;
  bootedCount?: number;
}

function deriveStatus(
  resp: StatusResponse | null,
  slug: string | undefined,
): { status: SubstrateStatus; hint: string | null } {
  if (!resp) {
    return { status: 'booting', hint: null };
  }
  if (resp.enabled !== true) {
    return { status: 'disabled', hint: null };
  }
  const list = resp.booted ?? [];
  if (slug) {
    const here = list.find((b) => b.harnessSlug === slug);
    return here
      ? { status: 'booted', hint: null }
      : { status: 'booting', hint: null };
  }
  const n = typeof resp.bootedCount === 'number' ? resp.bootedCount : list.length;
  if (n > 0) {
    return {
      status: 'booted',
      hint: `${n} harness${n === 1 ? '' : 'es'}`,
    };
  }
  return { status: 'booting', hint: null };
}

export function SubstrateStatusBadgeClient(
  props: SubstrateStatusBadgeClientProps,
): ReactNode {
  const { slug, refreshIntervalMs = 5000, fetchImpl } = props;
  const [resp, setResp] = useState<StatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const run = async () => {
      try {
        const r = await f('/api/admin/dogfood-substrate-status', {
          cache: 'no-store',
        });
        if (!r.ok) return;
        const json = (await r.json()) as StatusResponse;
        if (!cancelled) setResp(json);
      } catch {
        // never throw — stay in last-known state
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (refreshIntervalMs > 0) {
      timer = setInterval(() => void run(), refreshIntervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [fetchImpl, refreshIntervalMs]);

  const { status, hint } = deriveStatus(resp, slug);
  return <SubstrateStatusBadge status={status} hint={hint ?? undefined} />;
}

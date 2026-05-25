'use client';

/**
 * SubstrateHealthPillClient — fetch + render wrapper.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Polls /api/admin/dogfood-substrate-health and renders
 * SubstrateHealthPill for one (workspace, harness) row. When slug is
 * omitted, picks the worst verdict across all harnesses so a single
 * pill in the chrome header summarises the workspace.
 *
 * Pure UI; fetchImpl + refresh interval injectable for tests.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  SubstrateHealthPill,
  type SubstrateHealthVerdict,
} from './SubstrateHealthPill';

interface HarnessHealthRow {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

interface HealthResponse {
  flagEnabled?: boolean;
  harnesses?: HarnessHealthRow[];
}

export interface SubstrateHealthPillClientProps {
  /** Filter to one harness. Omit for workspace-wide worst-verdict. */
  slug?: string;
  /** Poll interval in ms. Default 10s. */
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

const VERDICT_RANK: Record<SubstrateHealthVerdict, number> = {
  disabled: 0,
  healthy: 1,
  booting: 2,
  degraded: 3,
  unhealthy: 4,
};

function pickWorst(rows: HarnessHealthRow[]): HarnessHealthRow | null {
  if (rows.length === 0) return null;
  let worst = rows[0]!;
  for (const r of rows) {
    if (VERDICT_RANK[r.verdict] > VERDICT_RANK[worst.verdict]) {
      worst = r;
    }
  }
  return worst;
}

export function SubstrateHealthPillClient(
  props: SubstrateHealthPillClientProps,
): ReactNode {
  const { slug, refreshIntervalMs = 10_000, fetchImpl } = props;
  const [resp, setResp] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const run = async () => {
      try {
        const r = await f('/api/admin/dogfood-substrate-health', {
          cache: 'no-store',
        });
        if (!r.ok) return;
        const json = (await r.json()) as HealthResponse;
        if (!cancelled) setResp(json);
      } catch {
        // stay on last-known state
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

  const rows = resp?.harnesses ?? [];
  let row: HarnessHealthRow | null = null;
  if (slug) {
    row = rows.find((r) => r.harnessSlug === slug) ?? null;
    if (!row && resp?.flagEnabled === false) {
      row = { workspaceId: '', harnessSlug: slug, verdict: 'disabled', reasons: ['flag off'] };
    }
  } else {
    row = pickWorst(rows);
  }
  if (!row) return null;
  return <SubstrateHealthPill verdict={row.verdict} reasons={row.reasons} />;
}

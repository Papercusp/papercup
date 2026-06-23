/**
 * useModelOverride — read/write a single agent's SESSION model override
 * (model-override-sidebar-2026-06-23), shared by the 🛡 Sentinel and 👁 Overwatch
 * tabs. Reads `hive.steering.modelOverrides[role]` (the home hive's row) and writes
 * via `hive:set-steering` (which invalidates `hive.steering`, so the read refreshes;
 * for the Sentinel it ALSO projects the spec to ~/.papercusp/sentinel-model for the
 * dock wrapper). Writes MERGE — setting one role preserves the other's override.
 */
import { useCallback, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';

interface SteeringRow {
  slug: string;
  modelOverrides?: Record<string, string> | null;
}

async function runSetSteering(args: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hive:set-steering', args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? 'hive:set-steering refused');
}

export interface ModelOverrideState {
  /** The role's current session override spec (`model[:effort]`), or null ⇒ default. */
  override: string | null;
  busy: boolean;
  error: string | null;
  /** Set the role's spec, or null to clear. Merges so the other role is preserved. */
  setOverride: (spec: string | null) => void;
}

export function useModelOverride(role: string, enabled = true): ModelOverrideState {
  const q = useSyncQuery<SteeringRow>({ queryName: 'hive.steering', args: {}, staleTime: 15_000, enabled });
  const current = q.data?.[0]?.modelOverrides ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setOverride = useCallback(
    (spec: string | null) => {
      setBusy(true);
      setError(null);
      // Merge so a peer role's override (e.g. overwatch when writing sentinel) survives.
      const merged: Record<string, string> = { ...(current ?? {}) };
      if (spec && spec.trim()) merged[role] = spec.trim();
      else delete merged[role];
      const next = Object.keys(merged).length > 0 ? merged : null;
      void runSetSteering({ modelOverrides: next })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [current, role],
  );

  return { override: current?.[role] ?? null, busy, error, setOverride };
}

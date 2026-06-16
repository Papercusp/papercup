/**
 * useAccountOverride — shared client logic for the owner's session-now account
 * override (accounts-pool-tab-2026-06-15 P-004): read it once, toggle force/exclude
 * per account, clear it. Backed by su-81fe4's GET/POST
 * /api/admin/deploy-accounts/session-override (hive_settings, fail-soft). Each POST
 * returns the new override (no refetch) and invalidates accounts.pool (cards refresh).
 *
 * Consumed by BOTH the AdvShell Accounts tab (per-card toggles) and the left-sidebar
 * Accounts tab next to Queen (the Queen-adjacent owner-steering lever, P-005).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

export interface AccountOverride {
  forcedAccounts: string[];
  excludeAccounts: string[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useAccountOverride() {
  const [override, setOverride] = useState<AccountOverride | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/admin/deploy-accounts/session-override');
        const j = (await res.json()) as { ok?: boolean; override?: AccountOverride };
        if (live && j?.ok && j.override) setOverride(j.override);
      } catch {
        /* fail-soft — no override shown */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const patchOverride = useCallback(async (patch: { forcedAccounts?: string[]; excludeAccounts?: string[]; clear?: boolean }) => {
    setOverrideBusy(true);
    try {
      const res = await fetch('/api/admin/deploy-accounts/session-override', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; override?: AccountOverride };
      if (!res.ok || !j.ok) throw new Error(j.error || 'override failed');
      setOverride(j.override ?? { forcedAccounts: [], excludeAccounts: [] });
      toast.success(patch.clear ? 'Cleared the account override' : 'Updated the account override');
    } catch (e) {
      toast.error(`Override failed: ${errMsg(e)}`);
    } finally {
      setOverrideBusy(false);
    }
  }, []);

  const forced = useMemo(() => new Set(override?.forcedAccounts ?? []), [override]);
  const excluded = useMemo(() => new Set(override?.excludeAccounts ?? []), [override]);
  const overrideActive = forced.size > 0 || excluded.size > 0;

  const toggleForce = useCallback(
    (id: string) => void patchOverride({ forcedAccounts: forced.has(id) ? [...forced].filter((x) => x !== id) : [...forced, id] }),
    [forced, patchOverride],
  );
  const toggleExclude = useCallback(
    (id: string) => void patchOverride({ excludeAccounts: excluded.has(id) ? [...excluded].filter((x) => x !== id) : [...excluded, id] }),
    [excluded, patchOverride],
  );
  const clearOverride = useCallback(() => void patchOverride({ clear: true }), [patchOverride]);

  return { override, overrideBusy, forced, excluded, overrideActive, toggleForce, toggleExclude, clearOverride, patchOverride };
}

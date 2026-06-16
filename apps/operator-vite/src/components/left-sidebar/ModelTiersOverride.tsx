/**
 * ModelTiersOverride — the 👑 Queen tab's model-tier SESSION override
 * (queen-steering-panel-2026-06-15 D-006, #4).
 *
 * A session-now override of the workspace-default "Model tiers (weakest →
 * strongest)" menu for the running fleet, with a per-tier default-vs-override
 * badge + reset — like the other steering controls. The owner retunes which
 * model each tier runs at for THIS session (e.g. push the fleet stronger/cheaper)
 * WITHOUT changing the workspace default (which lives in Settings → Agent).
 *
 * Precedence (enforced at the spawn chokepoint, fleet/operator-spawn.ts via
 * `effectiveTierConfig`): session override > workspace agent-config > committed
 * default. Empty / all-default ⇒ no override (the workspace default is used).
 *
 * The full tier EDITOR (add/remove rows, names, backends, when-guidance) stays in
 * Settings — it does not fit the narrow Colony rail. Here the owner overrides each
 * tier's MODEL SPEC (the session-y lever); the tier set + names track Settings.
 *
 * Reads the workspace baseline from /api/agent-config; the session override
 * arrives via the `hive.steering` row (`modelTiers`); writes via the parent's
 * `onWrite` (→ `hive:set-steering { modelTiers }`).
 */
import { useEffect, useState } from 'react';
// type-only (erased at build): a VALUE import of operator-core constants doesn't
// resolve in the operator-vite vitest env, so the workspace-default tiers come
// from the server (/api/agent-config → defaultTiers) instead of a client import.
import type { ModelTier } from '@papercusp/operator-core/lib/agent-config-constants';

/** The effective spec for a tier: the session override if set, else the baseline. Pure. */
export function effectiveSpec(baseline: readonly ModelTier[], override: readonly ModelTier[] | null, name: string): string {
  const o = override?.find((t) => t.name === name)?.spec;
  return o ?? baseline.find((t) => t.name === name)?.spec ?? '';
}

/** True when a tier's effective spec differs from the workspace baseline. Pure. */
export function isOverridden(baseline: readonly ModelTier[], override: readonly ModelTier[] | null, name: string): boolean {
  const base = baseline.find((t) => t.name === name)?.spec;
  const o = override?.find((t) => t.name === name)?.spec;
  return o != null && o !== base;
}

/**
 * Compute the new override array after setting one tier's spec. Returns the full
 * baseline menu with the session spec-overrides applied — or null when nothing
 * differs from the baseline (⇒ clear the override). Pure.
 */
export function withTierSpec(
  baseline: readonly ModelTier[],
  override: readonly ModelTier[] | null,
  name: string,
  spec: string,
): ModelTier[] | null {
  const overrideMap = new Map((override ?? []).map((t) => [t.name, t.spec]));
  const next = baseline.map((t) => ({
    ...t,
    spec: t.name === name ? spec.trim() : (overrideMap.get(t.name) ?? t.spec),
  }));
  const differs = next.some((t, i) => t.spec !== baseline[i]?.spec);
  return differs ? next : null;
}

export default function ModelTiersOverride({
  override,
  onWrite,
  busy,
}: {
  override: ModelTier[] | null;
  onWrite: (modelTiers: ModelTier[] | null) => void;
  busy: boolean;
}) {
  const [baseline, setBaseline] = useState<ModelTier[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancel = false;
    fetch('/api/agent-config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (cancel) return;
        const tiers = d?.config?.tiers;
        // config.tiers when the workspace has customized them, else the server's
        // committed default menu (defaultTiers) — the EFFECTIVE workspace baseline.
        const fallback = Array.isArray(d?.defaultTiers) ? (d.defaultTiers as ModelTier[]) : [];
        setBaseline(Array.isArray(tiers) && tiers.length > 0 ? tiers : fallback);
      })
      .catch(() => {
        /* leave baseline empty → the loading placeholder */
      });
    return () => {
      cancel = true;
    };
  }, []);

  const overriding = (override?.length ?? 0) > 0;

  const commit = (name: string) => {
    const spec = drafts[name] ?? effectiveSpec(baseline, override, name);
    onWrite(withTierSpec(baseline, override, name, spec));
    setDrafts((d) => {
      const next = { ...d };
      delete next[name];
      return next;
    });
  };
  const resetTier = (name: string) => {
    const base = baseline.find((t) => t.name === name)?.spec ?? '';
    onWrite(withTierSpec(baseline, override, name, base));
    setDrafts((d) => {
      const next = { ...d };
      delete next[name];
      return next;
    });
  };

  return (
    <section className="pc-queen__section">
      <div className="pc-queen__section-head">
        <span className="pc-queen__section-title">Model tiers</span>
        <span className="pc-queen__count">{overriding ? 'session override' : 'workspace default'}</span>
      </div>
      <div className="pc-queen__scope">
        Session override of the workspace model tiers for the running fleet. Edit a tier's model to retune this
        session; reset returns it to the Settings default. (Precedence: session &gt; workspace &gt; default.)
      </div>
      {baseline.length === 0 ? (
        <div className="pc-queen__placeholder">Loading tiers…</div>
      ) : (
        <ul className="pc-mt">
          {baseline.map((t) => {
            const over = isOverridden(baseline, override, t.name);
            const draft = drafts[t.name] ?? effectiveSpec(baseline, override, t.name);
            return (
              <li key={t.name} className={`pc-mt__row${over ? ' pc-mt__row--on' : ''}`}>
                <span className="pc-mt__name" title={t.name}>{t.name}</span>
                <input
                  className="pc-mt__spec"
                  value={draft}
                  disabled={busy}
                  aria-label={`${t.name} model spec`}
                  placeholder="model[:effort]"
                  onChange={(e) => setDrafts((d) => ({ ...d, [t.name]: e.target.value }))}
                  onBlur={() => commit(t.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
                <span className={`pc-mt__badge${over ? ' pc-mt__badge--on' : ''}`}>{over ? 'override' : 'default'}</span>
                {over && (
                  <button type="button" className="pc-mt__reset" onClick={() => resetTier(t.name)} disabled={busy} aria-label={`Reset ${t.name} to default`}>
                    ↺
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {overriding && (
        <button type="button" className="pc-queen__chip" onClick={() => onWrite(null)} disabled={busy}>
          reset all to workspace default
        </button>
      )}
      <ModelTiersStyles />
    </section>
  );
}

function ModelTiersStyles() {
  return (
    <style>{`
      .pc-mt { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-mt__row {
        display: flex; align-items: center; gap: 6px; padding: 4px 7px; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02);
      }
      .pc-mt__row--on { border-color: rgba(99, 102, 241, 0.45); background: rgba(99, 102, 241, 0.08); }
      .pc-mt__name {
        flex-shrink: 0; width: 58px; font-size: 10.5px; font-weight: 700; color: var(--fg, #e7f7ff);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .pc-mt__spec {
        flex: 1; min-width: 0; font: inherit; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 3px 6px; border-radius: 5px; color: var(--fg, #e7f7ff);
        background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.28));
      }
      .pc-mt__spec:focus { outline: none; border-color: rgba(99, 102, 241, 0.6); }
      .pc-mt__spec:disabled { opacity: 0.6; }
      .pc-mt__badge {
        flex-shrink: 0; font-size: 8px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 1px 5px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
      }
      .pc-mt__badge--on { color: #c7d2fe; border-color: rgba(99, 102, 241, 0.5); background: rgba(99, 102, 241, 0.14); }
      .pc-mt__reset {
        flex-shrink: 0; font-size: 12px; line-height: 1; padding: 2px 5px; border-radius: 5px; cursor: pointer;
        color: var(--fg-dim, #b9d4e8); background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22));
      }
      .pc-mt__reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
    `}</style>
  );
}

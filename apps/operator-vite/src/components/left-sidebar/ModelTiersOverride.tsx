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
 * Reads the workspace baseline from `agentConfig.modelTiersBaseline`; the
 * session override arrives via the `hive.steering` row (`modelTiers`); writes
 * via the parent's `onWrite` (→ `pot:set-steering { modelTiers }`).
 */
import { useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import OverridableSetting from '../override/OverridableSetting';
// type-only (erased at build): a VALUE import of operator-core constants doesn't
// resolve in the operator-vite vitest env, so the workspace-default tiers come
// from the sync resolver instead of a client import.
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
  const baselineQ = useSyncQuery<ModelTier>({ queryName: 'agentConfig.modelTiersBaseline', args: {}, staleTime: 60_000 });
  const baseline = baselineQ.data ?? [];
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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
                <OverridableSetting
                  label={t.name}
                  isOverridden={over}
                  onReset={() => resetTier(t.name)}
                  busy={busy}
                  badgeStyle="chip"
                >
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
                </OverridableSetting>
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
    </section>
  );
}

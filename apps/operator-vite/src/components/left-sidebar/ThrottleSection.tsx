/**
 * ThrottleSection — the 👑 Queen tab's throttle knobs
 * (queen-steering-panel-2026-06-15 P-007; backend contract P-006, su-41a5e).
 *
 * The owner's "how hard should the fleet run" levers, written through
 * `pot:set-steering` and read back from the `hive.steering` useSyncQuery — the
 * same session-override-over-default pattern as the eligibleHives / modelTiers
 * controls. Each knob is a SESSION override of a live operator seam (P-006 wires
 * the seams; this is the surface). null/default ⇒ "not overriding" → a "default"
 * badge; an explicit value ⇒ an "override" badge so the owner always sees which
 * knobs are live.
 *
 *  - Cadence floor — min seconds between Queen wakes. Effective = MAX(system, this):
 *    a FLOOR, so the owner can only SLOW the loop, never drop below the system min.
 *  - Max bees — concurrency ceiling. Effective = MIN(system ceiling, this).
 *  - Cap cups at tier — pins the `cup` role's model tier ceiling (tierCeilings.cup,
 *    a per-role CEILING — clamps bees down to at most that tier). The fine-grained
 *    per-tier model editor stays in the Model tiers section above.
 *  - Idle activities — gym / Scout / curation. Each defaults ON; unchecking gates
 *    that idle-mandate branch (suppresses its spend).
 *  - Auto scale-out — account-pool auto-scale-out on sustained exhaustion; default
 *    ON, unchecking disables it (manual accounts:scale_out still works).
 *
 * The system DEFAULTS for the badges (cadence 60s, max-bees = maxSimultaneousAgents)
 * arrive read-only on the `hive.steering` row as `throttleDefaults` (P-006), so the
 * UI never hardcodes them. The section's open/closed state lives in nuqs (`qThrottle`).
 */
import { useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { ChevronDown, ChevronRight, Cpu, Gauge, Moon, TrendingUp, Users } from 'lucide-react';
// type-only (erased at build): a VALUE import of operator-core constants doesn't
// resolve in the operator-vite vitest env — mirror ModelTiersOverride.
import type { ModelTier } from '@papercusp/operator-core/lib/agent-config-constants';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { useLexicon } from '@/lib/useLexicon';
import OverridableSetting from '../override/OverridableSetting';

/** The idle background activities the owner can gate (mirrors owner-steering.ts
 *  IDLE_ACTIVITY_KINDS — redeclared locally so this stays import-light in the
 *  vite/vitest env). */
export const IDLE_KINDS = ['gym', 'scout', 'curation'] as const;
export type IdleKind = (typeof IDLE_KINDS)[number];
export type IdleToggles = Partial<Record<IdleKind, boolean>>;
const IDLE_LABEL: Record<IdleKind, string> = { gym: 'Gym', scout: 'Scout', curation: 'Curation' };

/** The role the throttle UI pins via tierCeilings (the bulk fleet worker). */
export const PIN_ROLE = 'cup';
const CADENCE_PRESETS = [60, 120, 300, 600] as const;
const DEFAULT_SYSTEM_CADENCE_SEC = 60;

export interface ThrottleDefaults {
  cadenceFloorSec?: number | null;
  maxBees?: number | null;
  breakerThreshold?: number | null;
}

/** Whether an idle activity may run — default ON, only an explicit `false` gates it. Pure. */
export function idleEnabled(t: IdleToggles | null | undefined, kind: IdleKind): boolean {
  return !t || t[kind] !== false;
}

/** The effective wake-cadence floor: MAX(system floor, owner override). Pure. */
export function effectiveCadence(value: number | null, systemFloorSec: number): number {
  return Math.max(systemFloorSec, value ?? 0);
}

/** The effective concurrency ceiling: MIN(system ceiling, owner override); no
 *  override ⇒ the system ceiling (or the override alone when the system is unknown). Pure. */
export function effectiveMax(value: number | null, systemCeiling: number | null): number | null {
  if (value == null) return systemCeiling;
  return systemCeiling == null ? value : Math.min(systemCeiling, value);
}

/** Count of throttle knobs set away from their default — drives the header badge. Pure. */
export function throttleActiveCount(args: {
  cadenceFloorSec: number | null;
  maxBees: number | null;
  beeTier: string | null;
  idleActivities: IdleToggles | null;
  autoScaleOut: boolean | null;
}): number {
  let n = 0;
  if (args.cadenceFloorSec != null) n += 1;
  if (args.maxBees != null) n += 1;
  if (args.beeTier) n += 1;
  if (args.autoScaleOut === false) n += 1;
  n += IDLE_KINDS.filter((k) => args.idleActivities?.[k] === false).length;
  return n;
}

/** A number input with a mid-edit draft (useState — render-only, not URL state):
 *  commits on blur / Enter, an empty or invalid value CLEARS the override (null),
 *  matching the backend's fail-soft decode. */
function DraftNumberInput({
  value,
  ariaLabel,
  min,
  busy,
  onCommit,
}: {
  value: number | null;
  ariaLabel: string;
  min: number;
  busy: boolean;
  onCommit: (n: number | null) => void;
}) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  // Re-seed when the server value changes (e.g. another client / a clear).
  useEffect(() => {
    setDraft(value == null ? '' : String(value));
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') return onCommit(null);
    const n = Number(trimmed);
    onCommit(Number.isFinite(n) && n >= min ? Math.floor(n) : null);
  };
  return (
    <input
      type="number"
      min={min}
      className="pc-queen__num"
      value={draft}
      disabled={busy}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export default function ThrottleSection({
  cadenceFloorSec,
  maxBees,
  tierCeilings,
  idleActivities,
  autoScaleOut,
  defaults,
  busy,
  onSetCadenceFloor,
  onSetMaxBees,
  onSetBeeTierCap,
  onToggleIdle,
  onSetAutoScaleOut,
}: {
  cadenceFloorSec: number | null;
  maxBees: number | null;
  tierCeilings: Record<string, string> | null;
  idleActivities: IdleToggles | null;
  autoScaleOut: boolean | null;
  defaults: ThrottleDefaults | null | undefined;
  busy: boolean;
  onSetCadenceFloor: (sec: number | null) => void;
  onSetMaxBees: (n: number | null) => void;
  onSetBeeTierCap: (tierName: string | null) => void;
  onToggleIdle: (kind: IdleKind, enabled: boolean) => void;
  onSetAutoScaleOut: (enabled: boolean) => void;
}) {
  const t = useLexicon();
  const [open, setOpen] = useQueryState('qThrottle', parseAsBoolean.withDefault(true));
  const baselineQ = useSyncQuery<ModelTier>({ queryName: 'agentConfig.modelTiersBaseline', args: {}, staleTime: 60_000 });
  const tiers = baselineQ.data ?? [];

  const beeTier = tierCeilings?.[PIN_ROLE] ?? null;
  const sysCadence = defaults?.cadenceFloorSec ?? DEFAULT_SYSTEM_CADENCE_SEC;
  const sysMax = defaults?.maxBees ?? null;
  const activeCount = throttleActiveCount({ cadenceFloorSec, maxBees, beeTier, idleActivities, autoScaleOut });

  const cadenceEff = effectiveCadence(cadenceFloorSec, sysCadence);
  const maxEff = effectiveMax(maxBees, sysMax);

  return (
    <section className="pc-queen__section">
      <button
        type="button"
        className="pc-queen__collapse"
        onClick={() => void setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Collapse throttle' : 'Expand throttle'}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <Gauge size={12} aria-hidden />
        <span className="pc-queen__section-title">Throttle</span>
        <span className={`pc-queen__count${activeCount > 0 ? ' pc-queen__count--on' : ''}`}>
          {activeCount > 0 ? `${activeCount} active` : 'defaults'}
        </span>
      </button>

      {open && (
        <div className="pc-queen__knobs">
          {/* Wake-cadence floor */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <Gauge size={11} aria-hidden />
              <OverridableSetting label="Wake cadence floor" isOverridden={cadenceFloorSec != null} badgeStyle="inline" />
            </div>
            <div className="pc-queen__knobrow">
              <DraftNumberInput value={cadenceFloorSec} ariaLabel="Wake cadence floor (seconds)" min={1} busy={busy} onCommit={onSetCadenceFloor} />
              <span className="pc-queen__presetlabel">sec</span>
              {CADENCE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pc-queen__chip${cadenceFloorSec === p ? ' pc-queen__chip--on' : ''}`}
                  onClick={() => onSetCadenceFloor(p)}
                  disabled={busy}
                >
                  {p}s
                </button>
              ))}
              {cadenceFloorSec != null && (
                <button type="button" className="pc-queen__chip" onClick={() => onSetCadenceFloor(null)} disabled={busy}>clear</button>
              )}
            </div>
            <span className="pc-queen__hint">
              ≥ {cadenceEff}s between wakes{cadenceFloorSec != null && cadenceFloorSec < sysCadence ? ` (system min ${sysCadence}s)` : ''}
            </span>
          </div>

          {/* Concurrency ceiling */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <Users size={11} aria-hidden />
              <OverridableSetting label={`Max concurrent ${t('contributor', { plural: true, lower: true })}`} isOverridden={maxBees != null} badgeStyle="inline" />
            </div>
            <div className="pc-queen__knobrow">
              <DraftNumberInput value={maxBees} ariaLabel={`Max concurrent ${t('contributor', { plural: true, lower: true })}`} min={1} busy={busy} onCommit={onSetMaxBees} />
              <span className="pc-queen__presetlabel">{t('contributor', { plural: true, lower: true })}</span>
              {maxBees != null && (
                <button type="button" className="pc-queen__chip" onClick={() => onSetMaxBees(null)} disabled={busy}>clear</button>
              )}
            </div>
            <span className="pc-queen__hint">
              {sysMax != null
                ? `System ceiling ${sysMax}${maxBees != null ? ` · capped to ${maxEff}` : ''}`
                : maxBees != null
                  ? `Capped to ${maxBees} concurrent`
                  : 'Uses the system concurrency ceiling'}
            </span>
          </div>

          {/* Model-tier pin (cap the cup role's tier ceiling — tierCeilings.cup) */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <Cpu size={11} aria-hidden />
              <OverridableSetting label={`Cap ${t('contributor', { plural: true, lower: true })} at tier`} isOverridden={!!beeTier} badgeStyle="inline" />
            </div>
            <Select
              className="pc-queen__select"
              value={beeTier ?? '_none'}
              disabled={busy || tiers.length === 0}
              ariaLabel={`Cap ${t('contributor', { plural: true, lower: true })} at model tier`}
              onChange={(value) => onSetBeeTierCap(value === '_none' ? null : value)}
              options={[
                { value: '_none', label: 'No cap (any tier)' },
                ...tiers.map((tier) => ({ value: tier.name, label: `${tier.name} · ${tier.spec}` })),
              ]}
            />
            <span className="pc-queen__hint">A ceiling — {t('contributor', { plural: true, lower: true })} never run above this tier. Finer per-tier models: the Model tiers section above.</span>
          </div>

          {/* Idle activities */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <Moon size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Idle activities</span>
              <span className="pc-queen__count">when she has nothing to place</span>
            </div>
            <div className="pc-queen__toggles">
              {IDLE_KINDS.map((kind) => {
                const on = idleEnabled(idleActivities, kind);
                // 'scout' pack-routes to the active cast word (classic → "Blender").
                const label = kind === 'scout' ? t('scout') : IDLE_LABEL[kind];
                return (
                  <label key={kind} className={`pc-queen__toggle${on ? '' : ' pc-queen__toggle--off'}`}>
                    <Checkbox className="pc-queen__check" checked={on} disabled={busy} ariaLabel={`${label} idle activity`} onChange={(c) => onToggleIdle(kind, c)} />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
            <span className="pc-queen__hint">On by default — uncheck to stop that idle spend.</span>
          </div>

          {/* Auto scale-out */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <TrendingUp size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Auto scale-out</span>
              <span className={`pc-queen__knobbadge${autoScaleOut === false ? ' pc-queen__knobbadge--on' : ''}`}>
                {autoScaleOut === false ? 'disabled' : 'default'}
              </span>
            </div>
            <label className="pc-queen__toggle">
              <Checkbox className="pc-queen__check" checked={autoScaleOut !== false} disabled={busy} ariaLabel="Auto scale-out the account pool" onChange={(c) => onSetAutoScaleOut(c)} />
              <span>Auto-add accounts on sustained exhaustion</span>
            </label>
            <span className="pc-queen__hint">On by default. Off ⇒ no automatic account-pool growth (manual scale-out still works).</span>
          </div>
        </div>
      )}
    </section>
  );
}

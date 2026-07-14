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
import { Check, ChevronDown, ChevronRight, Cpu, Gauge, Moon, RotateCcw, TrendingUp, Users, X } from 'lucide-react';
// type-only (erased at build): a VALUE import of operator-core constants doesn't
// resolve in the operator-vite vitest env — mirror ModelTiersOverride.
import type { ModelTier } from '@papercusp/operator-core/lib/agent-config-constants';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

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

/** A number input with an EXPLICIT apply/discard draft (mirrors ModelTiersOverride's
 *  editor, WI-3788): typing never auto-saves — blur does nothing. A dirty draft
 *  shows cyan Apply/Discard actions; Enter applies (when valid), Escape discards.
 *  An empty draft is a valid "clear the override" (⇒ null on Apply); a non-numeric
 *  or below-`min` draft is INVALID — Apply is disabled and nothing is written,
 *  replacing the old silent-reset-to-null-on-blur behavior. */
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
  const saved = value == null ? '' : String(value);
  const [draft, setDraft] = useState(saved);
  // Re-seed when the server value changes (e.g. another client / a reset) and we
  // have no pending edit of our own.
  useEffect(() => {
    setDraft(saved);
  }, [saved]);
  const dirty = draft !== saved;
  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const invalid = dirty && trimmed !== '' && !(Number.isFinite(parsed) && (parsed as number) >= min);
  const commit = () => {
    if (invalid) return;
    onCommit(trimmed === '' ? null : Math.floor(parsed as number));
    // Don't snapshot the new value locally — fall through to the `saved`/effect
    // sync above once the parent's optimistic overlay reflects it in `value`,
    // same as ModelTiersOverride's drafts-map-delete-on-commit pattern.
  };
  const discard = () => setDraft(saved);
  return (
    <span className="pc-queen__draftnum">
      <input
        type="number"
        min={min}
        className={`pc-queen__num${dirty ? ' pc-queen__num--dirty' : ''}${invalid ? ' pc-queen__num--invalid' : ''}`}
        value={draft}
        disabled={busy}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty && !invalid) {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape' && dirty) {
            e.preventDefault();
            discard();
          }
        }}
      />
      {dirty && (
        <span className="pc-mt__actions">
          <Tooltip label={`Apply ${ariaLabel} change`}>
            <button
              type="button"
              className="pc-mt__action pc-mt__action--apply"
              onClick={commit}
              disabled={busy || invalid}
              aria-label={`Apply ${ariaLabel} change`}
            >
              <Check size={12} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip label={`Discard ${ariaLabel} change`}>
            <button
              type="button"
              className="pc-mt__action pc-mt__action--discard"
              onClick={discard}
              disabled={busy}
              aria-label={`Discard ${ariaLabel} change`}
            >
              <X size={12} aria-hidden />
            </button>
          </Tooltip>
        </span>
      )}
    </span>
  );
}

/** Display cadence as the unit people choose in this panel instead of exposing
 * the backend's raw seconds. Keeps non-minute system floors intelligible. */
export function formatCadence(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(1))} min`;
}

/** Minute-facing editor for the seconds-based steering seam — same explicit
 *  apply/discard draft as DraftNumberInput (WI-3788): blur never auto-saves, an
 *  invalid draft blocks Apply instead of silently resetting to null. */
function DraftMinutesInput({
  valueSec,
  busy,
  onCommit,
}: {
  valueSec: number | null;
  busy: boolean;
  onCommit: (seconds: number | null) => void;
}) {
  const saved = valueSec == null ? '' : String(valueSec / 60);
  const [draft, setDraft] = useState(saved);
  useEffect(() => {
    setDraft(saved);
  }, [saved]);
  const dirty = draft !== saved;
  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const invalid = dirty && trimmed !== '' && !(Number.isFinite(parsed) && (parsed as number) >= 1);
  const commit = () => {
    if (invalid) return;
    onCommit(trimmed === '' ? null : Math.round((parsed as number) * 60));
    // See DraftNumberInput's commit(): no local snapshot — the effect above
    // re-syncs `draft` once the parent's optimistic overlay updates `valueSec`.
  };
  const discard = () => setDraft(saved);
  return (
    <span className="pc-queen__draftnum">
      <input
        type="number"
        min={1}
        step={0.5}
        className={`pc-queen__num pc-queen__num--minutes${dirty ? ' pc-queen__num--dirty' : ''}${invalid ? ' pc-queen__num--invalid' : ''}`}
        value={draft}
        disabled={busy}
        aria-label="Custom time between wakes in minutes"
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty && !invalid) {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape' && dirty) {
            e.preventDefault();
            discard();
          }
        }}
      />
      {dirty && (
        <span className="pc-mt__actions">
          <Tooltip label="Apply custom wake timing">
            <button
              type="button"
              className="pc-mt__action pc-mt__action--apply"
              onClick={commit}
              disabled={busy || invalid}
              aria-label="Apply custom wake timing"
            >
              <Check size={12} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip label="Discard custom wake timing change">
            <button
              type="button"
              className="pc-mt__action pc-mt__action--discard"
              onClick={discard}
              disabled={busy}
              aria-label="Discard custom wake timing change"
            >
              <X size={12} aria-hidden />
            </button>
          </Tooltip>
        </span>
      )}
    </span>
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
  const [open, setOpen] = useQueryState('qThrottle', parseAsBoolean.withDefault(false));
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
        aria-label={open ? 'Collapse limits' : 'Expand limits'}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <Gauge size={12} aria-hidden />
        <span className="pc-queen__section-title">Limits</span>
        <span className={`pc-queen__count${activeCount > 0 ? ' pc-queen__count--on' : ''}`}>
          {activeCount > 0 ? `${activeCount} custom` : 'Workspace'}
        </span>
      </button>

      {open && (
        <div className="pc-queen__knobs">
          {/* Wake-cadence floor */}
          <div className={`pc-queen__knob${cadenceFloorSec != null ? ' pc-queen__knob--custom' : ''}`}>
            <div className="pc-queen__knobhead">
              <Gauge size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Time between wakes</span>
              {cadenceFloorSec != null && (
                <Tooltip label="Use workspace timing">
                  <button type="button" className="pc-queen__knobreset" onClick={() => onSetCadenceFloor(null)} disabled={busy} aria-label="Use workspace wake timing">
                    <RotateCcw size={11} aria-hidden />
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="pc-queen__presetrow" role="group" aria-label="Time between wake presets">
              {CADENCE_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pc-queen__chip${cadenceFloorSec === p ? ' pc-queen__chip--on' : ''}`}
                  onClick={() => onSetCadenceFloor(p)}
                  disabled={busy}
                  aria-pressed={cadenceFloorSec === p}
                >
                  {formatCadence(p)}
                </button>
              ))}
            </div>
            <label className="pc-queen__custom-number">
              <span>Custom</span>
              <DraftMinutesInput valueSec={cadenceFloorSec} busy={busy} onCommit={onSetCadenceFloor} />
              <span>min</span>
            </label>
            <span className="pc-queen__hint">
              At least {formatCadence(cadenceEff)} between wakes{cadenceFloorSec != null && cadenceFloorSec < sysCadence ? ` · workspace minimum ${formatCadence(sysCadence)}` : ''}
            </span>
          </div>

          {/* Concurrency ceiling */}
          <div className={`pc-queen__knob${maxBees != null ? ' pc-queen__knob--custom' : ''}`}>
            <div className="pc-queen__knobhead">
              <Users size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Concurrent {t('contributor', { plural: true, lower: true })}</span>
              {maxBees != null && (
                <Tooltip label="Use workspace concurrency">
                  <button type="button" className="pc-queen__knobreset" onClick={() => onSetMaxBees(null)} disabled={busy} aria-label="Use workspace concurrency">
                    <RotateCcw size={11} aria-hidden />
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="pc-queen__knobrow">
              <DraftNumberInput value={maxBees} ariaLabel={`Max concurrent ${t('contributor', { plural: true, lower: true })}`} min={1} busy={busy} onCommit={onSetMaxBees} />
              <span className="pc-queen__presetlabel">{t('contributor', { plural: true, lower: true })}</span>
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
          <div className={`pc-queen__knob${beeTier ? ' pc-queen__knob--custom' : ''}`}>
            <div className="pc-queen__knobhead">
              <Cpu size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Highest {t('contributor', { lower: true })} tier</span>
              {beeTier && (
                <Tooltip label="Use workspace tier limit">
                  <button type="button" className="pc-queen__knobreset" onClick={() => onSetBeeTierCap(null)} disabled={busy} aria-label="Use workspace tier limit">
                    <RotateCcw size={11} aria-hidden />
                  </button>
                </Tooltip>
              )}
            </div>
            <Select
              className="pc-queen__select"
              value={beeTier ?? '_none'}
              disabled={busy || tiers.length === 0}
              ariaLabel={`Cap ${t('contributor', { plural: true, lower: true })} at model tier`}
              onChange={(value) => onSetBeeTierCap(value === '_none' ? null : value)}
              options={[
                { value: '_none', label: 'Any tier' },
                ...tiers.map((tier) => ({ value: tier.name, label: `${tier.name} · ${tier.spec}` })),
              ]}
            />
            <span className="pc-queen__hint">Workers never use a tier above this selection.</span>
          </div>

          {/* Idle activities */}
          <div className={`pc-queen__knob${IDLE_KINDS.some((kind) => !idleEnabled(idleActivities, kind)) ? ' pc-queen__knob--custom' : ''}`}>
            <div className="pc-queen__knobhead">
              <Moon size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Background work</span>
              <span className="pc-queen__count">when idle</span>
            </div>
            <div className="pc-queen__toggles">
              {IDLE_KINDS.map((kind) => {
                const on = idleEnabled(idleActivities, kind);
                // 'scout' pack-routes to the active cast word (classic → "Blender").
                const label = kind === 'scout' ? t('scout') : IDLE_LABEL[kind];
                return (
                  <label key={kind} className={`pc-queen__toggle${on ? '' : ' pc-queen__toggle--off'}`}>
                    <Checkbox className="pc-queen__switch" checked={on} disabled={busy} ariaLabel={`${label} idle activity`} onChange={(c) => onToggleIdle(kind, c)} />
                    <span>{label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Auto scale-out */}
          <div className={`pc-queen__knob${autoScaleOut === false ? ' pc-queen__knob--custom' : ''}`}>
            <div className="pc-queen__knobhead">
              <TrendingUp size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Grow account pool</span>
            </div>
            <label className="pc-queen__toggle pc-queen__toggle--row">
              <span>Add accounts when capacity runs out</span>
              <Checkbox className="pc-queen__switch" checked={autoScaleOut !== false} disabled={busy} ariaLabel="Auto scale-out the account pool" onChange={(c) => onSetAutoScaleOut(c)} />
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

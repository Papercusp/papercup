/**
 * AutonomySurfacing — the 👑 Queen tab's autonomy + decomposition surface
 * (queen-steering-panel-2026-06-15 P-009).
 *
 * P-009 is "mostly surfacing existing systems, not new policy":
 *  - Autonomy ceilings — a compact READ-THROUGH of the Queen autonomy policy
 *    (the `autonomy.policy` sync query, owned by /settings/autonomy /
 *    queen-autonomy-policy B-15) + the armed master-switch state + a deep link to
 *    the full owner control surface. Nothing is editable here — the ceilings/locks
 *    live on the dedicated page; this just tells the owner, from the Queen tab,
 *    what she may auto-decide.
 *  - Cursed-item breaker — READ-ONLY display of the live placement-watchdog breaker
 *    threshold (failed placements before a work-item is cursed; default 3,
 *    PAPERCUSP_POT_PLACEMENT_BREAKER). Arrives on the `hive.steering` row as
 *    `throttleDefaults.breakerThreshold` (P-006) so it's the live value, not a guess.
 *  - Decomposition aggressiveness — the one writable lever (serial ↔ parallel), an
 *    ADVISORY steering knob written through `pot:set-steering { decomposition }`
 *    (owner-steering `decomposition`, P-006); surfaced in the Queen wake brief so
 *    she splits work into more/fewer parallel lanes. No hard seam — guidance.
 *
 * The section's open/closed state lives in nuqs (`qAutonomy`).
 */
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { ChevronDown, ChevronRight, ExternalLink, GitBranch, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import OverridableSetting from '../override/OverridableSetting';

export const DECOMP_MODES = ['serial', 'balanced', 'parallel'] as const;
export type DecompMode = (typeof DECOMP_MODES)[number];
const DECOMP_LABEL: Record<DecompMode, string> = { serial: 'Serial', balanced: 'Balanced', parallel: 'Parallel' };
const DECOMP_HINT: Record<DecompMode, string> = {
  serial: 'One workstream at a time',
  balanced: 'A few workstreams at once',
  parallel: 'Use as much safe parallelism as possible',
};

/* Wire type for the `autonomy.policy` row — kept local per the client wire-type
 * decoupling convention (mirrors AutonomyPolicyView; only the fields we surface). */
interface PolicyRow {
  category: string;
  effectiveCeiling: string;
  locked: boolean;
  label: string;
}

const CEILING_SHORT: Record<string, string> = {
  'never-auto': 'none',
  trivial: 'trivial',
  low: 'low',
  moderate: 'mod',
  high: 'high',
  critical: 'crit',
};

/** Defensive: only rows that look like a decoded PolicyRow (a string ceiling) — a
 *  misconfigured/empty query never throws into the panel. Pure. */
export function policyRows(data: readonly unknown[] | null | undefined): PolicyRow[] {
  return (data ?? []).filter(
    (r): r is PolicyRow => !!r && typeof (r as PolicyRow).effectiveCeiling === 'string' && typeof (r as PolicyRow).category === 'string',
  );
}

/** Roll-up of the policy for the summary line. Pure. */
export function summarizePolicy(rows: readonly PolicyRow[]): { total: number; active: number; locked: number } {
  return {
    total: rows.length,
    active: rows.filter((r) => r.effectiveCeiling !== 'never-auto').length,
    locked: rows.filter((r) => r.locked).length,
  };
}

export default function AutonomySurfacing({
  decomposition,
  breakerThreshold,
  busy,
  onSetDecomposition,
  onManageAutonomy,
}: {
  decomposition: DecompMode | null;
  breakerThreshold: number | null;
  busy: boolean;
  onSetDecomposition: (mode: DecompMode | null) => void;
  onManageAutonomy: () => void;
}) {
  const [open, setOpen] = useQueryState('qAutonomy', parseAsBoolean.withDefault(false));
  const policyQ = useSyncQuery<PolicyRow>({ queryName: 'autonomy.policy', args: {}, staleTime: 30_000 });
  const armed = useFlag(FLAGS.MUG_AUTONOMY_ARMED);

  const rows = policyRows(policyQ.data);
  const { total, active, locked } = summarizePolicy(rows);
  const activeRows = rows.filter((r) => r.effectiveCeiling !== 'never-auto');
  const breaker = breakerThreshold ?? 3;

  return (
    <section className="pc-queen__section">
      <button
        type="button"
        className="pc-queen__collapse"
        onClick={() => void setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Collapse decision style' : 'Expand decision style'}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        {armed ? <ShieldAlert size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
        <span className="pc-queen__section-title">Decision style</span>
        <span className={`pc-queen__count${armed ? ' pc-queen__count--on' : ''}`}>{armed ? 'Autonomy on' : 'Manual'}</span>
      </button>

      {open && (
        <div className="pc-queen__knobs">
          {/* Autonomy ceilings — read-through to /settings/autonomy */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <span className="pc-queen__knoblabel">Autonomy</span>
              <span className="pc-queen__count">{armed ? `${active}/${total} enabled` : 'Off'}</span>
            </div>
            <div className={`pc-queen__scope${armed ? ' pc-queen__scope--restricted' : ''}`}>
              {policyQ.loading && rows.length === 0 ? (
                'Loading autonomy policy…'
              ) : !armed ? (
                <>Every decision requires you.</>
              ) : active > 0 ? (
                <><strong>{active}</strong> categories can run automatically · {locked} locked.</>
              ) : (
                <>Autonomy is on, but no categories can run automatically yet.</>
              )}
            </div>
            {armed && activeRows.length > 0 && (
              <ul className="pc-queen__catlist">
                {activeRows.slice(0, 8).map((r) => (
                  <li key={r.category} className="pc-queen__cat">
                    <span className="pc-queen__catlabel" title={r.category}>{r.label}</span>
                    <span className="pc-queen__catceil">{CEILING_SHORT[r.effectiveCeiling] ?? r.effectiveCeiling}</span>
                  </li>
                ))}
                {activeRows.length > 8 && <li className="pc-queen__cat pc-queen__cat--more">+{activeRows.length - 8} more</li>}
              </ul>
            )}
            <button type="button" className="pc-queen__chip" onClick={onManageAutonomy} disabled={busy}>
              <ExternalLink size={11} aria-hidden /> Autonomy settings
            </button>
          </div>

          {/* Cursed-item breaker (read-only) */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <span className="pc-queen__knoblabel">Retry limit</span>
              <span className="pc-queen__count">{breaker} failures</span>
            </div>
            <div className="pc-queen__scope">
              Stops placing an item after <strong>{breaker}</strong> failed attempts.
            </div>
          </div>

          {/* Decomposition aggressiveness (advisory, writable) */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <GitBranch size={11} aria-hidden />
              <OverridableSetting label="Parallelism" isOverridden={decomposition != null} badgeStyle="inline" />
            </div>
            <div className="pc-queen__seg" role="group" aria-label="Decomposition aggressiveness">
              <button
                type="button"
                className={`pc-queen__chip${decomposition == null ? ' pc-queen__chip--on' : ''}`}
                onClick={() => onSetDecomposition(null)}
                disabled={busy}
                aria-pressed={decomposition == null}
              >
                System
              </button>
              {DECOMP_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`pc-queen__chip${decomposition === m ? ' pc-queen__chip--on' : ''}`}
                  onClick={() => onSetDecomposition(m)}
                  disabled={busy}
                  aria-pressed={decomposition === m}
                >
                  {DECOMP_LABEL[m]}
                </button>
              ))}
            </div>
            <span className="pc-queen__hint">
              {decomposition != null ? DECOMP_HINT[decomposition] : 'Use the workspace setting'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

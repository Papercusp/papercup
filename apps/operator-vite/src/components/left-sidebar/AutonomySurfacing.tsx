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
 *    PAPERCUSP_HIVE_PLACEMENT_BREAKER). Arrives on the `hive.steering` row as
 *    `throttleDefaults.breakerThreshold` (P-006) so it's the live value, not a guess.
 *  - Decomposition aggressiveness — the one writable lever (serial ↔ parallel), an
 *    ADVISORY steering knob written through `hive:set-steering { decomposition }`
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

export const DECOMP_MODES = ['serial', 'balanced', 'parallel'] as const;
export type DecompMode = (typeof DECOMP_MODES)[number];
const DECOMP_LABEL: Record<DecompMode, string> = { serial: 'Serial', balanced: 'Balanced', parallel: 'Parallel' };
const DECOMP_HINT: Record<DecompMode, string> = {
  serial: 'one lane at a time — slow, cheap, low-collision',
  balanced: 'a few parallel lanes — the default cadence',
  parallel: 'max parallel lanes — fast, more spend + contention',
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
  const [open, setOpen] = useQueryState('qAutonomy', parseAsBoolean.withDefault(true));
  const policyQ = useSyncQuery<PolicyRow>({ queryName: 'autonomy.policy', args: {}, staleTime: 30_000 });
  const armed = useFlag(FLAGS.QUEEN_AUTONOMY_ARMED);

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
        aria-label={open ? 'Collapse autonomy and decomposition' : 'Expand autonomy and decomposition'}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        {armed ? <ShieldAlert size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />}
        <span className="pc-queen__section-title">Autonomy &amp; decomposition</span>
        <span className={`pc-queen__count${armed ? ' pc-queen__count--on' : ''}`}>{armed ? 'armed' : 'not armed'}</span>
      </button>

      {open && (
        <div className="pc-queen__knobs">
          {/* Autonomy ceilings — read-through to /settings/autonomy */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <span className="pc-queen__knoblabel">Autonomy ceilings</span>
              <span className="pc-queen__count">surfacing · read-only</span>
            </div>
            <div className={`pc-queen__scope${armed ? ' pc-queen__scope--restricted' : ''}`}>
              {policyQ.loading && rows.length === 0 ? (
                'Loading autonomy policy…'
              ) : !armed ? (
                <>Autonomy is <strong>disarmed</strong> — nothing auto-runs; every decision routes to you regardless of the ceilings below.</>
              ) : active > 0 ? (
                <><strong>{active}</strong> of {total} categories can auto-run · {locked} locked. She may auto-decide at each category&rsquo;s effective ceiling (reversible, not owner-only).</>
              ) : (
                <>Armed, but <strong>nothing auto-runs yet</strong> — no category has both a raised ceiling and an earned level. {locked} locked.</>
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
              <ExternalLink size={11} aria-hidden /> Manage autonomy policy
            </button>
          </div>

          {/* Cursed-item breaker (read-only) */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <span className="pc-queen__knoblabel">Cursed-item breaker</span>
              <span className="pc-queen__count">read-only</span>
            </div>
            <div className="pc-queen__scope">
              A work-item is <strong>cursed</strong> (dropped from the frontier) after <strong>{breaker}</strong> failed placements.
            </div>
            <span className="pc-queen__hint">System value (PAPERCUSP_HIVE_PLACEMENT_BREAKER, default 3). A reaper-reclaim of a still-alive bee no longer counts (F-FIX-038).</span>
          </div>

          {/* Decomposition aggressiveness (advisory, writable) */}
          <div className="pc-queen__knob">
            <div className="pc-queen__knobhead">
              <GitBranch size={11} aria-hidden />
              <span className="pc-queen__knoblabel">Decomposition</span>
              <span className={`pc-queen__knobbadge${decomposition != null ? ' pc-queen__knobbadge--on' : ''}`}>
                {decomposition != null ? 'override' : 'default'}
              </span>
            </div>
            <div className="pc-queen__seg" role="group" aria-label="Decomposition aggressiveness">
              <button
                type="button"
                className={`pc-queen__chip${decomposition == null ? ' pc-queen__chip--on' : ''}`}
                onClick={() => onSetDecomposition(null)}
                disabled={busy}
                aria-pressed={decomposition == null}
              >
                Default
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
              {decomposition != null ? DECOMP_HINT[decomposition] : 'Advisory — guides how aggressively she splits work into parallel lanes (surfaced in her wake brief).'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

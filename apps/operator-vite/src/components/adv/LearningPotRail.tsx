/**
 * LearningPotRail — the Learning tab's rail of pot chips
 * (plan learning-pot-scope-gate-2026-08-30, P-006).
 *
 * One chip per pot that DOES learning, sitting under the stage stepper:
 *
 *   [ papercusp   ◍ scout  ◍ gym  ◍ lanes 3/4   $12.40+ ]  [ acme  ◌ … ]
 *
 * WHY A SEPARATE FILE. Its sibling on the same stage row, LearningLoopControl,
 * scopes its own `pc-lloop__*` CSS the same way. Keeping the rail's markup and
 * styles together means P-007's popover and P-008's picker extend ONE file
 * rather than two distant regions of an 8k-line LearningTab.
 *
 * WHAT THIS FILE DOES NOT DECIDE. Every rule about what a chip MEANS lives in
 * learning-pot-rail.ts and is asserted in learning-pot-rail.test.ts — fail-open
 * scope, `null` scope being unknown rather than on, a segment reporting its own
 * arming rather than the effective outcome. This component only renders the
 * model it is handed; if a state looks wrong, the model is where it is decided.
 *
 * THE CHIP IS NOT A CONTROL YET. P-007 turns it into the trigger for the
 * per-pot popover. Until that lands it is deliberately inert rather than a
 * button that does nothing when clicked: the segment states are legible on the
 * chip itself, and the long-form reason for each is in its tooltip.
 */
import { useMemo } from "react";
import { useSyncQuery } from "@papercusp/sync";
import type { AutomationCatalog } from "@papercusp/operator-core/lib/automation/catalog";
import { Tooltip } from "@/app/harness/Tooltip";
import { potHomeLabel } from "@/lib/pot-label";
import { useLexicon } from "@/lib/useLexicon";
import {
  buildLearningPotRail,
  type LearningPotChip,
  type PotRailSegment,
  type PotSegmentState,
} from "./learning-pot-rail";

/**
 * The chip's own spend is a FLOOR, never a total — scout is gated per-pot but
 * armed workspace-wide, so no scout spend is attributable here (see the model's
 * header). The trailing `+` is the whole visual carrier of that caveat, so it
 * is rendered from `spendComplete` rather than hard-coded: if a later read ever
 * does make the number whole, the marker disappears on its own.
 */
function spendLabel(chip: LearningPotChip): string {
  return `$${chip.spentUsd.toFixed(2)}${chip.spendComplete ? "" : "+"}`;
}

/** Human word for a segment state, used in tooltips and assistive text. */
const STATE_WORD: Record<PotSegmentState, string> = {
  on: "on",
  off: "off",
  absent: "not set up",
  unknown: "unreadable",
};

function SegmentDot({
  label,
  segment,
  suffix,
}: {
  label: string;
  segment: PotRailSegment;
  suffix?: string;
}) {
  return (
    <Tooltip label={`${label} — ${segment.detail}`}>
      <span
        className="pc-potrail__seg"
        data-state={segment.state}
        // The visible text is "scout"/"gym"/"lanes 3/4"; the STATE is carried
        // only by the dot's colour, which a screen reader cannot see. The label
        // therefore restates it in words rather than leaving the row ambiguous.
        aria-label={`${label} ${STATE_WORD[segment.state]}${suffix ? ` (${suffix})` : ""}`}
      >
        <span className="pc-potrail__dot" aria-hidden />
        <span aria-hidden>{label}</span>
        {suffix ? (
          <span className="pc-potrail__segnum" aria-hidden>
            {suffix}
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}

export function LearningPotRailChip({ chip }: { chip: LearningPotChip }) {
  const master = chip.learning;
  const masterDetail =
    master === "unknown"
      ? "The per-pot learning switch could not be read, so these states are unconfirmed."
      : master === "off"
        ? "Learning is switched OFF for this pot. Each lane keeps what it armed, so switching the pot back on restores exactly that."
        : "Learning is switched ON for this pot; each segment below shows what that lane itself has armed.";

  return (
    <li className="pc-potrail__chip" data-learning={master}>
      <Tooltip label={masterDetail}>
        <span className="pc-potrail__name">
          <span className="pc-potrail__master" aria-hidden />
          {potHomeLabel(chip.potSlug)}
          <span className="pc-potrail__sr">{` learning ${STATE_WORD[master]}`}</span>
        </span>
      </Tooltip>
      <SegmentDot label="scout" segment={chip.scout} />
      <SegmentDot label="gym" segment={chip.gym} />
      <SegmentDot
        label="lanes"
        segment={chip.lanes}
        suffix={chip.lanes.total > 0 ? `${chip.lanes.armed}/${chip.lanes.total}` : undefined}
      />
      <Tooltip
        label={
          chip.spendComplete
            ? "Learning spend attributed to this pot."
            : "Gym + governor-lane spend for this pot. Scout is excluded — it is gated per-pot but armed workspace-wide, so no per-pot scout spend exists to add. The real total is at least this much."
        }
      >
        <span className="pc-potrail__spend">{spendLabel(chip)}</span>
      </Tooltip>
    </li>
  );
}

export default function LearningPotRail() {
  const t = useLexicon();
  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: "automation.catalog",
    args: {},
    staleTime: 15_000,
  });
  const arming = catalogQuery.data?.[0]?.arming ?? null;
  const chips = useMemo(() => buildLearningPotRail(arming), [arming]);

  // No chips is the honest empty: either nothing has learned yet or the catalog
  // has not arrived. A placeholder row would push the whole stepper down for a
  // rail with nothing in it, so the rail simply is not there.
  if (chips.length === 0) return null;

  return (
    <ul
      className="pc-potrail"
      aria-label={`${t("pot", { plural: true })} that are learning`}
    >
      {chips.map((chip) => (
        <LearningPotRailChip key={chip.potSlug} chip={chip} />
      ))}

      <style>{`
        .pc-potrail {
          display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
          margin: 0; padding: 0; list-style: none;
        }
        .pc-potrail__chip {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 3px 9px; border: 1px solid var(--border); border-radius: 999px;
          background: var(--bg-1); color: var(--fg-dim);
          font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap;
        }
        /* A pot switched off stays on the rail — it is the surface that switches
           it back on (P-007) — but reads as dormant, the same dashed + faded
           vocabulary the paused stepper uses. */
        .pc-potrail__chip[data-learning="off"] { opacity: .62; border-style: dashed; }
        .pc-potrail__chip[data-learning="unknown"] { border-color: var(--warn-border); }
        .pc-potrail__name {
          display: inline-flex; align-items: center; gap: 5px;
          color: var(--fg); font-weight: 500;
        }
        .pc-potrail__master {
          width: 7px; height: 7px; border-radius: 50%; background: var(--good);
        }
        .pc-potrail__chip[data-learning="off"] .pc-potrail__master { background: var(--fg-mute); }
        .pc-potrail__chip[data-learning="unknown"] .pc-potrail__master { background: var(--warn); }
        .pc-potrail__seg { display: inline-flex; align-items: center; gap: 4px; }
        .pc-potrail__dot {
          width: 5px; height: 5px; border-radius: 50%; background: var(--good);
        }
        /* 'absent' is a hollow ring, not a dim fill: never configured has to look
           different from switched off, or someone goes hunting for a switch that
           does not exist. */
        .pc-potrail__seg[data-state="off"] .pc-potrail__dot { background: var(--fg-mute); }
        .pc-potrail__seg[data-state="absent"] .pc-potrail__dot {
          background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong);
        }
        .pc-potrail__seg[data-state="unknown"] .pc-potrail__dot { background: var(--warn); }
        .pc-potrail__seg[data-state="off"],
        .pc-potrail__seg[data-state="absent"] { color: var(--fg-mute); }
        .pc-potrail__segnum { color: var(--fg-mute); }
        .pc-potrail__spend { color: var(--fg); font-weight: 500; }
        .pc-potrail__sr {
          position: absolute; width: 1px; height: 1px; margin: -1px;
          padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
        }
        @container learning (max-width: 640px) {
          .pc-potrail { flex-wrap: nowrap; overflow-x: auto; }
        }
      `}</style>
    </ul>
  );
}

/**
 * LearningPotRail — the Learning tab's rail of pot chips
 * (plan learning-pot-scope-gate-2026-08-30, P-006).
 *
 * One chip per pot that is ACTUALLY learning, sitting under the stage stepper:
 *
 *   [ papercusp  ◍ scout ◍ gym ◍ lanes 3/4  $12.40+ ]  [ acme … ]  [ +47 idle ]
 *
 * "Only pots that are learning" is decided in the model, not here, and it is
 * narrower than mere presence — see `isPotChipDormant`. The live workspace has
 * 54 pots with a learning setup and 7 with anything armed, so the tail is
 * summarised in one chip rather than rendered as 47 more.
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
import { useCallback, useMemo, useState } from "react";
import { Shield, ShieldOff } from "lucide-react";
import { useSyncQuery } from "@papercusp/sync";
import type {
  AutomationArming,
  AutomationCatalog,
} from "@papercusp/operator-core/lib/automation/catalog";
import { Popover } from "@/app/harness/Popover";
import { useOpenPotDrawer } from "./LearningPotDrawer";
import { Tooltip } from "@/app/harness/Tooltip";
import { potHomeLabel } from "@/lib/pot-label";
import { useLexicon } from "@/lib/useLexicon";
import { runAgentTool } from "./run-tool";
import { useOpenPotPicker } from "./LearningPotPicker";
import {
  buildLearningPotRail,
  partitionLearningPotRail,
  potArmingDetail,
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

/**
 * One arm/disarm switch. The glyph shows the ACTION THE CLICK PERFORMS, never
 * the current state — the row's own tint carries state. That is the same
 * contract (and the same shield vocabulary) as the Arming pane's
 * `TransportToggle`, deliberately mirrored rather than imported: that control
 * is module-private to AutomationPane and its looks come from a `pc-auto__*`
 * style block embedded in that pane, so lifting it means disentangling those
 * styles from a large `<style>` element. The stage row's own convention — which
 * LearningLoopControl follows with `pc-lloop__*` — is to scope its CSS locally,
 * so this matches the vocabulary without forking the styling.
 */
function ArmSwitch({
  on,
  busy,
  disabled,
  label,
  onClick,
}: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="pc-potrail__arm"
      data-on={on ? "1" : "0"}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
    >
      {busy ? (
        <span className="pc-potrail__spinner" aria-hidden />
      ) : on ? (
        <ShieldOff size={12} aria-hidden />
      ) : (
        <Shield size={12} aria-hidden />
      )}
    </button>
  );
}

/**
 * The per-pot popover (P-007): master switch FIRST, per-lane switches under it.
 *
 * THE ORDER IS THE POINT. The master switch is ANDed with every lane below it,
 * so reading the panel top-to-bottom reads the actual logic. Putting a lane
 * first would invite "the gym says armed, so the gym is running", which is
 * false whenever the pot is switched off.
 *
 * WHY THE LANE SWITCHES STAY LIVE WHILE THE POT IS OFF. A lane's arming is its
 * OWN state, never the effective outcome (model header, rule 3) — that is what
 * makes switching a pot back on restore exactly what was armed. So a lane can
 * be armed or disarmed while the pot is off; it simply will not run until the
 * pot switch is back on, which the panel says in words rather than by disabling
 * controls and leaving the user to guess why.
 *
 * WHY SCOUT HAS NO SWITCH. Scout is gated per-pot but ARMED workspace-wide by
 * the scout ceiling — there is no per-pot scout arming to write. A switch here
 * would be a control that silently does something else (or nothing), so the row
 * states the relationship instead. The workspace ceiling is a different surface.
 */
function PotPopoverBody({
  chip,
  arming,
  onWrote,
}: {
  chip: LearningPotChip;
  arming: AutomationArming | null;
  onWrote: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const detail = useMemo(
    () => potArmingDetail(arming, chip.potSlug),
    [arming, chip.potSlug],
  );

  const run = useCallback(
    async (key: string, name: string, args: Record<string, unknown>) => {
      setBusy(key);
      setErr(null);
      try {
        await runAgentTool(name, args);
        onWrote();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [onWrote],
  );

  const master = chip.learning;
  const anyBusy = busy !== null;
  const potLabel = potHomeLabel(chip.potSlug);
  const openFields = useOpenPotDrawer();

  return (
    <div className="pc-potrail__pop">
      <div className="pc-potrail__pophead">{potLabel}</div>

      {/* MASTER SWITCH — first, because everything under it is ANDed with it. */}
      <div className="pc-potrail__poprow" data-master="1">
        <span className="pc-potrail__popname">Learning</span>
        {master === "unknown" ? (
          // An unreadable scope cannot be shown as a two-state switch without
          // asserting a position we did not read. But the WRITE is still
          // well-defined, so offer both explicit actions rather than disabling
          // the control — disabling would make a failed read unrecoverable from
          // the only surface that can fix it.
          <span className="pc-potrail__popfix">
            <button
              type="button"
              className="pc-potrail__poptext"
              disabled={anyBusy}
              onClick={() =>
                void run("master", "learning:set-pot-scope", {
                  pots: [chip.potSlug],
                  enabled: true,
                })
              }
            >
              Switch on
            </button>
            <button
              type="button"
              className="pc-potrail__poptext"
              disabled={anyBusy}
              onClick={() =>
                void run("master", "learning:set-pot-scope", {
                  pots: [chip.potSlug],
                  enabled: false,
                })
              }
            >
              Switch off
            </button>
          </span>
        ) : (
          <ArmSwitch
            on={master === "on"}
            busy={busy === "master"}
            disabled={anyBusy}
            label={`${master === "on" ? "Switch off" : "Switch on"} learning for ${potLabel}`}
            onClick={() =>
              void run("master", "learning:set-pot-scope", {
                pots: [chip.potSlug],
                enabled: master !== "on",
              })
            }
          />
        )}
      </div>

      <p className="pc-potrail__popnote">
        {master === "unknown"
          ? "The pot switch could not be read, so the lanes below are unconfirmed. Setting it explicitly will resolve it."
          : master === "off"
            ? "Learning is off for this pot, so nothing below runs. Each lane keeps its own arming — switching the pot back on restores exactly this."
            : "Each lane below shows what it has armed. The effective answer is this switch AND the lane's own."}
      </p>

      {/* Scout: stated, never a switch — see this component's header. */}
      <div className="pc-potrail__poprow" data-quiet="1">
        <span className="pc-potrail__popname">Scout</span>
        <span className="pc-potrail__popmeta">follows the pot switch</span>
      </div>

      {detail.gym ? (
        <div className="pc-potrail__poprow">
          <span className="pc-potrail__popname">Gym</span>
          <span className="pc-potrail__popmeta">{detail.gym.status}</span>
          <ArmSwitch
            on={detail.gym.enabled}
            busy={busy === "gym"}
            disabled={anyBusy}
            label={`${detail.gym.enabled ? "Disarm" : "Arm"} the gym autoloop for ${potLabel}`}
            onClick={() =>
              void run("gym", "gym:arm", {
                harness: chip.potSlug,
                enabled: !detail.gym!.enabled,
              })
            }
          />
        </div>
      ) : (
        <div className="pc-potrail__poprow" data-quiet="1">
          <span className="pc-potrail__popname">Gym</span>
          <span className="pc-potrail__popmeta">not set up</span>
        </div>
      )}

      {detail.lanes.map((lane) => (
        <div className="pc-potrail__poprow" key={lane.loopId}>
          <span className="pc-potrail__popname" title={lane.loopId}>
            {lane.displayName || lane.loopId}
          </span>
          <span className="pc-potrail__popmeta">{lane.enforcement}</span>
          <ArmSwitch
            on={lane.enabled}
            busy={busy === `lane/${lane.loopId}`}
            disabled={anyBusy}
            label={`${lane.enabled ? "Disarm" : "Arm"} ${lane.displayName || lane.loopId}`}
            onClick={() =>
              void run(`lane/${lane.loopId}`, "governor:arm", {
                loopId: lane.loopId,
                enabled: !lane.enabled,
              })
            }
          />
        </div>
      ))}

      {detail.lanes.length === 0 ? (
        <div className="pc-potrail__poprow" data-quiet="1">
          <span className="pc-potrail__popname">Governor lanes</span>
          <span className="pc-potrail__popmeta">none for this pot</span>
        </div>
      ) : null}

      {err ? (
        <p className="pc-potrail__poperr" role="alert">
          {err}
        </p>
      ) : null}

      {/* P-012. This popover is the QUICK panel — arm/disarm and nothing else.
          Budgets, units and enforcement are fields, and fields need room, so
          they live in the drawer. The link matters beyond convenience: the
          drawer is reachable by SLUG from the picker too, so a pot does not
          need a chip to reach these controls — which is the dependency D-008
          needs broken before the rail can bury its switched-off pots. */}
      <button
        type="button"
        className="pc-potrail__popmore"
        onClick={() => openFields(chip.potSlug)}
      >
        All fields — budgets and enforcement →
      </button>
    </div>
  );
}

export function LearningPotRailChip({
  chip,
  arming,
  onWrote,
}: {
  chip: LearningPotChip;
  arming: AutomationArming | null;
  onWrote: () => void;
}) {
  const [open, setOpen] = useState(false);
  const master = chip.learning;
  const masterDetail =
    master === "unknown"
      ? "The per-pot learning switch could not be read, so these states are unconfirmed. Click to set it."
      : master === "off"
        ? "Learning is switched OFF for this pot. Each lane keeps what it armed, so switching the pot back on restores exactly that. Click to change."
        : "Learning is switched ON for this pot; each segment below shows what that lane itself has armed. Click to change.";

  return (
    <li className="pc-potrail__chip" data-learning={master}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="start"
        ariaLabel={`Learning controls for ${potHomeLabel(chip.potSlug)}`}
        contentClassName="pc-potrail__popwrap"
        trigger={
          /* NO aria-label on this button, deliberately. An aria-label would
             become the button's whole accessible name and SUPPRESS its
             content — silently discarding every SegmentDot's spelled-out
             state ("scout on", "gym off"), which exist because the dot's
             colour cannot be heard. Letting the content compose the name
             keeps all of it and still announces the pot and its state. */
          <button type="button" className="pc-potrail__trigger">
            <span className="pc-potrail__sr">{`Learning controls for `}</span>
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
          </button>
        }
      >
        <PotPopoverBody chip={chip} arming={arming} onWrote={onWrote} />
      </Popover>
    </li>
  );
}

export default function LearningPotRail() {
  const t = useLexicon();
  const openPicker = useOpenPotPicker();
  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: "automation.catalog",
    args: {},
    staleTime: 15_000,
  });
  const arming = catalogQuery.data?.[0]?.arming ?? null;
  const { active, dormant } = useMemo(
    () => partitionLearningPotRail(buildLearningPotRail(arming)),
    [arming],
  );

  // A write through the run-tool bridge changes state this query is the truth
  // of, and the bridge cannot know which query that is — so the caller
  // invalidates. Without this the popover would keep rendering the arming it
  // just changed, which reads as "the switch did nothing".
  const onWrote = useCallback(() => {
    catalogQuery.invalidate?.();
  }, [catalogQuery]);

  // Nothing to say is the honest empty: no pot is learning, or the catalog has
  // not arrived. A placeholder row would push the whole stepper down for a rail
  // with nothing in it, so the rail simply is not there.
  if (active.length === 0 && dormant.length === 0) return null;

  const many = dormant.length !== 1;
  const potWord = t("pot", { plural: many, lower: true });

  // ⚠ P-052 CHANGED WHO IS IN THIS BUCKET, SO THE COPY HAD TO CHANGE WITH IT.
  // It used to hold only configured-but-unarmed pots, and said so: "They are
  // not switched off; nothing is running for them." Making switched-OFF pots
  // dormant put the exact population that sentence denies into it — and after
  // the owner's 28-pot pause that is EVERY pot, so the one affordance
  // accounting for them would have described all 26 as merely idle and called
  // the deliberate decision incidental. A summary that miscounts is recoverable;
  // one that renames a decision is not. So the wording is derived from the real
  // composition rather than assumed.
  const offCount = dormant.filter((c) => c.learning === "off").length;
  const idleCount = dormant.length - offCount;
  const dormantWord =
    offCount === 0 ? "idle" : idleCount === 0 ? "off" : "quiet";
  const dormantParts: string[] = [];
  if (offCount > 0) dormantParts.push(`${offCount} switched off deliberately`);
  if (idleCount > 0) {
    dormantParts.push(
      `${idleCount} with a learning setup — a gym autoloop or governor lanes — and nothing armed`,
    );
  }
  // This rides on `aria-label` as well as the tooltip because the tooltip is a
  // Radix portal that exists only on hover: without it the accessible name of
  // the one control accounting for the entire hidden tail is the bare "+26
  // off". A pointer user gets the composition and a screen-reader user gets a
  // number — and it is the screen-reader user who cannot see the rail to infer
  // the rest.
  const dormantSummary = `${dormant.length} ${potWord} not learning right now: ${dormantParts.join(", and ")}. Nothing is running for ${many ? "them" : "it"}. Open the scope picker to see every ${t("pot", { lower: true })} — each row opens its own fields.`;

  return (
    <ul
      className="pc-potrail"
      aria-label={`${t("pot", { plural: true })} that are learning`}
    >
      {active.map((chip) => (
        <LearningPotRailChip
          key={chip.potSlug}
          chip={chip}
          arming={arming}
          onWrote={onWrote}
        />
      ))}

      {/* The dormant tail is ACCOUNTED FOR, not dropped — measured live, 47 of
          54 pots have a learning setup with nothing armed, and rendering them
          as chips buries the 7 that are actually running. P-008's picker is the
          every-pot surface this count hands off to. */}
      {dormant.length > 0 ? (
        <li className="pc-potrail__chip pc-potrail__chip--dormant">
          <Tooltip
            label={dormantSummary}
          >
            {/* P-008 made this live. D-005 designated this chip as the picker's
                trigger and left it deliberately inert until the picker existed
                — "wire it there rather than adding a second entry point" — so
                this chip is the ONE route to a dormant pot's controls. */}
            <button
              type="button"
              className="pc-potrail__dormant"
              aria-label={dormantSummary}
              onClick={openPicker}
            >
              {`+${dormant.length} ${dormantWord}`}
            </button>
          </Tooltip>
        </li>
      ) : null}

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
        /* A switched-off pot keeps its chip ONLY while something is still armed
           under it (P-052 made the fully-idle ones dormant) — that pot is still
           spending, so it reads as off with the same dashed + faded vocabulary
           the paused stepper uses, rather than disappearing. */
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
        .pc-potrail__chip--dormant { border-style: dashed; color: var(--fg-mute); }
        /* The idle chip is a real button now (P-008), so it needs the button
           reset — without it the UA stylesheet paints a grey box mid-rail. */
        .pc-potrail__dormant {
          background: none; border: none; padding: 0; margin: 0;
          font: inherit; color: inherit; cursor: pointer;
        }
        .pc-potrail__dormant:hover { color: var(--fg); }
        .pc-potrail__dormant:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 999px;
        }
        .pc-potrail__dormant { color: var(--fg-mute); }
        .pc-potrail__sr {
          position: absolute; width: 1px; height: 1px; margin: -1px;
          padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
        }

        /* The chip's whole body is the popover trigger (P-007). It resets the
           button chrome so the chip looks exactly as it did while inert — the
           pill border lives on the <li>, not here — and the affordance is the
           pointer + hover/focus lift rather than a second nested border. */
        .pc-potrail__trigger {
          all: unset;
          display: inline-flex; align-items: center; gap: 8px;
          cursor: pointer;
        }
        .pc-potrail__trigger:focus-visible {
          outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 999px;
        }
        .pc-potrail__chip:hover { border-color: var(--border-strong); }

        /* ── the per-pot popover ─────────────────────────────────────────── */
        /* The shared <Popover> primitive paints NO surface — it sets only
           zIndex on RP.Content and hands the caller contentClassName (the
           Tooltip beside it in harness/Popover.tsx sets its own background for
           exactly this reason). So the panel is TRANSPARENT until this rule
           exists, and every DOM assertion still passes while the page's text
           reads straight through it — which is how a screenshot caught this
           and four green structural checks did not. Surface values follow the
           house anchored-panel pattern (.pc-user-menu, globals.css). */
        .pc-potrail__popwrap {
          border: 1px solid var(--border-strong);
          border-radius: 12px;
          background: var(--bg-1);
          color: var(--fg);
          box-shadow:
            0 18px 46px rgba(0, 0, 0, 0.58),
            0 0 0 1px rgba(255, 255, 255, 0.045),
            inset 0 1px 0 rgba(255, 255, 255, 0.035);
          backdrop-filter: none;
        }
        .pc-potrail__pop { min-width: 244px; max-width: 320px; padding: 4px 2px; }
        .pc-potrail__pophead {
          padding: 2px 8px 6px; font-weight: 600; color: var(--fg); font-size: 12px;
        }
        .pc-potrail__poprow {
          display: flex; align-items: center; gap: 8px;
          padding: 4px 8px; font-size: 11.5px; color: var(--fg-dim);
        }
        /* The master switch is visually separated from the lanes it governs —
           the panel's whole logic is "this AND that", so the two must not read
           as one flat list of equals. */
        .pc-potrail__poprow[data-master="1"] {
          color: var(--fg); font-weight: 500;
          border-bottom: 1px solid var(--border); padding-bottom: 6px;
        }
        .pc-potrail__poprow[data-quiet="1"] { color: var(--fg-mute); }
        .pc-potrail__popname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .pc-potrail__popmeta { color: var(--fg-mute); font-size: 10.5px; }
        .pc-potrail__popnote {
          margin: 6px 0; padding: 0 8px; font-size: 10.5px; line-height: 1.45;
          color: var(--fg-mute);
        }
        .pc-potrail__poperr {
          margin: 6px 0 2px; padding: 0 8px; font-size: 10.5px; color: var(--bad);
        }
        .pc-potrail__popmore {
          display: block; width: calc(100% - 16px); margin: 8px 8px 2px;
          padding: 5px 8px; font-size: 10.5px; text-align: left;
          border-radius: 8px; border: 1px solid var(--border);
          background: var(--bg-1); color: var(--accent); cursor: pointer;
        }
        .pc-potrail__popfix { display: inline-flex; gap: 6px; }
        .pc-potrail__poptext {
          all: unset; cursor: pointer; font-size: 10.5px; color: var(--accent);
        }
        .pc-potrail__poptext:disabled { cursor: default; color: var(--fg-mute); }
        .pc-potrail__arm {
          all: unset; cursor: pointer; display: inline-flex; align-items: center;
          justify-content: center; width: 22px; height: 20px; min-height: 20px; border-radius: 5px;
          color: var(--fg-mute);
        }
        .pc-potrail__arm[data-on="1"] { color: var(--good); }
        .pc-potrail__arm:hover:not(:disabled) { background: var(--bg-2); color: var(--fg); }
        .pc-potrail__arm:disabled { cursor: default; opacity: .5; }
        .pc-potrail__arm:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .pc-potrail__spinner {
          width: 10px; height: 10px; border-radius: 50%;
          border: 1.5px solid var(--border-strong); border-top-color: var(--fg);
          animation: pc-potrail-spin .7s linear infinite;
        }
        @keyframes pc-potrail-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .pc-potrail__spinner { animation: none; }
        }
        /* A narrow container gets ONE scrolling row rather than a stack of
           wrapped rows: this sits between the stage stepper and the view tabs,
           so growing vertically pushes the whole tab body down.
           The mask is the scroll AFFORDANCE, and it is honest without any
           overflow detection — it fades the element's last 22px, which is bare
           background when nothing overflows and a half-visible chip when
           something does. Verified 2026-08-30: at a 550px container the rail
           held 7 chips in a 25px row and clipped the second chip mid-word with
           no hint it continued. */
        @container learning (max-width: 640px) {
          .pc-potrail {
            flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;
            -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent);
            mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent);
          }
          .pc-potrail::-webkit-scrollbar { display: none; }
        }
      `}</style>
    </ul>
  );
}

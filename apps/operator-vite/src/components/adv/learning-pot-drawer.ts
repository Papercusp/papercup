/**
 * The per-pot learning drawer's model (learning-pot-scope-gate-2026-08-30, P-012).
 *
 * WHAT THIS SURFACE IS. The rail's popover (P-007) is a quick arm/disarm panel
 * hanging off a chip. This is the FULL per-pot control surface: the master
 * switch, then every lane the pot owns as a real field — armed state, budget
 * WITH ITS UNIT, who enforces it, what it has spent. D-005 routed a dormant
 * pot's controls through the picker; D-008 then measured that the picker
 * restores the GATE ONLY, so a switched-off pot's per-lane switches had nowhere
 * to live but the rail chip. That is why the rail cannot collapse (P-052) and
 * why this model exists.
 *
 * ⚠ THE CONSTRAINT THAT MADE THIS ITEM LOAD-BEARING. This drawer must be
 * reachable for a pot that has NO rail chip — i.e. from the every-pot picker.
 * `buildPotDrawer` therefore takes a pot SLUG and the raw arming, never a
 * `LearningPotChip`: depending on a chip would rebuild the exact dependency
 * D-008 recorded and leave P-052 blocked forever.
 *
 * THE SECTION MAP IS LOOP-ID FAMILIES, NOT ENGINES (D-009). P-012's text names
 * "Scout / Gym / Frontier / Blender", which reads as four independent engines.
 * Two of those readings are false and both were measured:
 *
 *   - `blender:` IS the scout registrant grain. `scoutLoopId(slug)` returns
 *     `blender:<slug>` and `SCOUT_LOOP_ID_PREFIX = 'blender:'`
 *     (learning-governor/core.ts:196-206), so a pot's scout cycle is armed and
 *     budgeted by its `blender:<pot>` row. The Scout section here is the
 *     WORKSPACE CEILING — a different layer, summed across every `blender:`
 *     registrant over 24h — and it says so, in both directions, rather than
 *     letting someone hunt for a per-pot scout switch that does not exist.
 *   - Four names do not cover the data. Measured over the live workspace,
 *     17 non-gym lanes: 6 `dream:`, 2 `frontier:`, 1 `blender:`, and EIGHT with
 *     no prefix at all. Four sections would drop 14 of 17 — and for 6 of the 28
 *     pots would drop every lane they have, rendering an empty drawer for a pot
 *     that is armed and spending. So there is a fifth section, and it is a
 *     PARTITION (like `partitionLearningPotRail`), never a filter.
 *
 * A BUDGET IS NEVER A BARE NUMBER. `budgetKind` is the UNIT, and it decides
 * whether "remaining" exists at all: `remainingLoopBudgetUsd` returns a
 * per-cycle budget UNCHANGED rather than `budget − spent` (core.ts:90-95),
 * because a per-cycle cap bounds ONE run while `spentUsd` accumulates forever.
 * Live proof this is not pedantry: `blender:papercusp` is a $5 per-cycle cap
 * carrying $513.82 of cumulative spend — subtracting would print
 * "−$508.82 remaining" for a lane that is perfectly healthy.
 *
 * NULLISH DISCIPLINE (D-006). Every field below is declared required and every
 * one crosses a sync CACHE boundary, where the type describes the current
 * server and not the bytes this client holds. Iterating `undefined` throws as
 * hard as a bad dereference, and that crash took out the whole Learning tab
 * once already (WI-1397883).
 */
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
  AutomationScoutCeiling,
} from '@papercusp/operator-core/lib/automation/catalog';

import { potArmingDetail, potMasterSwitch, type PotSegmentState } from './learning-pot-rail';

/**
 * Derived from the catalog type rather than re-declared, so a new budget kind
 * on the server is a compile error here instead of a silently unhandled unit.
 */
export type PotDrawerBudgetKind = AutomationLaneArm['budgetKind'];

export const POT_DRAWER_SECTION_IDS = ['scout', 'gym', 'frontier', 'blender', 'other'] as const;
export type PotDrawerSectionId = (typeof POT_DRAWER_SECTION_IDS)[number];

/**
 * Loop-id prefixes that own a NAMED section. Order matters only for
 * determinism; the prefixes are disjoint by construction (core.ts mints them).
 * Everything not listed here lands in `other` — see the module header for why
 * that is the majority case rather than a leftover bin.
 */
const NAMED_LANE_PREFIXES: ReadonlyArray<readonly [string, PotDrawerSectionId]> = [
  ['frontier:', 'frontier'],
  ['blender:', 'blender'],
];

/** Which section a lane belongs to. Total by construction: never returns undefined. */
export function laneSectionId(loopId: string): PotDrawerSectionId {
  for (const [prefix, id] of NAMED_LANE_PREFIXES) {
    if (loopId.startsWith(prefix)) return id;
  }
  return 'other';
}

export interface PotDrawerBudget {
  /** null = no budget set. For a governed lane that means the governor REFUSES it. */
  usd: number | null;
  /** null when the row has no budget kind of its own (the workspace ceiling). */
  kind: PotDrawerBudgetKind | null;
  /** The unit, spelled out. A bare number is never rendered by this surface. */
  unit: string;
  /** null = not attributable from this read. Never coerced to 0. */
  spentUsd: number | null;
  /** ONLY for 'lifetime' budgets — see the module header. */
  remainingUsd: number | null;
  /** Why `remainingUsd` is absent, when it is. null when it is present. */
  remainingNote: string | null;
}

/** The write that changes one field, named by the tool it actually calls. */
export type PotDrawerWrite =
  | { tool: 'gym:arm'; harness: string }
  | { tool: 'governor:arm'; loopId: string };

export interface PotDrawerField {
  /** Stable id for the write, the React key, and the test hook. */
  key: string;
  label: string;
  /** The exact slug / loopId the write is keyed by, so a row can be matched to its DB row. */
  ref: string | null;
  /** null = there is nothing armable at this row (the workspace ceiling). */
  armed: boolean | null;
  /** The raw enforcement token from the row. */
  enforcement: string;
  /** What that token MEANS, in words — the pane states it rather than implying it. */
  enforcementNote: string;
  budget: PotDrawerBudget;
  /** null ⇒ not writable from this surface; `readOnlyReason` then says why. */
  write: PotDrawerWrite | null;
  readOnlyReason: string | null;
  /** Free-text row status (the gym's `status`, a ceiling read failure). */
  status: string | null;
}

export interface PotDrawerSection {
  id: PotDrawerSectionId;
  title: string;
  /** One line: what this section is, and where its control lives if not here. */
  note: string;
  fields: PotDrawerField[];
  /** True when this pot has no rows here. Rendered as a STATED absence, never hidden. */
  empty: boolean;
}

export interface PotDrawerModel {
  potSlug: string;
  /** The per-pot master switch. 'unknown' when the scope read failed (D-006 rule 2). */
  learning: PotSegmentState;
  /** Always all five ids, in `POT_DRAWER_SECTION_IDS` order — absence is stated, not omitted. */
  sections: PotDrawerSection[];
  /** Governor lanes this pot owns. */
  laneCount: number;
  /**
   * Lanes actually placed in a section. Equal to `laneCount` by construction —
   * exported so the partition property is ASSERTABLE rather than assumed, which
   * is what stops a future `.filter()` from silently hiding a spending lane.
   */
  placedLaneCount: number;
}

function money(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function budgetUnit(kind: PotDrawerBudgetKind | null): string {
  if (kind === 'per-cycle') return 'USD per cycle';
  if (kind === 'lifetime') return 'USD lifetime';
  return 'USD';
}

/**
 * Budget + remaining for one governed row.
 *
 * The whole point is the `per-cycle` branch: `remainingLoopBudgetUsd` reports a
 * per-cycle row's cap UNCHANGED, so subtracting spend here would render a
 * healthy per-run cap as a lifetime overrun. This returns null and SAYS WHY
 * instead, because a blank cell reads as "we didn't bother", which invites the
 * next person to helpfully fill it in with the subtraction.
 */
export function drawerBudget(
  budgetUsd: number | null | undefined,
  kind: PotDrawerBudgetKind | null,
  spentUsd: number | null | undefined,
): PotDrawerBudget {
  const usd = money(budgetUsd);
  const spent = money(spentUsd);
  const lifetime = kind === 'lifetime';
  return {
    usd,
    kind,
    unit: budgetUnit(kind),
    spentUsd: spent,
    remainingUsd: lifetime && usd !== null ? usd - (spent ?? 0) : null,
    remainingNote:
      lifetime && usd !== null
        ? null
        : kind === 'per-cycle'
          ? 'A per-cycle cap bounds one run; spend accumulates past it, so there is no remaining balance'
          : 'No budget set — the governor refuses unattended spend until one is',
  };
}

function enforcementNote(enforcement: string): string {
  if (enforcement === 'native') {
    return "Native — the lane's own gate decides; the governor row mirrors it";
  }
  if (enforcement === 'governor') {
    return 'Governor — the learning-governor preflight gates every run';
  }
  return `Enforced by ${enforcement}`;
}

/**
 * The Scout section: the WORKSPACE ceiling, deliberately read-only here.
 *
 * `learning:set-scout-budget` writes one number for the whole workspace. Putting
 * that write on a PER-POT drawer would be a control that silently changes every
 * other pot — the same failure D-005/P-007 refused when it gave Scout no
 * per-pot switch. So the row states the value with its unit and names where the
 * per-pot control actually is (the `blender:` lane below).
 */
function scoutField(ceiling: AutomationScoutCeiling | null | undefined): PotDrawerField {
  const effective = money(ceiling?.effectiveUsd);
  return {
    key: 'scout-ceiling',
    label: 'Workspace scout ceiling',
    ref: null,
    armed: null,
    enforcement: 'native',
    enforcementNote:
      'Native — scout has no preflight; the ceiling is checked against 24h of ledgered spend',
    budget: {
      usd: effective,
      kind: null,
      unit: 'USD per 24h, workspace-wide',
      spentUsd: null,
      remainingUsd: null,
      remainingNote:
        'Measured across every pot in the workspace over a rolling 24h window, not against this pot',
    },
    write: null,
    readOnlyReason:
      "Scout is armed workspace-wide, so a switch here would change every pot. Set it with learning:set-scout-budget; this pot's own scout cycle is the blender: lane below.",
    status: ceiling == null ? 'Ceiling unreadable' : null,
  };
}

/** The Gym section's one field. Gym is `native`/`lifetime` per `gymRegistrationInput`. */
function gymField(potSlug: string, gym: AutomationGymArm): PotDrawerField {
  return {
    key: 'gym',
    label: 'Gym autoloop',
    ref: potSlug,
    armed: gym.enabled === true,
    enforcement: 'native',
    enforcementNote:
      "Native — the autoloop tick's own eligibility check IS the gate; the gym: governor row mirrors it",
    budget: drawerBudget(gym.budgetUsd, 'lifetime', gym.spentUsd),
    write: { tool: 'gym:arm', harness: potSlug },
    readOnlyReason: null,
    status: gym.status ?? null,
  };
}

function laneField(lane: AutomationLaneArm): PotDrawerField {
  const enforcement = lane.enforcement ?? 'governor';
  return {
    key: `lane/${lane.loopId}`,
    label: lane.displayName || lane.loopId,
    ref: lane.loopId,
    armed: lane.enabled === true,
    enforcement,
    enforcementNote: enforcementNote(enforcement),
    // budgetKind is read off the row, never inferred from the section: a
    // per-cycle row in the Frontier section is a real possibility and the unit
    // must follow the ROW, not the heading it happens to sit under.
    budget: drawerBudget(lane.budgetUsd, lane.budgetKind ?? 'lifetime', lane.spentUsd),
    write: { tool: 'governor:arm', loopId: lane.loopId },
    readOnlyReason: null,
    status: null,
  };
}

const SECTION_TITLE: Record<PotDrawerSectionId, string> = {
  scout: 'Scout',
  gym: 'Gym',
  frontier: 'Frontier',
  blender: 'Blender',
  other: 'Other lanes',
};

const SECTION_NOTE: Record<PotDrawerSectionId, string> = {
  scout:
    'Gated per-pot by the switch above, but armed and budgeted workspace-wide — so the number below is the ceiling for every pot, not this one.',
  gym: 'This pot’s gym autoloop. Its budget accumulates over the lane’s lifetime.',
  frontier: 'Frontier lanes (loop ids beginning frontier:), gated by the learning-governor preflight.',
  blender:
    'Loop ids beginning blender: — this prefix IS the scout-cadence registrant, so this is where this pot’s scout cycle is armed and budgeted. The Scout section above is the workspace ceiling that bounds every one of them.',
  other:
    'Every remaining lane for this pot, named individually. Most lanes carry no family prefix, so this is usually where they are — nothing is filtered out.',
};

const EMPTY_NOTE: Record<PotDrawerSectionId, string> = {
  scout: 'The workspace scout ceiling could not be read.',
  gym: 'No gym autoloop is configured for this pot — it has never been set up, which is not the same as switched off.',
  frontier: 'No frontier: lanes for this pot.',
  blender: 'No blender: lane for this pot — its scout cadence has never registered one.',
  other: 'No other lanes for this pot.',
};

/**
 * Build the drawer for ONE pot.
 *
 * Takes the pot SLUG, never a chip — see the module header. A pot with no rows
 * at all still gets a complete five-section model, because "this pot has no
 * gym" is an answer and an omitted section is not.
 */
export function buildPotDrawer(
  arming: AutomationArming | null | undefined,
  potSlug: string,
): PotDrawerModel {
  const learning = arming ? potMasterSwitch(arming, potSlug) : 'unknown';
  const detail = potArmingDetail(arming, potSlug);

  const bySection = new Map<PotDrawerSectionId, PotDrawerField[]>();
  for (const id of POT_DRAWER_SECTION_IDS) bySection.set(id, []);

  bySection.get('scout')!.push(scoutField(arming?.scoutCeiling));
  if (detail.gym) bySection.get('gym')!.push(gymField(potSlug, detail.gym));

  // PARTITION: every lane lands somewhere. `laneSectionId` is total, so this
  // loop cannot drop a row — which is the property `placedLaneCount` pins.
  for (const lane of detail.lanes) {
    bySection.get(laneSectionId(lane.loopId))!.push(laneField(lane));
  }

  const sections = POT_DRAWER_SECTION_IDS.map<PotDrawerSection>((id) => {
    const fields = bySection.get(id)!;
    // The scout row always exists; it is "empty" only when the ceiling is unreadable.
    const empty = id === 'scout' ? arming?.scoutCeiling == null : fields.length === 0;
    return {
      id,
      title: SECTION_TITLE[id],
      note: empty ? EMPTY_NOTE[id] : SECTION_NOTE[id],
      fields,
      empty,
    };
  });

  const placed = sections
    .filter((s) => s.id !== 'scout' && s.id !== 'gym')
    .reduce((n, s) => n + s.fields.length, 0);

  return {
    potSlug,
    learning,
    sections,
    laneCount: detail.lanes.length,
    placedLaneCount: placed,
  };
}

/** Format a budget for display: never a bare number — the unit always rides along. */
export function formatBudget(budget: PotDrawerBudget): string {
  if (budget.usd === null) return `none set (${budget.unit})`;
  return `${budget.usd.toFixed(2)} ${budget.unit}`;
}

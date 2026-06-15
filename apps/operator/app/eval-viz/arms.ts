/**
 * The locked benchmark-arm vocabulary (impartial-benchmark-suite-2026-06-15).
 *
 * These exact strings are the cross-brief contract (locked by BRIEF 7/P-011):
 * the run-result schema, the Evaluation surface (P-020), and these shared viz
 * components (P-021) all key arm → series/color on them. `papercusp` is the
 * treatment; the three `baseline-*` are the controls (A ablation, B native
 * harness — the headline, C best-of-N). See plan D-001/D-002.
 *
 * The viz props type `arm` as a plain `string` (not this union) on purpose —
 * unknown arms still render (neutral color), so a new arm never crashes the
 * chart and the canonical type can be owned/published by P-011 without a
 * type-ownership conflict here. This module just gives the KNOWN arms stable
 * labels + colors so both the gym and the evals surface look identical.
 */
export type ArmId =
  // L1 per-task arms (Phase 2)
  | 'papercusp'
  | 'baseline-a-ablation'
  | 'baseline-b-native'
  | 'baseline-c-bestofn'
  // L2–L5 fleet arms (Phase 5 / D-010 reframe). PROVISIONAL strings — confirm
  // against the fleet arm vocab locked by P-025/P-011 (su-4ac61) + P-023 (su-136a4).
  | 'hive'
  | 'queen-ablated'
  | 'native-serial'
  | 'openhands'
  | 'crewai'
  | 'langgraph';

export const ARM_IDS: readonly ArmId[] = [
  'papercusp',
  'baseline-a-ablation',
  'baseline-b-native',
  'baseline-c-bestofn',
  'hive',
  'queen-ablated',
  'native-serial',
  'openhands',
  'crewai',
  'langgraph',
] as const;

/** Short human label for an arm; falls back to the raw id for unknown arms. */
export function armLabel(arm: string): string {
  switch (arm) {
    case 'papercusp': return 'Papercusp';
    case 'baseline-a-ablation': return 'Baseline A · ablation';
    case 'baseline-b-native': return 'Baseline B · native';
    case 'baseline-c-bestofn': return 'Baseline C · best-of-N';
    // Fleet arms (Phase 5)
    case 'hive': return 'Hive';
    case 'queen-ablated': return 'Queen-ablated';
    case 'native-serial': return 'Native (serial)';
    case 'openhands': return 'OpenHands';
    case 'crewai': return 'CrewAI';
    case 'langgraph': return 'LangGraph';
    default: return arm;
  }
}

/**
 * Series color for an arm. These EXACT hexes are the canonical arm palette —
 * the Evaluation surface's legend + per-arm scoreboard key on the same values
 * (AdvEvalsTab `ARM_COLOR`), so the Frontier scatter dots match the legend.
 * This is the single source of truth: the surface should import `armColor` from
 * here rather than re-declaring it (categorical series colors, not semantic
 * theme tokens, so raw hex — not CSS vars — is correct). Unknown arms get the
 * neutral muted color.
 */
export function armColor(arm: string): string {
  switch (arm) {
    case 'papercusp': return '#eab308'; // gold — the L1 treatment (matches the active-subtab accent)
    case 'baseline-a-ablation': return '#a78bfa'; // violet
    case 'baseline-b-native': return '#38bdf8'; // sky — native arm
    case 'baseline-c-bestofn': return '#34d399'; // emerald
    // Fleet arms (Phase 5). hive = the treatment (gold, like papercusp — they
    // never share a chart). queen-ablated = the headline baseline control (rose).
    // native-serial reuses native sky. Competitors get distinct hues.
    case 'hive': return '#eab308'; // gold — the L2+ treatment (D-010)
    case 'queen-ablated': return '#fb7185'; // rose — the headline baseline (Queen OFF)
    case 'native-serial': return '#38bdf8'; // sky — serial floor (native, serial)
    case 'openhands': return '#a78bfa'; // violet
    case 'crewai': return '#f97316'; // orange
    case 'langgraph': return '#2dd4bf'; // teal
    default: return 'var(--fg-mute, #7f9bb4)';
  }
}

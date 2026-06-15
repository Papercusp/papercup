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
  | 'papercusp'
  | 'baseline-a-ablation'
  | 'baseline-b-native'
  | 'baseline-c-bestofn';

export const ARM_IDS: readonly ArmId[] = [
  'papercusp',
  'baseline-a-ablation',
  'baseline-b-native',
  'baseline-c-bestofn',
] as const;

/** Short human label for an arm; falls back to the raw id for unknown arms. */
export function armLabel(arm: string): string {
  switch (arm) {
    case 'papercusp': return 'Papercusp';
    case 'baseline-a-ablation': return 'Baseline A · ablation';
    case 'baseline-b-native': return 'Baseline B · native';
    case 'baseline-c-bestofn': return 'Baseline C · best-of-N';
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
    case 'papercusp': return '#eab308'; // gold — the treatment (matches the active-subtab accent)
    case 'baseline-a-ablation': return '#a78bfa'; // violet
    case 'baseline-b-native': return '#38bdf8'; // sky — the headline baseline (D-002)
    case 'baseline-c-bestofn': return '#34d399'; // emerald
    default: return 'var(--fg-mute, #7f9bb4)';
  }
}

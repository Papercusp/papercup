export const TSC_COMMAND: string;

/** Cross-package files this gate measures but does not own (EI-18649014117371738). */
export const FOREIGN_BASELINES: {
  prefix: string;
  baselineFile: string;
  label?: string;
}[];

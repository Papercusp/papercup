export interface SerialLeg {
  name: string;
  ms: number;
}

export interface SerialPhaseSummary {
  legs: number;
  /** Legacy marker name: summed task duration (serial-equivalent work), not scheduler wall time. */
  serialMs: number;
  longestMs: number;
  longestName: string;
  /**
   * serialMs / longestMs — an UPPER BOUND on perfect overlap versus serial execution, never an
   * achieved or forecast speedup. It ignores host contention and scheduler shape. 1 when there
   * is a single leg or every leg measured 0ms.
   */
  ceilingX: number;
  /** Every leg, slowest first. */
  slowest: SerialLeg[];
}

/** `null` for an empty or wholly-invalid leg set, so a zero-task run emits nothing. */
export function summarizeSerialPhase(legs: SerialLeg[]): SerialPhaseSummary | null;

export function formatSerialPhaseMarker(summary: SerialPhaseSummary): string;

export function formatSerialPhaseSummary(legs: SerialLeg[], opts?: { topN?: number }): string[];

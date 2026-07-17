export const TSC_COMMAND: string;

export interface TscErrorEntry {
  file: string | null;
  code: string;
}

export interface PerFileGateEntry {
  file: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface PerFileGateResult {
  verdict:
    | 'fail-syntax'
    | 'fail-regressed'
    | 'fail-attributed'
    | 'ok-peer-drift'
    | 'ok-ratchet'
    | 'ok-below'
    | 'ok';
  regressions: PerFileGateEntry[];
  improvements: PerFileGateEntry[];
  attributed?: PerFileGateEntry[];
  peerDrift?: PerFileGateEntry[];
  total: number;
  baselineTotal: number;
  newBaselineByFile?: Record<string, number>;
  brokenFiles?: string[];
}

export function parseTscErrors(tscOutput: string): TscErrorEntry[];
export function syntaxBrokenFiles(errors: TscErrorEntry[]): string[];
export function countByFile(errors: TscErrorEntry[]): Record<string, number>;
export function gitChangedFiles(root?: string): Set<string>;
export function decidePerFile(args: {
  currentByFile: Record<string, number>;
  baselineByFile: Record<string, number>;
  brokenFiles: string[];
  updateFlag?: boolean;
  changedFiles?: Set<string> | null;
}): PerFileGateResult;

export interface ParsedSourceReceipt {
  processId: number;
  sources: number;
  workerIds: string[];
  workersClosedByProcessExit: string[];
  parsedSourcePopulationComplete: true;
  completeRuntimeClosureVerified: false;
  scope: string;
}
export function validateRuntimeSourceCapture(rows: Record<string, any>[], expectedWorkerIds?: string[],
  processTerminal?: {processId: number; exitCode: number; signal: string | null; eof: boolean}): ParsedSourceReceipt;
export function bindRuntimeSourcePopulation(trace: string, terminal: {
  processId: number; exitCode: number; signal: string | null; eof: boolean; captureStartedBeforeExec: boolean;
}, captures: Record<string, any>[][]): {
  schema: 'runtime-traced-source-population/v1'; processId: number; processes: ParsedSourceReceipt[];
  tracedTaskPopulationComplete: true; parsedSourceProcessPopulationComplete: true;
  completeRuntimeClosureVerified: false; sourceQualification: 'required';
  dependencyQualification: 'required'; creatorFence: 'required'; scope: string;
};
export function startRuntimeSourceCapture(destination: string): void;

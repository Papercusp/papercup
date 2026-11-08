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
  pageSizeBytes?: number;
}, captures: Record<string, any>[][], fileInputs?: {
  root: string; files: {path: string; kind: 'file' | 'symlink'; sha256: string}[];
}, jitCaptures?: {
  bytes: Buffer; witness: Parameters<typeof import('./runtime-file-opens.mjs').bindRuntimeJitDump>[1];
}[]): {
  schema: 'runtime-traced-source-population/v1'; processId: number; processes: ParsedSourceReceipt[];
  tracedTaskPopulationComplete: true; parsedSourceProcessPopulationComplete: true;
  memoryTransitions: ReturnType<typeof import('./runtime-file-opens.mjs').bindRuntimeProcessTree>['memoryTransitions'];
  mappingOrigins: ReturnType<typeof import('./runtime-file-opens.mjs').bindRuntimeProcessTree>['mappingOrigins'];
  executableMemoryQualification: 'required';
  jitByteCapture: 'not-observed' | 'runtime-reported-code-loads-for-traced-processes';
  jitBindings?: (ReturnType<typeof import('./runtime-file-opens.mjs').bindRuntimeJitDump> & {
    tracedTaskIds: number[]; sourceCaptureSha256: string; witnessSha256: string;
  })[];
  completeRuntimeClosureVerified: false; sourceQualification: 'required';
  dependencyQualification: 'required'; creatorFence: 'required'; scope: string;
  fileInputs?: {
    censusSha256: string;
    bindings: {processId: number; target: string; scriptId: string; url: string; sha256: string; path: string}[];
    unboundSources: {processId: number; target: string; scriptId: string; url: string; sha256: string}[];
    originalSourceQualification: 'required'; nativeDependencyQualification: 'required';
  };
};
export function startRuntimeSourceCapture(destination: string): void;

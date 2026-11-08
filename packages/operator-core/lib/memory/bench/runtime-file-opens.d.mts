export function runtimeFileTraceArguments(output: string, command: string[]): string[];
export function bindRuntimeProcessTree(text: string, terminal: {
  processId: number; exitCode: number; signal: string | null; eof: boolean; captureStartedBeforeExec: boolean;
  pageSizeBytes?: number;
}): {
  schema: 'runtime-traced-process-tree/v1'; processId: number;
  tasks: {taskId: number; parentTaskId: number | null; threadGroupId: number;
    birthAtMs: number | null; execs: {executable: string; atMs: number}[]; terminalAtMs: number}[];
  memoryTransitions: {taskId: number; operation: string; arguments: string; result: string;
    succeeded: boolean; executablePermissionRequested: boolean | null; atMs: number; completedAtMs: number}[];
  mappingOrigins: {
    schema: 'runtime-mapping-origins/v1'; pageSizeBytes: number | null;
    changes: {taskId: number; addressSpaceId: number; atMs: number; completedAtMs: number;
      operation: string; ranges: RuntimeMappingRange[]}[];
    executableRanges: (RuntimeMappingRange & {taskId: number; addressSpaceId: number; atMs: number;
      completedAtMs: number; operation: string; byteOriginQualification: 'required'})[];
    gaps: {taskId: number; atMs: number | null; reason: string}[];
    mappingPopulationComplete: false; executableBytesQualified: false;
    jitByteOriginQualification: 'required'; effectivePermissionsQualification: 'required'; scope: string;
  };
  executableMemoryQualification: 'required';
  tracedTaskPopulationComplete: true; completeRuntimeClosureVerified: false;
  sourceQualification: 'required'; creatorFence: 'required'; scope: string;
};
interface RuntimeMappingRange {
  start: string; end: string; permissions: string;
  origin: {kind: 'anonymous' | 'file-mapping' | 'unresolved'; path: string | null; offsetBytes: string | null};
  executableBytesQualified: false;
}
export function bindRuntimeModelOpens(text: string, options: {
  processId: number;
  assets: {path: string}[];
  beforeEpochMs: number;
}): {
  processId: number;
  tasks: number[];
  opens: {taskId: number; atMs: number; path: string; fd: number}[];
  modelFilesOpenedBeforeInference: true;
  modelBytesReadVerified: false;
  scope: string;
};

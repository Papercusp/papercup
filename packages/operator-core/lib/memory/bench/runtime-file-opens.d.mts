export function runtimeFileTraceArguments(output: string, command: string[]): string[];
export function observeRuntimePageSize(): number;
export function bindRuntimeJitDump(bytes: Buffer, witness: {
  processId: number; taskIds: number[]; elfMachine: number;
  startedMonotonicNs: string; finishedMonotonicNs: string;
  exitCode: number; signal: string | null; eof: boolean; captureStartedBeforeExec: boolean;
}): {
  schema: 'runtime-jitdump-code-bytes/v1'; processId: number; elfMachine: number; endianness: 'little' | 'big'; bytes: number; sha256: string;
  createdMonotonicNs: string; recordCount: number; closeRecordObserved: boolean;
  loads: {taskId: number; codeIndex: string; address: string; virtualAddress: string;
    bytes: number; sha256: string; nameSha256: string; timestampNs: string; byteOffset: number}[];
  moves: {taskId: number; codeIndex: string; from: string; to: string; virtualAddress: string;
    bytes: number; timestampNs: string; destinationBytesObserved: false}[];
  metadata: {kind: number; bytes: number; sha256: string}[];
  byteEvidence: 'runtime-reported-code-load-payloads'; jitByteOriginQualification: 'required'; executableMemoryQualification: 'required';
  runtimeCaptureCustody: 'required'; creatorFence: 'required'; completeRuntimeClosureVerified: false;
};
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

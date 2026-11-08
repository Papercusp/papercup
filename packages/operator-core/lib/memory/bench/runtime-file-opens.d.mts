export function runtimeFileTraceArguments(output: string, command: string[], options?: {execEntryDelayMs: number}): string[];
export function observeRuntimePageSize(): number;
export interface RuntimeObservedProcessIdentity {
  processId: number; parentProcessId: number; startTimeTicks: string; executable: string;
}
export interface RuntimeExecEntryObservation {
  schema: 'runtime-exec-entry-observation/v1';
  process: RuntimeObservedProcessIdentity; observerProcessId: number;
  startedMonotonicNs: string; finishedMonotonicNs: string;
  tracer: {process: RuntimeObservedProcessIdentity;
    tasksBefore: {taskId: number; state: string; startTimeTicks: string}[];
    tasksAfter: {taskId: number; state: string; startTimeTicks: string}[]};
  tasksBefore: {taskId: number; state: string; startTimeTicks: string; tracerProcessId: number}[];
  tasksAfter: {taskId: number; state: string; startTimeTicks: string; tracerProcessId: number}[];
  syscallBefore: string; syscallAfter: string; auxvBefore: Buffer; auxvAfter: Buffer;
  mapsBefore: string; mapsAfter: string; elfHeader: {address: string; bytes: Buffer};
}
export function observeRuntimeExecEntry(identity: RuntimeObservedProcessIdentity,
  tracerIdentity: RuntimeObservedProcessIdentity): RuntimeExecEntryObservation;
export function bindRuntimeExecEntry(observation: RuntimeExecEntryObservation,
  identity: RuntimeObservedProcessIdentity, tracerIdentity: RuntimeObservedProcessIdentity): {
  schema: 'runtime-exec-entry-binding/v1'; process: RuntimeObservedProcessIdentity;
  instructionPointer: string; programEntry: string; interpreterBase: string;
  mapsSha256: string; auxvSha256: string; elfHeaderSha256: string;
  mappings: {start: string; end: string; permissions: string; offset: string;
    device: string; inode: string; path: string | null}[];
  kernelEntryObserved: true; mappingPopulationComplete: false; executableBytesQualified: false;
  completeRuntimeClosureVerified: false; scope: string;
};
export interface RuntimeExecutableMemoryObservation {
  schema: 'runtime-selected-executable-memory/v1';
  process: RuntimeObservedProcessIdentity; observerProcessId: number;
  startedMonotonicNs: string; finishedMonotonicNs: string;
  tasksBefore: {taskId: number; state: string; startTimeTicks: string; tracerProcessId?: number}[];
  tasksAfter: {taskId: number; state: string; startTimeTicks: string; tracerProcessId?: number}[];
  tracer?: {process: RuntimeObservedProcessIdentity;
    tasksBefore: {taskId: number; state: string; startTimeTicks: string}[];
    tasksAfter: {taskId: number; state: string; startTimeTicks: string}[]};
  mapsBefore: string; mapsAfter: string;
  samples: {codeIndex: string; address: string; bytes: Buffer}[];
}
export function observeRuntimeProcessIdentity(processId: number): RuntimeObservedProcessIdentity;
export function observeRuntimeTracerIdentity(identity: RuntimeObservedProcessIdentity,
  expectedExecutable: string): RuntimeObservedProcessIdentity;
export function observeRuntimeExecutableMemory(identity: RuntimeObservedProcessIdentity,
  ranges: {codeIndex: string; address: string; size: number}[],
  tracerIdentity?: RuntimeObservedProcessIdentity): RuntimeExecutableMemoryObservation;
export function bindRuntimeJitMemory(bytes: Buffer, witness: Parameters<typeof bindRuntimeJitDump>[1],
  observation: RuntimeExecutableMemoryObservation, expectedIdentity: RuntimeObservedProcessIdentity,
  expectedTracer?: RuntimeObservedProcessIdentity): {
    schema: 'runtime-jit-selected-memory-binding/v1'; processId: number;
    dumpSha256: string; mapsSha256: string; startedMonotonicNs: string; finishedMonotonicNs: string;
    /** Exact decimal byte totals for this stopped snapshot, not lifetime closure. */
    executableMappingCoverage: {
      mappings: {mapping: {start: string; end: string; permissions: string; offset: string;
        device: string; inode: string; path: string | null};
        selectedRanges: {codeIndex: string; address: string; bytes: number}[];
        observedBytes: string; unobservedBytes: string}[];
      totalBytes: string; observedBytes: string; unobservedBytes: string; scope: string;
    };
    bindings: {codeIndex: string; address: string; bytes: number; sha256: string;
      mapping: {start: string; end: string; permissions: string; offset: string;
        device: string; inode: string; path: string | null};
      /** Same-process stopped maps metadata only. Empty does not exclude aliases. */
      writableMappingCandidates: {kind: 'selected-mapping-writable' | 'matching-file-offset';
        mapping: {start: string; end: string; permissions: string; offset: string;
          device: string; inode: string; path: string | null};
        overlap: {selectedAddress: string; candidateAddress: string; bytes: number};
        sharedPhysicalBytesVerified: false}[]}[];
    selectedExecutableBytesVerified: true; emittedLoadsNotSampled: number;
    mappingPopulationComplete: false; executableBytesQualified: false; completeRuntimeClosureVerified: false;
    jitByteOriginQualification: 'required'; runtimeCaptureCustody: 'required'; creatorFence: 'required';
    writableAliasQualification: 'required'; scope: string;
};
export function bindRuntimeJitDump(bytes: Buffer, witness: {
  processId: number; taskIds: number[]; elfMachine: number;
  startedMonotonicNs: string; finishedMonotonicNs: string;
  headerClock?: 'monotonic-nanoseconds' | 'v8-realtime-microseconds';
  startedEpochMs?: number; finishedEpochMs?: number;
  exitCode: number; signal: string | null; eof: boolean; captureStartedBeforeExec: boolean;
}): {
  schema: 'runtime-jitdump-code-bytes/v1'; processId: number; elfMachine: number; endianness: 'little' | 'big'; bytes: number; sha256: string;
  headerTimestamp: string; headerClock: 'monotonic-nanoseconds' | 'v8-realtime-microseconds';
  recordClock: 'monotonic-nanoseconds'; recordCount: number; closeRecordObserved: boolean;
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
    succeeded: boolean; executablePermissionRequested: boolean | null; atMs: number; completedAtMs: number;
    /** Independent strace duration; null for legacy captures lacking -T. */
    durationNs: string | null}[];
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

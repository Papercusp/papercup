export function inspectHostDebuggerCapture(stdout: string, debuggerTerminal: {
  eof: boolean; exitCode: number | null; signal: string | null;
}): {
  processId: number;
  source: 'gdb-events';
  exitCode: number | null;
  signal: string | null;
  signalDelivered: true;
  debuggerPipeEof: true;
  hostBacktraceCaptured: boolean;
  embeddingModelInferencePerformed: false;
};

export function inspectAllocatorDetectorCapture(stdout: string, stderr: string, terminal: {
  processId: number; eof: boolean; captureStartedBeforeExec: boolean;
  exitCode: number | null; signal: string | null;
}, expected: {
  fault: 'clean' | 'tail-overwrite';
  binding: { path: string; bytes: number; sha256: string };
  debugAllocator: { path: string; bytes: number; sha256: string };
  serializedAdmissionContext: string | null;
}): {
  processId: number; source: 'native-allocator-control'; fault: 'clean' | 'tail-overwrite';
  exitCode: number | null; signal: string | null; pipeEof: true; debugAllocatorMapped: true;
  detectorTriggered: boolean; requestedBytes: 64;
  embeddingModelInferencePerformed: false; heapCorruptionRootCauseConfirmed: false;
};

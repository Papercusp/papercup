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

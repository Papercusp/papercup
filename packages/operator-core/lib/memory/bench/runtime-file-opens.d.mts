export function runtimeFileTraceArguments(output: string, command: string[]): string[];
export function bindRuntimeProcessTree(text: string, terminal: {
  processId: number; exitCode: number; signal: string | null; eof: boolean; captureStartedBeforeExec: boolean;
}): {
  schema: 'runtime-traced-process-tree/v1'; processId: number;
  tasks: {taskId: number; parentTaskId: number | null; threadGroupId: number;
    birthAtMs: number | null; execs: {executable: string; atMs: number}[]; terminalAtMs: number}[];
  memoryTransitions: {taskId: number; operation: string; arguments: string; result: string;
    succeeded: boolean; executablePermissionRequested: boolean | null; atMs: number; completedAtMs: number}[];
  executableMemoryQualification: 'required';
  tracedTaskPopulationComplete: true; completeRuntimeClosureVerified: false;
  sourceQualification: 'required'; creatorFence: 'required'; scope: string;
};
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

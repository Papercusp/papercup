export function resumeRetainedState(input: {
  root: string;
  env?: NodeJS.ProcessEnv;
  countTables?: string[];
}): Promise<{
  phase: string;
  root: string;
  dataDir: string;
  privatePort: number;
  clusterStopped: boolean;
  counts: Record<string, string>;
  childCutoffEpochMs: number;
  cleanupReserveMs: number;
}>;

export const SAMPLE_LOG_FILE: string;
export const MIN_SAMPLE_INTERVAL_MS: number;

export interface SampleOutputSource {
  path: string;
  bytes?: number | null;
  complete: boolean;
}

export function buildShowPoolsArgs(opts?: { host?: string; port?: number; user?: string }): string[];

export function buildPgActivityArgs(opts?: {
  connectionString?: string | null;
  pgbouncerPort?: number;
}): { args: string[]; env: Record<string, string>; unavailable?: never } | { unavailable: string; args?: never; env?: never };

export function samplePgBouncerPools(
  reason: string,
  opts?: {
    execFileImpl?: (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => void;
    now?: () => number;
    activityConnectionString?: string | null;
    pid?: number;
    requestFingerprint?: string;
  },
): Promise<{
  ok: boolean;
  output?: string;
  error?: string | null;
  outputSource?: SampleOutputSource;
  outputOmittedBytes?: number | null;
  captureRef?: string | null;
  skipped?: string;
  pgActivity?: {
    ok: boolean;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    output?: string;
    outputSource?: SampleOutputSource;
    outputOmittedBytes?: number | null;
    error?: string | null;
    stderr?: string;
    stderrOmittedChars?: number;
    stderrSource?: SampleOutputSource;
    census?: { totalGroups: number; totalSessions: number; clientBackends: number; parallelWorkers: number } | null;
    shownGroups?: number | null;
    omittedGroups?: number | null;
    skipped?: string;
  };
}>;

export function _resetSampleDebounceForTests(): void;

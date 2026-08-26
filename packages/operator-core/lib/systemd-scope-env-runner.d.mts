export const SYSTEMD_RUNNER_OUTPUT_PATH_ENV: string;
export const SYSTEMD_RUNNER_REDACTIONS_ENV: string;
export const SYSTEMD_RUNNER_JOB_END_PREFIX: string;

export interface StreamingSecretRedactor {
  push(chunk: string): string;
  flush(): string;
}

export function createStreamingSecretRedactor(
  values: readonly string[] | undefined,
): StreamingSecretRedactor | null;

export function main(argv?: string[]): void;

/**
 * True when `entryPath` is the copied runner itself, so only that copy self-executes.
 * Defaults to `process.argv[1]`. Mirrors the implementation in the sibling `.mjs`.
 */
export function isDirectSystemdScopeEnvRunnerInvocation(entryPath?: string): boolean;

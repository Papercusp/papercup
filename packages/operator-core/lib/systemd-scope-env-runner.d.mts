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

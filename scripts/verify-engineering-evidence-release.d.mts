export interface EngineeringReleaseProof {
  scope: string;
  status: 'pass' | 'unknown';
  reason?: string;
  plane?: 'final-release';
  buildSha?: string;
  manifestSha256?: string;
  receiptPath?: string;
  receiptSha256?: string;
  nonce?: string;
}
export function verifyEngineeringRelease(options: {
  root: string;
  inputsPath: string;
  env?: NodeJS.ProcessEnv;
  nonce?: string;
  read?: (path: string) => string | Buffer;
  run?: (command: string, argv: string[], options: Record<string, unknown>) => {
    status: number | null; stdout?: string; signal?: string | null; error?: unknown;
  };
}): EngineeringReleaseProof;

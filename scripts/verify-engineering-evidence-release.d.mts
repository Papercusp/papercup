export interface EngineeringReleaseProof {
  scope: string;
  status: 'pass' | 'unknown';
  reason?: string;
  plane?: 'final-release' | 'current-build';
  buildSha?: string;
  manifestSha256?: string;
  receiptPath?: string;
  receiptSha256?: string;
  nonce?: string;
  integration?: { logPath: string; sha256: string; result: string; files: string[] };
}
export const CURRENT_ENGINEERING_TEST_FILES: string[];
export function verifyEngineeringRelease(options: {
  root: string;
  inputsPath: string;
  env?: NodeJS.ProcessEnv;
  nonce?: string;
  plane?: 'final-release' | 'current-build';
  write?: (path: string, bytes: string) => void;
  read?: (path: string) => string | Buffer;
  run?: (command: string, argv: string[], options: Record<string, unknown>) => {
    status: number | null; stdout?: string; signal?: string | null; error?: unknown;
  };
}): EngineeringReleaseProof;

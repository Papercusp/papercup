export const KICKOFF_PROMPT_FILE_ENV: 'PAPERCUSP_KICKOFF_PROMPT_FILE';
export const INLINE_KICKOFF_MAX_BYTES: number;
export const KICKOFF_PROOF_PATH_ENV: 'PAPERCUSP_KICKOFF_PROOF_PATH';
export const KICKOFF_PROOF_TOKEN_ENV: 'PAPERCUSP_KICKOFF_PROOF_TOKEN';

export function publishKickoffProofReceipt(
  proof?: { persisted?: boolean; nativeRef?: string | null; reason?: string | null } | null,
  env?: Record<string, string | undefined>,
): { published: boolean; reason?: string; errorMessage?: string; errorCode?: string | null };

export function prepareKickoffEnvironment(env: Record<string, string>): Record<string, string>;
export function prepareKickoffEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function consumeKickoffPromptFile(path: string | null | undefined): string | null;

export const CLAUDE_TOOL_REFERENCE_POISON_TURNS: number;
export const MAX_CLAUDE_RESUME_TOOL_REFERENCES: number;

export interface ClaudeResumeTranscriptAnalysis {
  toolReferences: string[];
  trailingMissingToolReferenceTurns: number;
  lastMissingToolReferenceEvidence: string | null;
  poisoned: boolean;
}

export function isMissingClaudeToolReferenceError(text: unknown): boolean;
export function missingClaudeToolReferenceEvidence(text: unknown): string | null;
export function analyzeClaudeResumeTranscript(
  jsonl: string,
  options?: { maxReferences?: number },
): ClaudeResumeTranscriptAnalysis;
export function analyzeClaudeResumeTranscriptFile(
  filePath: string,
  options?: { maxReferences?: number },
): ClaudeResumeTranscriptAnalysis | null;
export function __resetClaudeResumeTranscriptCacheForTests(): void;
export function appendClaudeToolReferencesToSeed(seed: string | null | undefined, references: readonly string[]): string;

export declare const PROVIDER_PREFILTER: RegExp[];

export declare function egressTexts(toolName: string, toolInput: Record<string, unknown> | undefined): string[];

export declare function prefilterHits(texts: readonly string[]): boolean;

export declare function decideEgress(params: {
  toolName: string;
  toolInput?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string }>;

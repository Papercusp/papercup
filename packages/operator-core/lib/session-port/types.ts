export const SESSION_PORT_SCHEMA = 'papercusp.session-port/v1' as const;
export const SESSION_PORT_PROTOCOL_VERSION = 1 as const;

export type SessionBackend = 'claude' | 'codex' | 'omp';
export type PortableRole = 'user' | 'assistant' | 'system' | 'tool';

export interface PortableTextBlock {
  type: 'text';
  text: string;
}

export interface PortableToolNarrativeBlock {
  /** Inert historical narrative. This is deliberately not an executable tool
   * object and carries no source-provider call id. */
  type: 'tool_narrative';
  event: 'call' | 'result';
  name: string;
  content: string;
  isError?: boolean;
}

export interface PortableOmissionBlock {
  type: 'omission';
  reason: 'binary-attachment' | 'unsupported-content' | 'redacted';
  sourceType: string;
}

export type PortableBlock =
  | PortableTextBlock
  | PortableToolNarrativeBlock
  | PortableOmissionBlock;

export interface PortableTurn {
  id: string;
  parentId: string | null;
  role: PortableRole;
  timestamp: string | null;
  blocks: PortableBlock[];
  compactSummary?: boolean;
}

export interface PortableSessionPort {
  schema: typeof SESSION_PORT_SCHEMA;
  protocolVersion: typeof SESSION_PORT_PROTOCOL_VERSION;
  source: {
    backend: SessionBackend;
    workspaceId: string;
    advSessionId: number;
    nativeSessionId: string;
    cwd: string;
    harnessSlug: string | null;
    planSlug: string | null;
    capturedAt: string;
    snapshot: {
      kind: 'live-jsonl' | 'archive-manifest';
      highWaterBytes: number;
      completeBytes: number;
      sha256: string;
      archiveRelpath: string | null;
    };
    activeLeafId: string | null;
    compactSummaryIds: string[];
  };
  target: {
    backend: SessionBackend;
    provider: string;
    model: string | null;
    account: string;
    contextWindow: number;
    availableInputTokens: number;
    contextSize: 'full' | 'trimmed' | null;
  };
  fidelity: 'full' | 'summary-tail';
  versions: {
    adapter: number;
    transform: number;
    renderer: number;
    summaryPrompt: number | null;
  };
  hashes: {
    source: string;
    normalized: string;
    rendered: string;
  };
  portedFrom: {
    backend: SessionBackend;
    advSessionId: number;
    nativeSessionId: string;
  };
  turns: PortableTurn[];
  stats: {
    sourceRecords: number;
    activePathRecords: number;
    malformedRecords: number;
    sidechainRecords: number;
    compactedAncestors: number;
    toolCalls: number;
    toolResults: number;
    omittedAttachments: number;
    unsupportedBlocks: number;
    syntheticRecords: number;
    redactions: number;
    controlBytesRemoved: number;
    delimiterEscapes: number;
  };
  summary: null | {
    provider: string;
    model: string;
    costUsd: number;
    chunks: number;
    promptVersion: number;
  };
  warnings: string[];
}

export interface ClaudeAdaptResult {
  turns: PortableTurn[];
  stats: PortableSessionPort['stats'];
  warnings: string[];
  activeLeafId: string | null;
}

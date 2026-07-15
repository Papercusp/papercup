export const SESSION_PORT_SCHEMA = 'papercusp.session-port/v1' as const;
export const SESSION_PORT_PROTOCOL_VERSION = 1 as const;

export type SessionBackend = 'claude' | 'codex' | 'omp';
export type PortableRole = 'user' | 'assistant' | 'system' | 'tool';

export interface PortableTextBlock {
  type: 'text';
  text: string;
}

export interface PortableToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface PortableToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface PortableOmissionBlock {
  type: 'omission';
  reason: 'binary-attachment' | 'unsupported-content' | 'redacted';
  sourceType: string;
}

export type PortableBlock =
  | PortableTextBlock
  | PortableToolCallBlock
  | PortableToolResultBlock
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
    advSessionId: number | null;
    nativeSessionId: string | null;
    capturedAt: string;
    highWaterBytes: number | null;
  };
  target: {
    backend: SessionBackend;
    model: string | null;
    contextWindow: number;
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
  };
  warnings: string[];
}

export interface ClaudeAdaptResult {
  turns: PortableTurn[];
  stats: PortableSessionPort['stats'];
  warnings: string[];
  activeLeafId: string | null;
}

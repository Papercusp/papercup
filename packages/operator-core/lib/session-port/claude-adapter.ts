import type {
  ClaudeAdaptResult,
  PortableBlock,
  PortableRole,
  PortableTurn,
} from './types';

type Json = Record<string, any>;

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

function roleOf(record: Json): PortableRole {
  const role = String(record?.message?.role ?? record?.role ?? record?.type ?? '').toLowerCase();
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'user';
}

function blocksOf(record: Json, stats: ClaudeAdaptResult['stats']): PortableBlock[] {
  const content = record?.message?.content ?? record?.content;
  const values = Array.isArray(content) ? content : content == null ? [] : [content];
  const blocks: PortableBlock[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      if (value) blocks.push({ type: 'text', text: value });
      continue;
    }
    const kind = String(value?.type ?? 'unknown');
    if (kind === 'text' || kind === 'thinking' || kind === 'summary') {
      const text = textOf(value.text ?? value.thinking ?? value.summary);
      if (text) blocks.push({ type: 'text', text });
    } else if (kind === 'tool_use') {
      stats.toolCalls++;
      blocks.push({
        type: 'tool_call',
        id: String(value.id ?? ''),
        name: String(value.name ?? 'unknown'),
        input: value.input ?? null,
      });
    } else if (kind === 'tool_result') {
      stats.toolResults++;
      blocks.push({
        type: 'tool_result',
        toolCallId: String(value.tool_use_id ?? value.toolUseId ?? ''),
        content: textOf(value.content),
        isError: value.is_error === true || value.isError === true,
      });
    } else if (kind === 'image' || kind === 'document' || kind === 'attachment') {
      stats.omittedAttachments++;
      blocks.push({ type: 'omission', reason: 'binary-attachment', sourceType: kind });
    } else {
      stats.unsupportedBlocks++;
      blocks.push({ type: 'omission', reason: 'unsupported-content', sourceType: kind });
    }
  }
  return blocks;
}

/**
 * Reconstruct Claude's active parent-linked path. JSONL append order is not a
 * conversation order: retries and sidechains coexist in the file. We choose
 * the newest non-sidechain conversational leaf, follow parentUuid, and then
 * cut summarized ancestors at the newest isCompactSummary record so the port
 * never sends both a summary and the history it already represents.
 */
export function adaptClaudeJsonl(jsonl: string): ClaudeAdaptResult {
  const stats: ClaudeAdaptResult['stats'] = {
    sourceRecords: 0,
    activePathRecords: 0,
    malformedRecords: 0,
    sidechainRecords: 0,
    compactedAncestors: 0,
    toolCalls: 0,
    toolResults: 0,
    omittedAttachments: 0,
    unsupportedBlocks: 0,
  };
  const warnings: string[] = [];
  const records: Array<Json & { __line: number }> = [];
  for (const [index, line] of String(jsonl).split('\n').entries()) {
    if (!line.trim()) continue;
    stats.sourceRecords++;
    try {
      const record = JSON.parse(line) as Json;
      records.push({ ...record, __line: index });
      if (record.isSidechain === true) stats.sidechainRecords++;
    } catch {
      stats.malformedRecords++;
    }
  }

  const nodes = new Map<string, Json & { __line: number }>();
  for (const record of records) {
    if (record.uuid) nodes.set(String(record.uuid), record);
  }
  const candidates = records.filter(
    (record) =>
      record.uuid &&
      record.isSidechain !== true &&
      (record.type === 'user' || record.type === 'assistant' || record.message?.role),
  );
  const leaf = candidates.at(-1) ?? null;
  const reversed: Array<Json & { __line: number }> = [];
  const visited = new Set<string>();
  let cursor = leaf;
  while (cursor?.uuid) {
    const id = String(cursor.uuid);
    if (visited.has(id)) {
      warnings.push(`cycle detected at ${id}; path truncated`);
      break;
    }
    visited.add(id);
    reversed.push(cursor);
    const parent = cursor.parentUuid == null ? null : String(cursor.parentUuid);
    if (!parent) break;
    const next = nodes.get(parent) ?? null;
    if (!next) {
      warnings.push(`missing parent ${parent} for ${id}; path starts at the earliest available record`);
      break;
    }
    cursor = next;
  }
  let path = reversed.reverse();
  const compactIndex = path.findLastIndex((record) => record.isCompactSummary === true);
  if (compactIndex > 0) {
    stats.compactedAncestors = compactIndex;
    path = path.slice(compactIndex);
  }
  stats.activePathRecords = path.length;

  const turns: PortableTurn[] = path.map((record) => ({
    id: String(record.uuid),
    parentId: record.parentUuid == null ? null : String(record.parentUuid),
    role: roleOf(record),
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    blocks: blocksOf(record, stats),
    ...(record.isCompactSummary === true ? { compactSummary: true } : {}),
  }));

  if (stats.malformedRecords) warnings.push(`${stats.malformedRecords} malformed JSONL record(s) omitted`);
  if (stats.sidechainRecords) warnings.push(`${stats.sidechainRecords} sidechain record(s) excluded from the active path`);
  if (stats.omittedAttachments) warnings.push(`${stats.omittedAttachments} binary attachment(s) represented as omissions`);
  if (stats.unsupportedBlocks) warnings.push(`${stats.unsupportedBlocks} unsupported content block(s) represented as omissions`);
  return { turns, stats, warnings, activeLeafId: leaf?.uuid ? String(leaf.uuid) : null };
}

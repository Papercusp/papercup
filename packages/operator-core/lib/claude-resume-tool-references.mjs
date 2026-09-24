/**
 * Claude persists MCP `tool_reference` blocks in its transcript. A resumed
 * process must advertise those Papercusp tools again before Claude replays the
 * transcript; otherwise the provider rejects the request before the agent can
 * recover with tools:find.
 *
 * Shared by the interactive psu launcher and the detached await-wake resume
 * path. Keep this plain ESM so both launch surfaces use the same name and
 * transcript rules.
 */
import { readFileSync, statSync } from 'node:fs';

const PAPERCUSP_MCP_TOOL_PREFIX = /^mcp__papercusp(?:-su|_su)__/i;
const MISSING_TOOL_REFERENCE_RE =
  /^\s*API Error(?::\s*400|\s+400\b)[^\r\n]{0,300}\bTool reference\s+['"][^'"]+['"]\s+not found in available tools\b/im;

export const CLAUDE_TOOL_REFERENCE_POISON_TURNS = 3;
export const MAX_CLAUDE_RESUME_TOOL_REFERENCES = 32;
const MAX_TRANSCRIPT_CACHE_ENTRIES = 256;
const transcriptCache = new Map();

/** True only for the provider's exact unavailable-deferred-tool failure. */
export function isMissingClaudeToolReferenceError(text) {
  return missingClaudeToolReferenceEvidence(text) !== null;
}

/** Bounded exact evidence shared by the exit classifier and poison detector. */
export function missingClaudeToolReferenceEvidence(text) {
  if (typeof text !== 'string') return null;
  const match = MISSING_TOOL_REFERENCE_RE.exec(text);
  return match ? match[0].trim().slice(0, 200) : null;
}

function collectPapercuspToolReferences(value, found) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPapercuspToolReferences(item, found);
    return;
  }
  const record = value;
  if (
    record.type === 'tool_reference' &&
    typeof record.tool_name === 'string' &&
    PAPERCUSP_MCP_TOOL_PREFIX.test(record.tool_name)
  ) {
    found.delete(record.tool_name);
    found.set(record.tool_name, true);
  }
  for (const child of Object.values(record)) collectPapercuspToolReferences(child, found);
}

function rememberMissingToolReference(text, found) {
  if (typeof text !== 'string') return;
  const match = /\bTool reference\s+['"]([^'"]+)['"]\s+not found in available tools\b/i.exec(text);
  const name = match?.[1];
  if (name && PAPERCUSP_MCP_TOOL_PREFIX.test(name)) {
    found.delete(name);
    found.set(name, true);
  }
}

function assistantText(record) {
  const role = record?.message?.role ?? record?.role;
  if (record?.type !== 'assistant' && role !== 'assistant') return null;
  if (role && role !== 'assistant') return null;
  const content = record?.message?.content ?? record?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Scan Claude JSONL once for recent Papercusp references and the trailing
 * streak of exact missing-reference assistant turns. References are returned
 * most-recent-first and capped so a long transcript cannot inflate every
 * resumed prompt into the full catalog.
 */
export function analyzeClaudeResumeTranscript(jsonl, options = {}) {
  const maxReferences = Number.isInteger(options.maxReferences) && options.maxReferences >= 0
    ? options.maxReferences
    : MAX_CLAUDE_RESUME_TOOL_REFERENCES;
  const references = new Map();
  let trailingMissingToolReferenceTurns = 0;
  let lastMissingToolReferenceEvidence = null;

  for (const line of String(jsonl ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A partial/corrupt row cannot prove a reference or assistant turn.
      continue;
    }

    collectPapercuspToolReferences(record, references);
    const text = assistantText(record);
    if (text === null) continue;
    rememberMissingToolReference(text, references);
    const evidence = missingClaudeToolReferenceEvidence(text);
    trailingMissingToolReferenceTurns = evidence ? trailingMissingToolReferenceTurns + 1 : 0;
    lastMissingToolReferenceEvidence = evidence;
  }

  const toolReferences = maxReferences === 0
    ? []
    : [...references.keys()].slice(-maxReferences).reverse();
  return {
    toolReferences,
    trailingMissingToolReferenceTurns,
    lastMissingToolReferenceEvidence,
    poisoned: trailingMissingToolReferenceTurns >= CLAUDE_TOOL_REFERENCE_POISON_TURNS,
  };
}

/** Read and cache diagnostics by file size + mtime; a busy inbox-wake session
 * is scanned once per transcript version rather than once per message. */
export function analyzeClaudeResumeTranscriptFile(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const key = `${filePath}\0${stat.size}\0${stat.mtimeMs}`;
    const cached = transcriptCache.get(key);
    if (cached) {
      transcriptCache.delete(key);
      transcriptCache.set(key, cached);
      return cached;
    }
    const analysis = analyzeClaudeResumeTranscript(readFileSync(filePath, 'utf8'), options);
    transcriptCache.set(key, analysis);
    while (transcriptCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
      transcriptCache.delete(transcriptCache.keys().next().value);
    }
    return analysis;
  } catch {
    return null;
  }
}

/** Test seam for the bounded process-local transcript cache. */
export function __resetClaudeResumeTranscriptCacheForTests() {
  transcriptCache.clear();
}

/** Append client-mangled names without changing the existing seed or order. */
export function appendClaudeToolReferencesToSeed(seed, references) {
  const names = String(seed ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const seen = new Set(names.map((name) => name.toLowerCase()));
  for (const reference of references ?? []) {
    if (typeof reference !== 'string' || !PAPERCUSP_MCP_TOOL_PREFIX.test(reference)) continue;
    const name = reference.trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names.join(',');
}

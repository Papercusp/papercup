#!/usr/bin/env node
/**
 * Measure raw tool output in Claude Code and Codex JSONL transcripts.
 *
 * This intentionally reads the client transcripts, rather than
 * harness_shared.session_turn_parts: the latter caps every part before it is
 * persisted.  `bytes` below are UTF-8 bytes.  No tokenizer estimate is used.
 * `rereadBytes` is the replay volume implied by later model requests in the
 * same transcript (one output is sent again for each later request).
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_CLAUDE_ROOTS = [join(homedir(), '.claude', 'projects'), join(homedir(), '.papercusp', 'session-claude')];
const DEFAULT_CODEX_ROOTS = [join(homedir(), '.codex', 'sessions')];
const CAP_NAMES = ['codex-outer-exec', 'nested-shell', 'papercusp-door'];

function args(argv) {
  const out = { hours: 24, out: null, claudeRoots: [], codexRoots: [], roots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--hours' || a === '--window-hours') out.hours = Number(next), i += 1;
    else if (a === '--out') out.out = next, i += 1;
    else if (a === '--claude-root') out.claudeRoots.push(resolve(next)), i += 1;
    else if (a === '--codex-root') out.codexRoots.push(resolve(next)), i += 1;
    else if (a === '--root') out.roots.push(resolve(next)), i += 1;
    else if (!a.startsWith('-')) out.roots.push(resolve(a));
    else throw new Error(`unknown option ${a}`);
  }
  if (!Number.isFinite(out.hours) || out.hours <= 0) throw new Error('--hours must be a positive number');
  if (!out.claudeRoots.length && !out.codexRoots.length && !out.roots.length) {
    out.claudeRoots = DEFAULT_CLAUDE_ROOTS;
    out.codexRoots = DEFAULT_CODEX_ROOTS;
  }
  return out;
}

async function* jsonlFiles(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function utf8(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) return value.reduce((n, x) => n + utf8(x), 0);
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return utf8(value.text);
    if (typeof value.content !== 'undefined') return utf8(value.content);
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
  return 0;
}

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content !== 'undefined') return text(value.content);
    return JSON.stringify(value);
  }
  return '';
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function distribution(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.50),
    p90: percentile(values, 0.90),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: percentile(values, 1),
  };
}

function normalizeTool(client, name, input) {
  let tool = String(name || '(unknown)');
  if (client === 'claude' && tool === 'Bash') {
    const command = String(input?.command ?? '').trim().split(/\s+/)[0] || '(empty)';
    return `Bash:${command}`;
  }
  if (client === 'claude' && /capability_bash$/.test(tool)) {
    const command = String(input?.cmd ?? input?.command ?? '').replace(/^cd [^;&]*(?:;|&&)\s*/, '').trim().split(/\s+/)[0] || '(empty)';
    return `capability_bash:${command}`;
  }
  if (client === 'codex' && tool === 'exec') return 'code-mode-exec';
  if (client === 'codex' && /^(exec_command|shell|local_shell_call)$/.test(tool)) {
    let command = '';
    try {
      const parsed = typeof input === 'string' ? JSON.parse(input) : input || {};
      command = String(parsed.cmd ?? parsed.command ?? parsed.action ?? '').trim().split(/\s+/)[0];
    } catch { /* opaque command */ }
    return `${tool}:${command || '(empty)'}`;
  }
  return tool;
}

function capFor(client, tool, body) {
  const s = String(body || '');
  // The door footer is emitted after the kept payload and is an exact marker.
  if (/\[result-door:|\[projection:|result[- ]door overflow|output_spill_failed/i.test(s)) return 'papercusp-door';
  if (client === 'codex' && /(?:exec_command|local_shell_call|^shell:)/.test(tool)
    && /(?:outer exec|exec output|output (?:was )?truncated|truncated (?:at|to)|MAX_OUTPUT|EXEC_OUTPUT_TRUNCATED)/i.test(s)) return 'codex-outer-exec';
  if (/(?:capability_bash|Bash:|nested shell|shell output)/i.test(tool)
    && /(?:nested shell|shell output (?:was )?truncated|truncated (?:at|to)|SHELL_OUTPUT_TRUNCATED|MAX_OUTPUT)/i.test(s)) return 'nested-shell';
  return null;
}

function emptyCap() {
  return Object.fromEntries(CAP_NAMES.map((name) => [name, { results: 0, bytes: 0, reruns: 0, rerunBytes: 0, shareOfResults: 0, shareOfBytes: 0 }]));
}

function routeSummary(rows, modelCalls, files, parseErrors) {
  const byTool = new Map();
  let rereadBytes = 0;
  let resultBytes = 0;
  let resultCount = 0;
  let truncatedResults = 0;
  const sizes = [];
  const caps = emptyCap();
  const reruns = [];
  for (const row of rows) {
    const agg = byTool.get(row.tool) || { tool: row.tool, results: 0, bytes: 0, rereadBytes: 0, sizes: [], truncatedResults: 0, reruns: 0, rerunBytes: 0 };
    agg.results += 1; agg.bytes += row.bytes; agg.rereadBytes += row.rereadBytes; agg.sizes.push(row.bytes);
    if (row.cap) {
      agg.truncatedResults += 1; truncatedResults += 1;
      const c = caps[row.cap]; c.results += 1; c.bytes += row.bytes;
      c.reruns += row.reruns; c.rerunBytes += row.rerunBytes;
      agg.reruns += row.reruns; agg.rerunBytes += row.rerunBytes;
    }
    if (row.reruns) reruns.push({ tool: row.tool, cap: row.cap, count: row.reruns, bytes: row.rerunBytes });
    resultBytes += row.bytes; resultCount += 1; rereadBytes += row.rereadBytes; sizes.push(row.bytes);
  }
  for (const c of Object.values(caps)) {
    c.shareOfResults = resultCount ? Number((c.results / resultCount).toFixed(6)) : 0;
    c.shareOfBytes = resultBytes ? Number((c.bytes / resultBytes).toFixed(6)) : 0;
  }
  const tools = [...byTool.values()].map(({ sizes: _, ...r }) => ({ ...r, size: distribution(byTool.get(r.tool).sizes) })).sort((a, b) => b.bytes - a.bytes);
  return {
    files, parseErrors, modelCalls,
    results: resultCount, bytes: resultBytes, rereadBytes,
    size: distribution(sizes), tools,
    truncation: { results: truncatedResults, shareOfResults: resultCount ? truncatedResults / resultCount : 0, byCap: caps },
    reruns: { resultsAfterTruncation: reruns.reduce((n, x) => n + x.count, 0), bytesAfterTruncation: reruns.reduce((n, x) => n + x.bytes, 0), rows: reruns },
  };
}

async function scan(file, client, cutoff) {
  const names = new Map();
  const calls = [];
  const results = [];
  let modelCalls = 0;
  let parseErrors = 0;
  let order = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { parseErrors += 1; continue; }
    const timestamp = Date.parse(rec.timestamp || '');
    const inWindow = !(Number.isFinite(timestamp) && timestamp < cutoff);
    order += 1;
    if (client === 'claude') {
      const m = rec.message;
      if (rec.type === 'assistant' && m) {
        // Each assistant envelope is one model request/response. Deduplication
        // keeps retries represented by their own envelope while avoiding a
        // duplicate UUID copied by transcript repair.
        if (!m.id || !calls.some((x) => x.id === m.id)) modelCalls += 1;
        for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === 'tool_use') {
          const tool = normalizeTool(client, b.name, b.input);
          names.set(b.id, { tool, order, index: calls.length });
          calls.push({ tool, order });
        }
      }
      if (rec.type === 'user' && m) for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'tool_result') continue;
        const n = utf8(b.content);
        const info = names.get(b.tool_use_id) || { tool: '(unmatched)', index: calls.length, order };
        const cap = capFor(client, info.tool, text(b.content));
        if (inWindow) results.push({ tool: info.tool, bytes: n, cap, order, callIndex: info.index, reruns: 0, rerunBytes: 0 });
      }
    } else {
      const p = rec.payload;
      if (rec.type === 'event_msg' && p?.type === 'token_count') { modelCalls += 1; continue; }
      if (rec.type !== 'response_item' || !p) continue;
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const tool = normalizeTool(client, p.name || p.type, p.arguments || p.input || p.action);
        names.set(p.call_id || p.id, { tool, order, index: calls.length });
        calls.push({ tool, order });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const info = names.get(p.call_id) || { tool: '(unmatched)', index: calls.length, order };
        const body = p.output;
        const n = utf8(body);
        const cap = capFor(client, info.tool, text(body));
        if (inWindow) results.push({ tool: info.tool, bytes: n, cap, order, callIndex: info.index, reruns: 0, rerunBytes: 0 });
      }
    }
  }
  // A result is replayed on every later model request in this same raw file.
  // Count same-tool calls after a capped result as explicit reruns; unrelated
  // later calls still contribute to rereadBytes.
  for (const row of results) {
    const later = calls.filter((c) => c.index > row.callIndex && c.order > row.order);
    row.rereadBytes = row.bytes * Math.max(0, modelCalls - row.callIndex - 1);
    const same = later.filter((c) => c.tool === row.tool);
    if (row.cap && same.length) { row.reruns = same.length; row.rerunBytes = row.bytes * same.length; }
  }
  return { results, modelCalls, parseErrors };
}

async function measure(roots, hours) {
  const cutoff = Date.now() - hours * 3600_000;
  const grouped = { claude: { files: 0, parseErrors: 0, rows: [], modelCalls: 0 }, codex: { files: 0, parseErrors: 0, rows: [], modelCalls: 0 } };
  const missingRoots = [];
  for (const [client, clientRoots] of Object.entries(roots)) {
    for (const root of clientRoots) {
      let rootStat;
      try { rootStat = await stat(root); } catch { missingRoots.push({ client, root }); continue; }
      if (!rootStat.isDirectory()) { missingRoots.push({ client, root }); continue; }
      for await (const file of jsonlFiles(root)) {
        // Do not use file mtime as the measurement boundary: a long-lived
        // transcript has fresh rows in an old inode. The parser applies the
        // timestamp boundary to each result instead.
        const scanned = await scan(file, client, cutoff);
        grouped[client].files += 1;
        grouped[client].parseErrors += scanned.parseErrors;
        grouped[client].rows.push(...scanned.results);
        grouped[client].modelCalls += scanned.modelCalls;
      }
    }
  }
  const claude = routeSummary(grouped.claude.rows, grouped.claude.modelCalls, grouped.claude.files, grouped.claude.parseErrors);
  const codex = routeSummary(grouped.codex.rows, grouped.codex.modelCalls, grouped.codex.files, grouped.codex.parseErrors);
  return {
    measuredAt: new Date().toISOString(), windowHours: hours,
    cutoff: new Date(cutoff).toISOString(), missingRoots,
    clients: { claude, codex },
    results: claude.results + codex.results,
    bytes: claude.bytes + codex.bytes,
    rereadBytes: claude.rereadBytes + codex.rereadBytes,
    truncation: {
      results: claude.truncation.results + codex.truncation.results,
      byCap: Object.fromEntries(CAP_NAMES.map((cap) => [cap, {
        results: claude.truncation.byCap[cap].results + codex.truncation.byCap[cap].results,
        bytes: claude.truncation.byCap[cap].bytes + codex.truncation.byCap[cap].bytes,
        reruns: claude.truncation.byCap[cap].reruns + codex.truncation.byCap[cap].reruns,
        rerunBytes: claude.truncation.byCap[cap].rerunBytes + codex.truncation.byCap[cap].rerunBytes,
      }])),
    },
    reruns: {
      resultsAfterTruncation: claude.reruns.resultsAfterTruncation + codex.reruns.resultsAfterTruncation,
      bytesAfterTruncation: claude.reruns.bytesAfterTruncation + codex.reruns.bytesAfterTruncation,
    },
  };
}

export { capFor, measure, normalizeTool, percentile, routeSummary, scan };

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = args(process.argv.slice(2));
  const roots = {
    claude: cli.claudeRoots.length ? cli.claudeRoots : cli.roots.filter((r) => !/codex/i.test(r)),
    codex: cli.codexRoots.length ? cli.codexRoots : cli.roots.filter((r) => /codex/i.test(r)),
  };
  if (cli.roots.length && !roots.claude.length && !roots.codex.length) roots.claude = cli.roots;
  const baseline24h = await measure(roots, 24);
  const result = cli.hours === 24 ? baseline24h : await measure(roots, cli.hours);
  const output = { schemaVersion: 'tool-output-measurement-v1', ...result, baseline24h };
  if (cli.out) await writeFile(cli.out, JSON.stringify(output, null, 2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

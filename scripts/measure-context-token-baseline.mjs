#!/usr/bin/env node
/**
 * P-004 (plan agent-context-firewall-and-output-spill-2026-08-02) — the
 * tokens-into-context baseline this plan is judged on, decomposed by source.
 *
 * WHY NOT `harness_shared.session_turn_parts`: that table is the obvious
 * candidate (it already carries speaker/part_kind/tool_name/text) and it is
 * WRONG for this measurement — `session-ingest.ts:97` caps every part at
 * `PART_TEXT_CAP = 2000` chars. The cap is deliberate and correct for its own
 * purpose (faithful RENDER of recent sessions), but it clips exactly the
 * category this plan is about: the ingester's own comment measures tool_result
 * at 218 MB raw against text's 21 MB over 7 days, and says capping at 2k
 * "recovers 61% of it". A decomposition read off that table understates
 * tool_result by roughly an order of magnitude while looking entirely
 * plausible. This script therefore reads the RAW transcript JSONL — the exact
 * bytes the model saw.
 *
 * NOT A SECOND CORPUS: the sibling plan
 * `bash-substitution-reachable-ceiling-2026-08-01` extracts Bash `tool_use`
 * blocks from these same transcripts (`bash-substitution/corpus.ts`). This is a
 * second EXTRACT of the same corpus, not a second corpus — it reads the same
 * files and adds no new collection path.
 *
 * Usage: node scripts/measure-context-token-baseline.mjs [days] [outJsonPath]
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DAYS = Number(process.argv[2] || 6);
const OUT = process.argv[3] || '/tmp/context-token-baseline.json';
const CUTOFF = Date.now() - DAYS * 86400_000;
const ROOTS = [join(homedir(), '.claude', 'projects'), join(homedir(), '.papercusp', 'session-claude')];
/** chars→tokens estimate. Labelled everywhere it is used; never presented as a count. */
const CPT = 4;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/** Length of a tool_result's content, which may be a string or a block array. */
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let n = 0;
  for (const b of content) {
    if (typeof b === 'string') n += b.length;
    else if (b && typeof b.text === 'string') n += b.text.length;
    else if (b) n += JSON.stringify(b).length;
  }
  return n;
}

/** P-011: the doored-result population, bucketed by the shape the D-012 footer branches on. */
const doorFooters = { total: 0, json: 0, 'multi-line-text': 0, 'single-line-text': 0 };
/** Concatenated text of a tool_result's block array (the string case is handled inline). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
}

const byKind = new Map(); // kind -> {chars, blocks}
const byTool = new Map(); // tool -> {useChars, resultChars, calls, results}
const perSession = []; // {file, chars}
let files = 0;
let lines = 0;
let badLines = 0;

function bump(map, key, field, n) {
  let row = map.get(key);
  if (!row) map.set(key, (row = {}));
  row[field] = (row[field] || 0) + n;
}

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < CUTOFF) continue;
    files += 1;
    const idToName = new Map();
    let sessionChars = 0;
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines += 1;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        badLines += 1;
        continue;
      }
      const msg = rec?.message;
      if (!msg || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
      const content = msg.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        let kind = b.type;
        let chars = 0;
        if (kind === 'text') chars = typeof b.text === 'string' ? b.text.length : 0;
        else if (kind === 'thinking') chars = typeof b.thinking === 'string' ? b.thinking.length : 0;
        else if (kind === 'tool_use') {
          chars = (b.name?.length || 0) + (b.input ? JSON.stringify(b.input).length : 0);
          if (b.id && b.name) idToName.set(b.id, b.name);
          bump(byTool, b.name || '(unnamed)', 'useChars', chars);
          bump(byTool, b.name || '(unnamed)', 'calls', 1);
        } else if (kind === 'tool_result') {
          chars = resultChars(b.content);
          const name = idToName.get(b.tool_use_id) || '(unmatched)';
          bump(byTool, name, 'resultChars', chars);
          bump(byTool, name, 'results', 1);
          // P-011: how many results the door actually cut, and what SHAPE they
          // were — the population the D-012 footer change acts on. Classified
          // from the KEPT head (the transcript holds the doored text, not the
          // original), which is why this is a shape heuristic and is reported
          // as one: leading `{`/`[` after trim, plus the kept head's line count.
          const text = typeof b.content === 'string' ? b.content : resultText(b.content);
          const at = text.indexOf('[result-door:');
          if (at >= 0) {
            doorFooters.total += 1;
            const head = text.slice(0, at).trim();
            const jsonish = head.startsWith('{') || head.startsWith('[');
            const oneLine = !head.includes('\n');
            const bucket = jsonish ? 'json' : oneLine ? 'single-line-text' : 'multi-line-text';
            doorFooters[bucket] = (doorFooters[bucket] || 0) + 1;
            bump(byTool, name, 'doored', 1);
          }
        } else {
          kind = `other:${String(kind).slice(0, 24)}`;
          chars = JSON.stringify(b).length;
        }
        bump(byKind, kind, 'chars', chars);
        bump(byKind, kind, 'blocks', 1);
        sessionChars += chars;
      }
    }
    perSession.push({ file: file.slice(-60), chars: sessionChars });
  }
}

const total = [...byKind.values()].reduce((a, r) => a + (r.chars || 0), 0);
const kinds = [...byKind.entries()]
  .map(([kind, r]) => ({
    kind,
    blocks: r.blocks || 0,
    chars: r.chars || 0,
    estTokens: Math.round((r.chars || 0) / CPT),
    pct: total ? +((100 * (r.chars || 0)) / total).toFixed(2) : 0,
  }))
  .sort((a, b) => b.chars - a.chars);
const toolResultTotal = [...byTool.values()].reduce((a, r) => a + (r.resultChars || 0), 0);
const toolsTop = [...byTool.entries()]
  .map(([tool, r]) => ({
    tool,
    calls: r.calls || 0,
    results: r.results || 0,
    useChars: r.useChars || 0,
    resultChars: r.resultChars || 0,
    estResultTokens: Math.round((r.resultChars || 0) / CPT),
    pctOfToolResults: toolResultTotal ? +((100 * (r.resultChars || 0)) / toolResultTotal).toFixed(2) : 0,
    avgResultChars: r.results ? Math.round((r.resultChars || 0) / r.results) : 0,
  }))
  .sort((a, b) => b.resultChars - a.resultChars)
  .slice(0, 25);
const sessionTokens = perSession.map((s) => s.chars / CPT).sort((a, b) => a - b);
const q = (p) => (sessionTokens.length ? Math.round(sessionTokens[Math.min(sessionTokens.length - 1, Math.floor(p * sessionTokens.length))]) : 0);

const summary = {
  measuredAt: new Date().toISOString(),
  windowDays: DAYS,
  method: 'raw claude transcript JSONL, per content block; chars/4 is an ESTIMATE, not a token count',
  caveat:
    'Counts each block ONCE, as it first entered the window. The BILLED cost is far higher: the whole window is re-sent every turn.',
  files,
  lines,
  badLines,
  totalChars: total,
  totalEstTokens: Math.round(total / CPT),
  perSessionEstTokens: { n: sessionTokens.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
  byKind: kinds,
  topToolsByResultChars: toolsTop,
  doorFooters,
};
await writeFile(OUT, JSON.stringify({ ...summary, perSession }, null, 2));
console.log(JSON.stringify(summary, null, 2));

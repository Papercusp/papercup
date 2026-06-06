/**
 * Token-count benchmark (token-efficient-tool-result-formats P-003).
 *
 * Sizes the JSON → TOON → CSV token win on payloads shaped like our three
 * proof tools (`work_items:list`, `audit:list`, `harness:status`) using a real
 * BPE tokenizer (`o200k_base` — a reasonable proxy for the frontier tokenizers
 * our Opus/Sonnet agents use; the RELATIVE ratios are what matter). It prints a
 * comparison table and asserts the win as a regression guard so a future TOON/
 * encoder change that erases the savings fails loudly.
 *
 * Run: `npx vitest run result-format-benchmark` (from packages/agent-mcp).
 */
import { describe, it, expect } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import { encode, type ResultFormat } from '@papercusp/result-encoding';

const enc = getEncoding('o200k_base');
const tok = (s: string): number => enc.encode(s).length;

/** Encode `data` as the serializer would (compact formats carry the marker line). */
function serialized(data: unknown, format: ResultFormat): string {
  const body = encode(data, format);
  return format === 'json' ? body : `format: ${format}\n${body}`;
}

interface Row {
  format: ResultFormat;
  tokens: number;
  savedPct: number;
}

function bench(label: string, data: unknown, formats: ResultFormat[]): Record<ResultFormat, number> {
  const jsonTok = tok(serialized(data, 'json'));
  const out: Partial<Record<ResultFormat, number>> = {};
  const rows: Row[] = [];
  for (const f of formats) {
    const t = tok(serialized(data, f));
    out[f] = t;
    rows.push({ format: f, tokens: t, savedPct: 100 * (1 - t / jsonTok) });
  }
  const size = Array.isArray(data) ? `${data.length} rows` : '1 object';
  // eslint-disable-next-line no-console
  console.log(`\n── ${label} (${size}) — json baseline ${jsonTok} tok`);
  for (const r of rows) {
    const saved = r.format === 'json' ? '   —  ' : `${r.savedPct >= 0 ? '-' : '+'}${Math.abs(r.savedPct).toFixed(1)}%`;
    // eslint-disable-next-line no-console
    console.log(`   ${r.format.padEnd(4)} ${String(r.tokens).padStart(6)} tok   ${saved}`);
  }
  return out as Record<ResultFormat, number>;
}

/* ─── Fixtures shaped like the real proof-tool payloads ──────────────── */

const KINDS = ['feature', 'bug', 'change', 'chunk', 'research-task', 'task'];
const STATES = ['todo', 'validating', 'passed', 'failing', 'deprecated', 'wip'];

function workItems(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `WI-${String(i + 1).padStart(3, '0')}`,
    kind: KINDS[i % KINDS.length],
    family: i % 3 === 0 ? 'issue' : 'feature',
    harness: i % 4 === 0 ? null : `harness-${i % 5}`,
    title: `Implement the ${KINDS[i % KINDS.length]} for subsystem ${i % 9}`,
    summary: `A concise summary of work item ${i + 1} describing the change in one line.`,
    state: STATES[i % STATES.length],
    assignee: i % 2 === 0 ? `su-${(i * 7) % 1000}` : null,
    assignedBy: i % 5 === 0 ? `su-${(i * 3) % 1000}` : null,
    severity: i % 3 === 0 ? ['low', 'medium', 'high'][i % 3] : null,
    parent: i % 6 === 0 ? `WI-${String(i).padStart(3, '0')}` : null,
    payload: null,
    createdAt: `2026-06-0${(i % 6) + 1}T0${i % 9}:12:33.000Z`,
    updatedAt: `2026-06-0${(i % 6) + 1}T1${i % 9}:45:01.000Z`,
  }));
}

function auditRows(n: number): unknown[] {
  const actions = ['work_item.claim', 'work_item.complete', 'plan.revision', 'lock.acquire', 'spawn.admit'];
  return Array.from({ length: n }, (_, i) => ({
    id: `audit_${(i * 1009).toString(36)}`,
    ts: 1_780_000_000_000 + i * 53_117,
    actor: `su-${(i * 31) % 1000}`,
    action: actions[i % actions.length],
    subject: `WI-${String((i % 40) + 1).padStart(3, '0')}`,
  }));
}

function harnessStatus(): unknown {
  return {
    slug: 'papercup',
    status: 'active',
    updated_ts: 1_780_456_789_000,
    spent_cents: 4231,
    budget_cents: 50000,
    path: '/home/marsh-office/papercupai-workspace/papercup',
    source: 'project',
    recentActivity: Array.from({ length: 10 }, (_, i) => ({
      ts: 1_780_456_000_000 + i * 60_000,
      action: ['feature.pass', 'review.return', 'chunk.complete'][i % 3],
      actor: `su-${(i * 17) % 1000}`,
      subject: `F-${String(i + 1).padStart(3, '0')}`,
    })),
  };
}

describe('result-format token benchmark', () => {
  it('work_items:list — flat array (payload null) — TOON cuts tokens vs JSON', () => {
    const data = workItems(30);
    const r = bench('work_items:list', data, ['json', 'toon', 'csv']);
    // The list-shaped win: TOON well under JSON, CSV under TOON. Thresholds are
    // the measured floor on realistic (high-entropy) rows — the structural
    // savings shrink as value entropy rises, so the guard is "a real win", not
    // the plan's optimistic headline.
    expect(r.toon).toBeLessThan(r.json * 0.8);
    expect(r.csv).toBeLessThan(r.toon);
  });

  it('audit:list (summary) — purely flat — TOON and CSV both cut tokens', () => {
    const data = auditRows(50);
    const r = bench('audit:list', data, ['json', 'toon', 'csv']);
    expect(r.toon).toBeLessThan(r.json * 0.8);
    expect(r.csv).toBeLessThan(r.json * 0.75);
    expect(r.csv).toBeLessThan(r.toon);
  });

  it('harness:status — single nested object — measured (JSON stays the default)', () => {
    const data = harnessStatus();
    const r = bench('harness:status', data, ['json', 'toon']);
    // A single nested object is the case where TOON's win is marginal — this is
    // exactly why the eligibility analyzer keeps non-arrays on JSON by default.
    // We only assert TOON isn't pathologically worse; we do NOT auto-pick it.
    expect(r.toon).toBeLessThan(r.json * 1.1);
  });
});

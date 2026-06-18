import { describe, expect, it, vi } from 'vitest';
import { buildGdpvalBrief, collectOutputFileNames, generateGdpvalDeliverable, GDPVAL_AGENT_SYSTEM, type GdpvalGenerationDeps } from './agent';
import type { GaiaToolset, LlmFn } from '../gaia/agent';

describe('gdpval agent — buildGdpvalBrief', () => {
  it('includes the prompt + the produce-files instruction', () => {
    const b = buildGdpvalBrief('Write an audit memo', []);
    expect(b).toContain('Write an audit memo');
    expect(b).toMatch(/file\(s\) in your current working directory/);
    expect(b).not.toContain('staged'); // no inputs → no staged-files note
  });
  it('notes staged input files when present', () => {
    const b = buildGdpvalBrief('Analyze the data', ['Population.xlsx', 'notes.txt']);
    expect(b).toContain('Population.xlsx, notes.txt');
    expect(b).toContain('staged');
  });
});

describe('gdpval agent — collectOutputFileNames', () => {
  it('returns files created during the run (not staged inputs), sorted', () => {
    expect(collectOutputFileNames(['input.csv', 'report.md', 'chart.png'], ['input.csv'])).toEqual(['chart.png', 'report.md']);
  });
  it('empty when nothing new was created', () => {
    expect(collectOutputFileNames(['input.csv'], ['input.csv'])).toEqual([]);
  });
});

describe('gdpval agent — GDPVAL_AGENT_SYSTEM', () => {
  it('instructs the agent to actually write files, not describe them', () => {
    expect(GDPVAL_AGENT_SYSTEM).toMatch(/PRODUCE THE ACTUAL DELIVERABLE AS FILE/);
    expect(GDPVAL_AGENT_SYSTEM).toMatch(/graded BLIND/);
  });
});

describe('gdpval agent — generateGdpvalDeliverable', () => {
  // A fake LLM that produces no tool calls → runGaiaAgent finishes immediately (the agent "already wrote files").
  const doneLlm: LlmFn = async () => ({
    content: [{ type: 'text', text: 'Created report.md with the full deliverable.' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 20, outputTokens: 8 },
  });
  const emptyTools: GaiaToolset = { specs: [], handlers: {} };

  it('drives the agent with the GDPval system prompt and reduces the created files to deliverable text', async () => {
    const files = new Map([
      ['input.csv', 'a,b\n1,2'],
      ['report.md', '# Quarterly Audit\nAll balances tied out.'],
    ]);
    const deps: GdpvalGenerationDeps = {
      llm: doneLlm,
      tools: emptyTools,
      scratchDir: '/scratch',
      stagedInputFiles: ['input.csv'],
      listFiles: async () => [...files.keys()],
      readFileBytes: async (p) => new TextEncoder().encode(files.get(p.split('/').pop()!) ?? ''),
      officeExtract: async () => { throw new Error('should not be called for .md'); },
    };
    const r = await generateGdpvalDeliverable({ instanceId: 't1', prompt: 'Audit the books' }, deps);
    expect(r.outputFiles).toEqual(['report.md']); // input.csv excluded as a staged input
    expect(r.deliverableText).toContain('## report.md');
    expect(r.deliverableText).toContain('All balances tied out');
    expect(r.excluded).toEqual([]);
    expect(r.agent.stopReason).toBe('done');
  });

  it('excludes a created binary file (judge can not read it) but still returns the readable ones', async () => {
    const deps: GdpvalGenerationDeps = {
      llm: doneLlm,
      tools: emptyTools,
      scratchDir: '/s',
      stagedInputFiles: [],
      listFiles: async () => ['summary.md', 'diagram.png'],
      readFileBytes: async () => new TextEncoder().encode('content'),
      officeExtract: async () => 'x',
    };
    const r = await generateGdpvalDeliverable({ instanceId: 't2', prompt: 'p' }, deps);
    expect(r.outputFiles).toEqual(['diagram.png', 'summary.md']);
    expect(r.deliverableText).toContain('## summary.md');
    expect(r.excluded.map((e) => e.file)).toEqual(['diagram.png']);
  });

  it('retries once with a forceful brief when the first run yields an empty deliverable', async () => {
    let listCalls = 0;
    const deps: GdpvalGenerationDeps = {
      llm: doneLlm,
      tools: emptyTools,
      scratchDir: '/s',
      stagedInputFiles: [],
      // empty on the first run, a file appears on the retry
      listFiles: async () => (++listCalls >= 2 ? ['report.md'] : []),
      readFileBytes: async () => new TextEncoder().encode('the retried deliverable'),
      officeExtract: async () => 'x',
    };
    const r = await generateGdpvalDeliverable({ instanceId: 't', prompt: 'p' }, deps);
    expect(listCalls).toBeGreaterThanOrEqual(2); // it retried
    expect(r.deliverableText).toContain('the retried deliverable');
  });

  it('does not retry when retryOnEmpty is false', async () => {
    let listCalls = 0;
    const deps: GdpvalGenerationDeps = {
      llm: doneLlm,
      tools: emptyTools,
      scratchDir: '/s',
      stagedInputFiles: [],
      retryOnEmpty: false,
      listFiles: async () => { listCalls++; return []; },
      readFileBytes: async () => new Uint8Array(),
      officeExtract: async () => '',
    };
    const r = await generateGdpvalDeliverable({ instanceId: 't', prompt: 'p' }, deps);
    expect(r.deliverableText).toBe('');
    expect(listCalls).toBe(1); // no retry
  });

  it('empty deliverable when the agent created no files', async () => {
    const deps: GdpvalGenerationDeps = {
      llm: doneLlm,
      tools: emptyTools,
      scratchDir: '/s',
      stagedInputFiles: ['in.txt'],
      listFiles: async () => ['in.txt'],
      readFileBytes: async () => new Uint8Array(),
      officeExtract: async () => '',
    };
    const r = await generateGdpvalDeliverable({ instanceId: 't3', prompt: 'p' }, deps);
    expect(r.outputFiles).toEqual([]);
    expect(r.deliverableText).toBe('');
  });
});

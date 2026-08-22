import { describe, expect, it } from 'vitest';
import {
  FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT,
  MEASURED_SUMMARY_BUDGET_CHARS,
  ORCHESTRATION_BENCHMARK_CORPUS,
  ORCHESTRATION_WORKFLOW_CLASSES,
  SUMMARY_BUDGET_BUCKET_CHARS,
  authoredSummarySerializedChars,
  classifyFunctionsExecSource,
  clientResidueBounds,
  deriveMeasuredSummaryBudgetChars,
} from './orchestration-benchmark-corpus';

describe('P-002 deterministic orchestration benchmark corpus', () => {
  it('covers the frozen incident and every required synthetic workflow class', () => {
    expect(ORCHESTRATION_BENCHMARK_CORPUS[0]?.id).toBe('incident-01a02a75-nine-read-fanout');
    expect(new Set(ORCHESTRATION_BENCHMARK_CORPUS.map((entry) => entry.workflowClass))).toEqual(
      new Set(ORCHESTRATION_WORKFLOW_CLASSES),
    );
    for (const workflowClass of ORCHESTRATION_WORKFLOW_CLASSES) {
      expect(
        ORCHESTRATION_BENCHMARK_CORPUS.some(
          (entry) => entry.source.kind === 'synthetic' && entry.workflowClass === workflowClass,
        ),
        `missing synthetic ${workflowClass} case`,
      ).toBe(true);
    }
  });

  it('pins the raw 01a02a75 incident measurements and the eight-plus-outer call accounting', () => {
    const incident = ORCHESTRATION_BENCHMARK_CORPUS[0];
    expect(incident.source).toMatchObject({
      kind: 'live-incident',
      sessionId: '01a02a75-9c18-78d1-b986-22826dd0310f',
      callId: 'call_9VFyMvWRue3Ya2paBhrGwnpR',
      rawResolver: 'session_ingest_state.file_path',
    });
    expect(incident.metrics).toEqual({
      intermediateBytes: 32_485,
      intermediateResultBytes: [2449, 5842, 5842, 2440, 3271, 1986, 5976, 4679],
      returnedContextBytes: 35_336,
      returnedContextChars: 35_265,
      toolCalls: 9,
      latencyMs: 9_488,
      latencyBasis: 'raw-rollout-timestamps',
    });
    expect(incident.metrics.intermediateResultBytes).toHaveLength(8);
    expect(incident.expectedEvidenceFacts).toHaveLength(8);
  });

  it('records every metric and labels synthetic latency as unmeasured', () => {
    for (const entry of ORCHESTRATION_BENCHMARK_CORPUS) {
      expect(entry.metrics.intermediateBytes).toBe(
        entry.metrics.intermediateResultBytes.reduce((sum, bytes) => sum + bytes, 0),
      );
      expect(entry.metrics.returnedContextBytes).toBeGreaterThan(0);
      expect(entry.metrics.returnedContextChars).toBeGreaterThan(0);
      expect(entry.metrics.toolCalls).toBeGreaterThan(0);
      expect(entry.currentBackendBehavior.length).toBeGreaterThan(20);
      expect(entry.replayability.reason.length).toBeGreaterThan(20);
      expect(entry.dataSafety.note.length).toBeGreaterThan(20);
      expect(entry.authoredSummary.length).toBeGreaterThan(20);
      expect(entry.expectedEvidenceFacts.length).toBeGreaterThan(0);

      if (entry.source.kind === 'synthetic') {
        expect(entry.metrics.latencyMs).toBeNull();
        expect(entry.metrics.latencyBasis).toBe('not-measured-synthetic');
      }
    }
  });

  it('derives the shipped summary budget from gold summaries rather than a pre-picked default', () => {
    const measuredMaximum = Math.max(
      ...ORCHESTRATION_BENCHMARK_CORPUS.map(authoredSummarySerializedChars),
    );
    expect(MEASURED_SUMMARY_BUDGET_CHARS).toBe(deriveMeasuredSummaryBudgetChars());
    expect(MEASURED_SUMMARY_BUDGET_CHARS).toBe(
      Math.ceil(measuredMaximum / SUMMARY_BUDGET_BUCKET_CHARS) * SUMMARY_BUDGET_BUCKET_CHARS,
    );
    expect(measuredMaximum).toBeLessThanOrEqual(MEASURED_SUMMARY_BUDGET_CHARS);
    expect(measuredMaximum).toBeGreaterThan(MEASURED_SUMMARY_BUDGET_CHARS - SUMMARY_BUDGET_BUCKET_CHARS);
  });

  it('keeps secret-like values and exact ephemeral identifiers out of authored summaries', () => {
    const forbidden = [
      /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i,
      /01a02a75-9c18-78d1-b986-22826dd0310f/,
      /call_9VFyMvWRue3Ya2paBhrGwnpR/,
      /\/home\//,
    ];
    for (const entry of ORCHESTRATION_BENCHMARK_CORPUS) {
      for (const pattern of forbidden) expect(entry.authoredSummary).not.toMatch(pattern);
    }
  });
});

describe('functions.exec client-only residue measurement', () => {
  it('classifies PTY/session, client tools, multimodal emits, and isolate runtime primitives', () => {
    expect(classifyFunctionsExecSource('await tools.exec_command({ cmd: "pwd" })')).toMatchObject({
      ptySession: true,
      clientOnlyResidue: true,
    });
    expect(classifyFunctionsExecSource('const x = await tools.view_image({ path: p }); image(x.image_url)')).toMatchObject({
      clientTool: true,
      multimodalEmit: true,
      clientOnlyResidue: true,
    });
    expect(classifyFunctionsExecSource('store("cursor", 3); yield_control()')).toMatchObject({
      clientRuntime: true,
      clientOnlyResidue: true,
    });
    expect(classifyFunctionsExecSource('const x = await tools.mcp__papercusp_su__plans_get(args); text(x)')).toEqual({
      ptySession: false,
      clientTool: false,
      multimodalEmit: false,
      clientRuntime: false,
      clientOnlyResidue: false,
    });
  });

  it('freezes a bounded live population and reports honest lower/upper residue bounds', () => {
    const bounds = clientResidueBounds();
    expect(FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT.totalCalls).toBe(235_074);
    expect(bounds.lowerCalls).toBe(147_103);
    expect(bounds.upperCalls).toBe(153_635);
    expect(bounds.lowerFraction).toBeCloseTo(0.6258, 4);
    expect(bounds.upperFraction).toBeCloseTo(0.6536, 4);
    expect(FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT.truncatedUnclassifiedCalls).toBeLessThan(
      FUNCTIONS_EXEC_CLIENT_RESIDUE_SNAPSHOT.truncatedCalls,
    );
  });
});

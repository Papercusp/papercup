import { describe, expect, it } from 'vitest';
import {
  accountOutputContentItem,
  buildOutputEnvelope,
  DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS,
  OUTPUT_ENVELOPE_SCHEMA_VERSION,
  type OutputReferenceContentItem,
} from './output-envelope';

const reference: OutputReferenceContentItem = {
  kind: 'reference',
  uri: 'papercusp://scratch/ws/code:run/run/result.json',
  preview: 'first bytes',
  byteCount: 42,
  sha256: 'a'.repeat(64),
  audience: 'owner',
};

describe('buildOutputEnvelope', () => {
  it('preserves the script-authored summary and exposes measured accounting', () => {
    const out = buildOutputEnvelope(
      { summary: 'authored result', content: [reference], metrics: { durationMs: 12, toolCalls: 3 } },
      { summaryBudgetChars: 64 },
    );

    expect(out).toMatchObject({
      schemaVersion: OUTPUT_ENVELOPE_SCHEMA_VERSION,
      summary: 'authored result',
      summaryProvenance: 'authored',
      state: 'complete',
      metrics: { durationMs: 12, toolCalls: 3 },
      accounting: { summaryChars: 15, summaryBudgetChars: 64 },
    });
    expect(out.accounting.summaryBytes).toBe(Buffer.byteLength('authored result'));
    expect(out.accounting.contentBytes).toBe(accountOutputContentItem(reference));
    expect(out.accounting.totalBytes).toBe(
      out.accounting.summaryBytes + out.accounting.contentBytes,
    );
  });

  it('rejects an oversized authored summary instead of truncating or summarizing it', () => {
    expect(() => buildOutputEnvelope({ summary: '12345' }, { summaryBudgetChars: 4 })).toThrow(
      'authored summary is 5 chars; budget is 4',
    );
  });

  it('D-023 pins the measured default at 1,250 authored characters', () => {
    expect(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS).toBe(1_250);
    expect(buildOutputEnvelope({ summary: 'x'.repeat(1_250) }).accounting).toMatchObject({
      summaryChars: 1_250,
      summaryBudgetChars: 1_250,
    });
    expect(() => buildOutputEnvelope({ summary: 'x'.repeat(1_251) })).toThrow(
      'authored summary is 1251 chars; budget is 1250',
    );
  });

  it('requires explicit detail for incomplete and error states', () => {
    expect(() =>
      buildOutputEnvelope({ summary: '', state: 'incomplete' }, { summaryBudgetChars: 0 }),
    ).toThrow('incomplete state requires incomplete detail');
    expect(() =>
      buildOutputEnvelope({ summary: '', state: 'error' }, { summaryBudgetChars: 0 }),
    ).toThrow('error state requires error detail');

    expect(
      buildOutputEnvelope(
        { summary: '', state: 'incomplete', incomplete: { reason: 'overflow', omittedItems: 2 } },
        { summaryBudgetChars: 0 },
      ).state,
    ).toBe('incomplete');
  });

  it('validates stable reference byte count and SHA-256 metadata', () => {
    expect(() =>
      buildOutputEnvelope(
        { summary: '', content: [{ ...reference, sha256: 'not-a-digest' }] },
        { summaryBudgetChars: 0 },
      ),
    ).toThrow('sha256');
    expect(() =>
      buildOutputEnvelope(
        { summary: '', content: [{ ...reference, byteCount: -1 }] },
        { summaryBudgetChars: 0 },
      ),
    ).toThrow('byteCount');
  });

  it('validates and accounts explicit replay state without hiding it in metrics', () => {
    const replayState = {
      kind: 'replay-state' as const,
      values: { cursor: 2, filters: ['open'], nested: { enabled: true } },
    };
    const out = buildOutputEnvelope({ summary: 'continue', content: [replayState] });

    expect(out.content).toEqual([replayState]);
    expect(out.accounting.contentBytes).toBe(accountOutputContentItem(replayState));
    expect(out.metrics).toEqual({});
  });

  it('rejects replay state that cannot be replayed as JSON', () => {
    expect(() =>
      buildOutputEnvelope({
        summary: '',
        content: [{ kind: 'replay-state', values: { cursor: Number.NaN } }],
      }),
    ).toThrow(/finite number/);
  });
});

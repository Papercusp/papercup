import { describe, expect, it } from 'vitest';
import { recordReportSharingFailure } from '../../../scripts/tauri-surface-verify-report-sharing.mts';

describe('report sharing native failure evidence', () => {
  it('persists the original failure before reading the pre-cleanup UI and operation', async () => {
    const evidence: Record<string, unknown> = { phase: 'published-local-fixture' };
    const writes: Record<string, unknown>[] = [];
    const original = new Error('shared URL never became ready');
    const diagnosis = { ui: { text: 'Restore the dedicated viewer repository before sharing.' },
      status: { rows: [{ phase: 'inactive' }] } };
    await recordReportSharingFailure(evidence, original, async () => {
      expect(writes).toHaveLength(1);
      expect(writes[0].failure).toMatchObject({ phase: 'published-local-fixture', message: String(original) });
      return diagnosis;
    }, () => writes.push(structuredClone(evidence)));
    expect(writes).toHaveLength(2);
    expect(writes[1].failureDiagnostics).toEqual(diagnosis);
    expect(writes[1].failure).toMatchObject({ message: String(original), stack: original.stack });
  });

  it('retains the journey error when the diagnostic transport also fails', async () => {
    const evidence: Record<string, unknown> = { phase: 'shared' };
    const writes: Record<string, unknown>[] = [];
    await recordReportSharingFailure(evidence, new Error('anonymous reader failed'), async () => {
      throw new Error('native bridge unavailable');
    }, () => writes.push(structuredClone(evidence)));
    expect(writes).toHaveLength(2);
    expect(writes[1].failure).toMatchObject({ phase: 'shared', message: 'Error: anonymous reader failed' });
    expect(writes[1].failureDiagnosticError).toBe('Error: native bridge unavailable');
    expect(writes[1]).not.toHaveProperty('failureDiagnostics');
  });
});

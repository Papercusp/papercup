import { join } from 'node:path';
import type { CommandInstrument } from '../rubric-instrument-registry';

export const ENGINEERING_EVIDENCE_RELEASE_INSTRUMENT = 'native-engineering-evidence:final-release';
export function engineeringEvidenceReleaseInstrument(root: string): CommandInstrument {
  return { key: ENGINEERING_EVIDENCE_RELEASE_INSTRUMENT, evaluator: 'command', unit: 'count',
    description: 'Fresh maintained Playwright graph/UI journey on the exact green promoted release artifact, accepted source containment and negative controls; 0 verified, missing/mismatched evidence unknown. Canonical independent acceptance remains separately enforced.',
    argv: [process.execPath, join(root, 'scripts/verify-engineering-evidence-release.mjs'), root], timeoutMs: 16 * 60_000,
    parse(stdout) {
      try {
        const row = JSON.parse(stdout.trim());
        return row.scope === 'native-engineering-evidence-final-release-v1' && row.status === 'pass' && row.plane === 'final-release'
          && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.buildSha ?? '') && /^[a-f0-9]{64}$/.test(row.manifestSha256 ?? '')
          && /^[a-f0-9]{64}$/.test(row.receiptSha256 ?? '') && typeof row.receiptPath === 'string' && row.receiptPath.length > 0
          && typeof row.nonce === 'string' && row.nonce.length > 0 ? 0 : null;
      } catch { return null; }
    },
  };
}

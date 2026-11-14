import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDiscoveryAuditContext } from './plan-declaration-resolvers';


const ref = 'source:observed.ts';
const content = `## Discovery\n\n\`\`\`discovery\n${JSON.stringify({ questions: [],
  findings: [{ id: 'F-1', questions: [], conclusion: 'Retain the measured source observation.',
    evidenceRefs: [ref], dispositions: [{ target: 'section:Discovery', decision: 'unchanged',
      reason: 'Retain the observed source.' }] }], notApplicable: 'Bounded source review.' })}\n\`\`\`\n`;
const options = { repoRoot: null, sql: {} as never, workspaceId: 'workspace-a',
  harnessSlug: 'papercusp', ownerId: 'reader', planSlug: 'subject' };

describe('discovery source-path evidence', () => {
  it('measures an admitted source file even when no research trail was captured', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'discovery-source-no-trail-'));
    const sourcePath = 'observed.ts';
    const sourceText = 'export const observed = true;\n';
    const sourceRef = `source:${sourcePath}`;
    writeFileSync(join(repoRoot, sourcePath), sourceText);

    try {
      const context = await resolveDiscoveryAuditContext(content.replace(ref, sourceRef), null, {
        ...options,
        repoRoot,
      });

      expect(context.evidence).toEqual([{
        ref: sourceRef,
        state: 'current',
        usable: true,
        fingerprint: createHash('sha256').update(sourceText).digest('hex'),
      }]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

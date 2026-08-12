import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import tool from './trace';

describe('release:trace tool contract', () => {
  it('is the read-only release composition surface for every execution/release role', () => {
    expect(tool.name).toBe('release:trace');
    expect(tool.capability).toBe('intel:read');
    const roles = new Set(tool.agentRoles ?? []);
    for (const role of ['operator', 'worker', 'validator', 'reviewer', 'cup', 'release-fixer', 'release-manager']) {
      expect(roles.has(role), role).toBe(true);
    }
  });

  it('does not hold an ambient workspace transaction during reconciliation (EI-20246294559310854)', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('requires path or sha in the published schema even when work_item is supplied (EI-20232784385629302)', () => {
    const missingTarget = tool.args.safeParse({ work_item: 'WI-38026' });
    expect(missingTarget.success).toBe(false);
    if (!missingTarget.success) {
      expect(missingTarget.error.issues[0]).toMatchObject({ code: 'invalid_union' });
    }

    expect(tool.args.safeParse({ path: 'packages/operator-core/lib/agent-tools/release/trace.ts' }).success).toBe(true);
    expect(tool.args.safeParse({ sha: 'abcd', work_item: 'WI-38026' }).success).toBe(true);

    const published = z.toJSONSchema(tool.args as never) as {
      anyOf?: Array<{ required?: string[] }>;
    };
    expect(published.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(['path']) }),
        expect.objectContaining({ required: expect.arrayContaining(['sha']) }),
      ]),
    );
  });
});

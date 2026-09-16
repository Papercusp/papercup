import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { publishDatatypeToCupboard, type PublishDatatypeDeps } from './publish-datatype-core';
import { writeDatatypePackageDir, type DatatypeExportSource } from './datatype-store';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'publish-datatype-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const BET: DatatypeExportSource = {
  id: 'bet',
  title: 'Bet',
  description: 'a wager with odds, stake and a settlement outcome',
  tier: 'generic-kind',
  workItemKind: 'bet',
  selfImprovement: {
    improvements: [{ id: 'calibrate', description: 'tighten the payload schema' }],
    scorecard: [{ metric: 'accuracy', description: 'settled rows that matched' }],
    gym: { signals: ['settled'], rubric: 'did the recorded odds beat the close?' },
  },
};

function deps(over: Partial<PublishDatatypeDeps> = {}): PublishDatatypeDeps {
  return {
    listDatatypes: async () => [BET],
    writePackage: (input, opts) => writeDatatypePackageDir(input, { ...opts, targetDir: scratch() }),
    fetchRepo: vi.fn(async () => ({ id: 42, html_url: 'https://github.com/papercup/datatypes' })) as never,
    publish: vi.fn(async () => ({ ok: true, data: { review_status: 'pending' } })) as never,
    ...over,
  };
}

describe('publishDatatypeToCupboard', () => {
  it('publishes under the ONE Cupboard surface as listing_kind datatype', async () => {
    const d = deps();
    const result = await publishDatatypeToCupboard(
      { datatypeId: 'bet', github_url: 'https://github.com/papercup/datatypes' },
      d,
    );
    expect(result.ok).toBe(true);
    // The consolidation P-027 asks for: one publish path, kind='datatype', which
    // REVIEW_POLICY_KINDS then holds at pending.
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({ listing_kind: 'datatype', listing_ref: 'bet', github_repository_id: 42 }),
    );
  });

  it('resolves the definition from the injected registry, never from the package layer', async () => {
    const result = await publishDatatypeToCupboard(
      { datatypeId: 'not-declared-here', github_url: 'https://github.com/papercup/datatypes' },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('exportOnly materializes the package without contacting the storefront', async () => {
    const d = deps();
    const result = await publishDatatypeToCupboard(
      { datatypeId: 'bet', github_url: 'https://github.com/papercup/datatypes', exportOnly: true },
      d,
    );
    expect(result).toMatchObject({ ok: true, exportedOnly: true });
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.fetchRepo).not.toHaveBeenCalled();
  });

  it('surfaces a refused package as 422 instead of publishing a definition that cannot install', async () => {
    const result = await publishDatatypeToCupboard(
      { datatypeId: 'bet', github_url: 'https://github.com/papercup/datatypes' },
      deps({ listDatatypes: async () => [{ ...BET, selfImprovement: null }] }),
    );
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it('rejects a malformed github_url before writing anything', async () => {
    const result = await publishDatatypeToCupboard({ datatypeId: 'bet', github_url: 'not-a-url' }, deps());
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

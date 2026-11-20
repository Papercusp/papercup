import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';

const requireFromTest = createRequire(import.meta.url);
const pluginPath = requireFromTest.resolve('../../../libs/papercusp/plugins/design-phase/index.cjs');
const requireFromPlugin = createRequire(pluginPath);
const plugin = requireFromTest(pluginPath) as {
  tools: { record_review: (input: object, ctx: object) => Promise<{ content: { text: string }[] }> };
};

it.each([
  { name: 'retains feedback on the earlier edition after a successor is accepted',
    reviewedSpecId: 'original', disposition: 'stale', designStatusAfter: 'accepted', updates: 0 },
  { name: 'applies feedback addressed to the accepted successor',
    reviewedSpecId: 'successor', disposition: 'applied', designStatusAfter: 'pending', updates: 1 },
])('$name', async ({ reviewedSpecId, disposition, designStatusAfter, updates }) => {
  const append = vi.fn();
  const reset = vi.fn(() => [{ design_status: 'pending' }]);
  const tx = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('SELECT design_status, design_spec_id')) {
      return [{ design_status: 'accepted', design_spec_id: 'successor' }];
    }
    if (sql.includes('INSERT INTO harness_shared.harness_design_artifacts')) {
      append(...values);
      return [];
    }
    if (sql.includes('UPDATE harness_shared.harness_features_consolidated')) return reset();
    throw new Error(`Unexpected review query: ${sql}`);
  }, { unsafe: vi.fn(), json: (value: unknown) => value });

  // The CJS plugin requires postgres inside record_review. Substitute only its
  // client for this call so the production handler decides which edition to update.
  requireFromPlugin('postgres');
  const pgModule = requireFromPlugin.cache[requireFromPlugin.resolve('postgres')];
  if (!pgModule) throw new Error('Missing postgres module for the design plugin');
  const client = vi.spyOn(pgModule, 'exports').mockReturnValue({
    begin: (run: (transaction: typeof tx) => unknown) => run(tx), end: vi.fn(),
  });
  try {
    const result = await plugin.tools.record_review(
      { featureId: 'feature', specId: reviewedSpecId, verdict: 'changes-requested', notes: 'Revise the example' },
      { workspaceId: 'workspace', harnessSlug: 'design' },
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, reviewedSpecId, disposition, designStatusAfter });
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]).toContainEqual({ verdict: 'changes-requested', notes: 'Revise the example', reviewedSpecId, disposition });
    expect(reset).toHaveBeenCalledTimes(updates);
  } finally {
    client.mockRestore();
  }
});

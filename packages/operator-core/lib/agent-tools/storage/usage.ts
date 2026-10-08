/**
 * storage:usage — live storage usage by category (storage-settings-page-2026-06-15
 * P-003). Read-only: PG table sizes + age distribution + on-disk `du`, grouped by
 * category with a federation class. Backs the Settings → Storage page's read and
 * lets an agent answer "what's using disk / what's safe to trim".
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { STORAGE_CATEGORIES } from '../../storage/categories';

const STORAGE_CATEGORY_IDS = STORAGE_CATEGORIES.map((category) => category.id) as [string, ...string[]];

export default defineTool({
  name: 'storage:usage',
  profile: 'engineer',
  description:
    'Live storage usage by category (PG tables grouped by federation class + on-disk stores), each with total size, an age distribution, and whether it is safe to trim. Pass category to measure one known category without scanning unrelated stores; omit it for all categories. A size or aggregate is null when the bounded read could not measure every included category. Read-only.',
  capability: 'storage:read',
  guidance: {
    when: 'Inspecting what is consuming local storage, or before a trim. Pass category when you only need one known category so unrelated disk stores are not scanned.',
    notWhen: 'To actually delete, use storage:prune (with dryRun first). This never deletes.',
    chaining: 'For one known category, pass category to storage:usage to avoid unrelated disk scans; omit category to inspect all categories.',
    seeAlso: [
      'storage:prune (actually delete a category — dryRun first)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    category: z.enum(STORAGE_CATEGORY_IDS).optional().describe('One known storage category id; omit to inspect all categories.'),
  }).optional(),
  async handler(args) {
    const { computeStorageUsage, sumStorageUsageTotalBytes } = await import('../../storage/usage');
    const categories = await computeStorageUsage({ categoryId: args?.category });
    const totalBytes = sumStorageUsageTotalBytes(categories);
    return { data: { ok: true, totalBytes, categories } };
  },
});

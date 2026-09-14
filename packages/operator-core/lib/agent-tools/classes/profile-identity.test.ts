import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';

const M = vi.hoisted(() => ({
  buildQueryEmbedderResolved: vi.fn(),
  defineCapabilityClass: vi.fn(),
  listCapabilityClasses: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: 'sql-handle' }),
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedderResolved: M.buildQueryEmbedderResolved,
  interactiveEmbedAcquireBudgetMs: () => 4321,
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-profile-test' }),
}));
vi.mock('../../capability-class-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capability-class-registry-store')>()),
  defineCapabilityClass: M.defineCapabilityClass,
  listCapabilityClasses: M.listCapabilityClasses,
}));

import defineTool from './define';
import listTool from './list';

const CTX = {
  workspaceId: 'workspace-a',
  harnessSlug: 'papercusp',
  role: 'operator',
  signal: new AbortController().signal,
  log: vi.fn(),
  progress: vi.fn(),
} as never;

const CLASS = {
  id: 'crm.email',
  version: '1.0.0',
  ref: 'crm.email@1.0.0',
  workspaceId: 'workspace-a',
  title: 'CRM email',
  description: 'Send customer email.',
  interfaceVerbs: { send: { inputSchema: { type: 'object' } } },
  behavioralSuiteRef: null,
  status: 'active',
  published: false,
  reviewStatus: 'none',
  tags: [],
  hasEmbedding: true,
  embeddingProfile: EMBEDDER_DIM_SPECS.gemma.profileId,
  createdBy: 'su-profile-test',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
};

const DEFINE_ARGS = {
  id: 'crm.email',
  version: '1.0.0',
  title: 'CRM email',
  description: 'Send customer email.',
  verbs: { send: { inputSchema: { type: 'object' } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  M.defineCapabilityClass.mockResolvedValue({
    created: true,
    conflict: false,
    capabilityClass: CLASS,
  });
  M.listCapabilityClasses.mockResolvedValue([]);
});

describe('classes embedding profile identity', () => {
  it('stamps the resolved exact profile on writes and queries', async () => {
    const embed = vi.fn(async () => Array.from({ length: 768 }, () => 0.2));
    M.buildQueryEmbedderResolved.mockResolvedValue({
      mode: 'gemma',
      dims: 768,
      profile: EMBEDDER_DIM_SPECS.gemma,
      embed,
    });

    await defineTool.handler(DEFINE_ARGS, CTX);
    await listTool.handler({ query: 'email' }, CTX);

    expect(M.defineCapabilityClass).toHaveBeenCalledWith(
      'sql-handle',
      expect.objectContaining({
        embedding: expect.any(Array),
        embeddingProfile: EMBEDDER_DIM_SPECS.gemma,
      }),
    );
    expect(M.listCapabilityClasses).toHaveBeenCalledWith(
      'sql-handle',
      'workspace-a',
      expect.objectContaining({
        embedding: expect.any(Array),
        embeddingProfile: EMBEDDER_DIM_SPECS.gemma,
      }),
    );
  });

  it('degrades an equal-width foreign profile to lexical-only without embedding', async () => {
    const embed = vi.fn(async () => Array.from({ length: 768 }, () => 0.2));
    const foreign = {
      ...EMBEDDER_DIM_SPECS.gemma,
      profileId: 'same-width-foreign-space@v1',
    } as const;
    M.buildQueryEmbedderResolved.mockResolvedValue({
      mode: 'gemma',
      dims: 768,
      profile: foreign,
      embed,
    });

    await defineTool.handler(DEFINE_ARGS, CTX);
    await listTool.handler({ query: 'email' }, CTX);

    expect(embed).not.toHaveBeenCalled();
    expect(M.defineCapabilityClass).toHaveBeenCalledWith(
      'sql-handle',
      expect.objectContaining({ embedding: null, embeddingProfile: null }),
    );
    expect(M.listCapabilityClasses).toHaveBeenCalledWith(
      'sql-handle',
      'workspace-a',
      expect.objectContaining({ embedding: null, embeddingProfile: null }),
    );
  });
});

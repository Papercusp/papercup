/**
 * share-finalize route — POST /api/harness/:slug/share/finalize
 *
 * Phase 11 P-077 (the missing finalize link). Turns a private harness into a
 * shared one by writing `.harness/shared.json` + flipping the registry state to
 * shared-{private,public}. This is the step that was missing: the ShareWizard's
 * finalize was a no-op stub, so `.harness/shared.json` was never written and
 * every harness booted `swarm: null` (boot-all's defaultResolveSwarmBinding
 * reads shared.json → keys the swarm binding on github_repository_id). With
 * this route, finalize writes a real shared.json so the next substrate boot
 * joins the Hyperswarm topic and the Hyperbee read-loop (P-031) starts seeing
 * peer ops.
 *
 * Core logic lives in `finalizeShare(args, deps)` (pure-ish, deps injected) so
 * it's unit-testable without fs/registry; the defineTool handler wires the real
 * impls. Mirrors the join-link.ts route pattern.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { resolveProject } from '@/lib/harness-core';
import { writeSharedConfig } from '@/lib/harness/load-shared-config';
import {
  SHARED_HARNESS_CONFIG_SCHEMA_VERSION,
  type SharedHarnessConfig,
  type SharedHarnessPrivacy,
  type SharedHarnessClaimStatus,
} from '@/lib/harness/harness-shared-config-types';
import { generateSwarmTopicHex } from '@/lib/sync/hyperbee/derive-swarm-topic';
import { setHarnessState } from '@/lib/harness-registry';
import { formatHarnessLink } from '@/lib/harness/url-scheme';

export interface FinalizeShareInput {
  slug: string;
  /** GitHub remote in `owner/repo` form. */
  github_remote: string;
  /** Stable GitHub numeric repository id — the canonical swarm-binding key. */
  github_repository_id: number;
  /** Default 'shared-private'. */
  privacy?: SharedHarnessPrivacy;
  /** Optional explicit 32-byte hex topic; generated if absent. */
  topic?: string;
  /** Default 'unclaimed'. */
  claim_status?: SharedHarnessClaimStatus;
  discord_channel_url?: string;
}

export interface FinalizeShareResult {
  ok: true;
  harnessLink: string;
  topic: string;
  github_repository_id: number;
  state: SharedHarnessPrivacy;
}

export interface FinalizeShareDeps {
  /** Resolve a harness slug → its on-disk project dir. */
  resolveProjectDir: (slug: string) => Promise<string | null>;
  writeShared: (projectDir: string, config: SharedHarnessConfig) => Promise<void>;
  setState: (slug: string, state: SharedHarnessPrivacy) => Promise<void>;
  genTopic: () => string;
  nowIso: () => string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Write `.harness/shared.json` for `slug` + flip its registry state. Returns
 * the harness link to display. Throws on a missing harness / invalid input so
 * the route maps it to a 4xx — never silently writes a half-shared harness.
 */
export async function finalizeShare(
  input: FinalizeShareInput,
  deps: FinalizeShareDeps,
): Promise<FinalizeShareResult> {
  const slug = input.slug;
  if (!slug) throw new Error('finalizeShare: slug required');

  const remote = (input.github_remote ?? '').trim();
  if (!remote) {
    // A harness with no GitHub remote can't be shared — the swarm binding keys
    // on the repo id, so there's nothing for peers to converge on.
    throw new Error('finalizeShare: github_remote required (a shared harness needs a GitHub repo)');
  }
  const repoId = input.github_repository_id;
  if (typeof repoId !== 'number' || !Number.isInteger(repoId) || repoId <= 0) {
    throw new Error('finalizeShare: github_repository_id must be a positive integer');
  }

  const projectDir = await deps.resolveProjectDir(slug);
  if (!projectDir) throw new Error(`finalizeShare: unknown harness ${slug}`);

  const privacy: SharedHarnessPrivacy = input.privacy ?? 'shared-private';
  // The topic is cosmetic for gh-backed harnesses (boot derives the real topic
  // from github_repository_id), but shared.json's structural predicate requires
  // a valid 64-char hex, so always write a real one.
  const topic =
    typeof input.topic === 'string' && HEX64.test(input.topic) ? input.topic : deps.genTopic();

  const config: SharedHarnessConfig = {
    topic,
    github_remote: remote,
    github_repository_id: repoId,
    privacy,
    claim_status: input.claim_status ?? 'unclaimed',
    created_at: deps.nowIso(),
    schema_version: SHARED_HARNESS_CONFIG_SCHEMA_VERSION,
    ...(input.discord_channel_url ? { discord_channel_url: input.discord_channel_url } : {}),
  };

  await deps.writeShared(projectDir, config);
  await deps.setState(slug, privacy);

  return {
    ok: true,
    harnessLink: formatHarnessLink({ topic, githubOwnerRepo: remote, repoId }),
    topic,
    github_repository_id: repoId,
    state: privacy,
  };
}

const realDeps: FinalizeShareDeps = {
  resolveProjectDir: async (slug) => {
    const project = await resolveProject(slug);
    return project?.path ?? null;
  },
  writeShared: writeSharedConfig,
  setState: (slug, state) => setHarnessState(slug, state),
  genTopic: generateSwarmTopicHex,
  nowIso: () => new Date().toISOString(),
};

const shareFinalizeRoute = defineTool({
  name: 'harness:share-finalize',
  method: 'POST',
  path: '/api/harness/:slug/share/finalize',
  description:
    'Finalize sharing a harness: write .harness/shared.json + flip registry state to shared-{private,public} so it joins the swarm (P-077).',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      github_remote: { type: 'string' },
      github_repository_id: { type: 'number' },
      privacy: { type: 'string', enum: ['shared-private', 'shared-public'] },
      topic: { type: 'string' },
      claim_status: { type: 'string', enum: ['unclaimed', 'claimed', 'stale', 'superseded'] },
      discord_channel_url: { type: 'string' },
    },
    required: ['slug', 'github_remote', 'github_repository_id'],
  },
  handler: async (input: FinalizeShareInput) => finalizeShare(input, realDeps),
});

export default shareFinalizeRoute;

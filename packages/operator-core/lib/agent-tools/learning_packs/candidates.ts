/**
 * learning_packs:candidates — the fleet→pack candidate review queue
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11).
 *
 * Candidates are staged by the recurrence-escalation cross-scope promotion
 * (a lesson recurring across ≥2 scopes) and sit pending until the OWNER
 * decides — never auto-published.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';

export default defineTool({
  name: 'learning_packs:candidates',
  capability: 'memory:read',
  description:
    'List learning-pack item CANDIDATEs — cross-hive recurring lessons the recurrence-escalation loop staged for owner review (default: pending only). Each carries provenance: the friction signature, the scopes it recurred across, the recurrence count, and the source improvement-item ids.',
  guidance: {
    when:
      'The owner asks what fleet lessons await review, or before learning_packs:decide_candidate (the id comes from here).',
    notWhen:
      "To read a hive's installed learnings (learning_packs:list / memory:list) or the pack catalog (learning_packs:list).",
    chaining:
      'learning_packs:decide_candidate { id, action } to adopt into the fleet-lessons pack or dismiss; after an adopt, hives pick the item up via learning_packs:install/upgrade.',
    seeAlso: [
      'learning_packs:decide_candidate (adopt or dismiss a candidate)',
      'learning_packs:upgrade (hives pick up an adopted item)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    status: z
      .enum(['pending', 'adopted', 'dismissed'])
      .optional()
      .describe('Filter by status. Default pending (the review queue).'),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async handler(args) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    // Candidates are GLOBAL (P-002) — no workspace filter; the queue is fleet-wide.
    const { listLearningPackCandidates } = await import('../../learning-packs/candidates');
    const candidates = await listLearningPackCandidates({
      status: args.status ?? 'pending',
      ...(args.limit ? { limit: args.limit } : {}),
    });
    return text({ ok: true, count: candidates.length, candidates });
  },
});

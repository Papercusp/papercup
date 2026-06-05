/**
 * GET /api/user/memory/feedback — read-only stats on memory mutations
 * recorded in harness_shared.memory_feedback. Powers the
 * "you've edited 12 / deleted 4 memories" + activity tail in
 * /settings/user/memory.
 *
 * Ported from app/api/user/memory/feedback/route.ts. `auth: 'public'`.
 */
import { getSessionUser } from '../../../auth';
import { loadFeedbackStats } from '../../../memory/feedback';
import { buildLearningInstructions } from '../../../memory/learning';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/user/memory/feedback',
  auth: 'public',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
    const [stats, learningInstructions] = await Promise.all([
      loadFeedbackStats(user.id, 20),
      buildLearningInstructions().catch(() => null),
    ]);
    return Response.json({
      ...(stats ?? { total_edits: 0, total_deletes: 0, recent: [] }),
      learning_instructions: learningInstructions,
    });
  },
});

/**
 * /api/user/memory/feedback — read-only stats on memory mutations
 * recorded in harness_shared.memory_feedback. Used by
 * /settings/user/memory to surface "you've edited 12 / deleted 4
 * memories" plus a recent activity tail.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { loadFeedbackStats } from '@/lib/memory/feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const stats = await loadFeedbackStats(user.id, 20);
  return NextResponse.json(stats ?? { total_edits: 0, total_deletes: 0, recent: [] });
}

/**
 * GET /api/admin/llm-tests/scenarios
 *
 * Lists every scenario known to the framework. Read directly from the
 * in-process registry — these aren't PG state.
 */

import { NextResponse } from 'next/server';

import { SCENARIOS } from '@/lib/llm-testing/scenarios';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const scenarios = SCENARIOS.map((s) => ({
    id: s.id,
    version: s.version,
    target: s.target,
    description: s.description,
    persona: typeof s.persona === 'string' ? s.persona : 'inline',
    runMatrix: s.runMatrix ?? null,
    realWorkspace: !!s.realWorkspace,
    transport: s.transport ?? 'http-sse',
    rubricVersion: s.rubric.version,
    assertCount: s.asserts.length,
    caps: s.caps,
  }));
  return NextResponse.json({ scenarios });
}

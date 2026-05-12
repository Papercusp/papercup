import { NextResponse } from 'next/server';
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';

export const dynamic = 'force-dynamic';

const KEY = 'setup_wizard_state';

export interface SetupWizardState {
  step_status: Record<string, 'dismissed' | 'completed'>;
  last_visited_step?: string;
  finished_at?: string;
  updated_at?: string;
}

const ALLOWED_STATUSES = new Set(['dismissed', 'completed']);

function defaults(): SetupWizardState {
  return { step_status: {} };
}

export async function GET() {
  const state = (await readOperatorState<SetupWizardState>(KEY)) ?? defaults();
  return NextResponse.json(state);
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const current = (await readOperatorState<SetupWizardState>(KEY)) ?? defaults();
  const next: SetupWizardState = { ...current };

  if (typeof body.last_visited_step === 'string') {
    next.last_visited_step = body.last_visited_step;
  }
  if (body.finished_at === null) {
    delete next.finished_at;
  } else if (typeof body.finished_at === 'string') {
    next.finished_at = body.finished_at;
  }
  if (body.step_status && typeof body.step_status === 'object') {
    const merged = { ...current.step_status };
    for (const [k, v] of Object.entries(body.step_status as Record<string, unknown>)) {
      if (v === null) {
        delete merged[k];
        continue;
      }
      if (typeof v === 'string' && ALLOWED_STATUSES.has(v)) {
        merged[k] = v as 'dismissed' | 'completed';
      }
    }
    next.step_status = merged;
  }
  next.updated_at = new Date().toISOString();
  await writeOperatorState(KEY, next);
  return NextResponse.json(next);
}

import { NextRequest, NextResponse } from 'next/server';
import { readOperatorState, writeOperatorState } from '@/lib/operator-state-pg';
import { ensureInstallId } from '@/lib/setup-wizard-install-id';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

/** Resolve a principal or return the 401/403 response. Null = allowed. */
async function gatePrincipal(req: NextRequest): Promise<NextResponse | null> {
  try {
    await requirePrincipal(req.headers);
    return null;
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KEY = 'setup_wizard_state';

export type UpdateChannel = 'alpha' | 'beta' | 'stable';

export interface SetupWizardState {
  step_status: Record<string, 'dismissed' | 'completed'>;
  last_visited_step?: string;
  finished_at?: string;
  update_channel?: UpdateChannel;
  /** Telemetry opt-in. **Off by default** — the wizard's telemetry
   *  step is the only place this flips, and only on explicit user
   *  click. When true, telemetry forwards on the next flush: the
   *  public PostHog host + projectKey are bundled, so opt-in alone is
   *  sufficient (no per-machine admin step). PAPERCUSP_INTERNAL_BUILD
   *  forwards regardless of opt-in for maintainer channels. */
  telemetry_enabled?: boolean;
  /** Per-install random UUID. Set once on first GET, never changes.
   *  Used as the PostHog distinct id so each installation is one
   *  "person" in PostHog regardless of workspace creation/deletion. */
  install_id?: string;
  /** User explicitly intends to use voice in this install — set from
   *  StepKeys' "I plan to use voice" checkbox. Used by Step 8 voice-
   *  devices gating: the wizard walks the voice step when this OR
   *  the ElevenLabs key is set. */
  voice_intent?: boolean;
  updated_at?: string;
}

const ALLOWED_STATUSES = new Set(['dismissed', 'completed']);
const ALLOWED_CHANNELS = new Set<UpdateChannel>(['alpha', 'beta', 'stable']);

function defaults(): SetupWizardState {
  return { step_status: {} };
}

export async function GET(req: NextRequest) {
  const denied = await gatePrincipal(req);
  if (denied) return denied;
  // Mint install_id if missing — shared with telemetry-config so the
  // first event after a fresh boot always has a stable distinct id
  // regardless of which route is hit first.
  await ensureInstallId();
  const state = (await readOperatorState<SetupWizardState>(KEY)) ?? defaults();
  return NextResponse.json(state);
}

export async function PATCH(req: NextRequest) {
  const denied = await gatePrincipal(req);
  if (denied) return denied;
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
  if (typeof body.update_channel === 'string' && ALLOWED_CHANNELS.has(body.update_channel as UpdateChannel)) {
    next.update_channel = body.update_channel as UpdateChannel;
  }
  if (typeof body.telemetry_enabled === 'boolean') {
    next.telemetry_enabled = body.telemetry_enabled;
  }
  if (typeof body.voice_intent === 'boolean') {
    next.voice_intent = body.voice_intent;
  }
  // telemetry_host + telemetry_project_key are gone — PostHog config now
  // comes exclusively from the shared resolver (env or
  // ~/.papercusp/posthog.json), per the V1 PostHog architecture.
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

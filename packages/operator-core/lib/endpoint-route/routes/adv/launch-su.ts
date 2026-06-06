/**
 * POST /api/adv/sessions/launch-su — in-app web launch of a tracked SU
 * session (P-020). The web equivalent of typing `psu` in a terminal:
 * server-spawns a terminal running `psu --no-picker --agent=… …`, which
 * records the adv_sessions row (via bootstrap-su) and exec's the matching
 * `*-su` wrapper. The session then appears in /adv Sessions via the live
 * poll — no sessionId returned synchronously (psu creates the row).
 *
 * Delegating to `psu` (rather than re-deriving the envelope + spawning a
 * wrapper here) keeps a single source of truth for the launch flow.
 *
 * Linux-only server-side spawn, mirroring console-launch.ts. Same-origin
 * (the /adv UI is served by the operator) — no CORS preamble needed.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineTool } from '@papercusp/agent-mcp';
import { isSuAgent } from '../../../su-agents';
import { buildKickoffPromptFile } from '../../../agent-kickoff/prompt-file';
import { validateKickoffKind } from '../../../agent-kickoff/kickoff-kind';
import { isOnPath, shellEscape, spawnInTerminal } from '../../../terminal-spawn';
import { recordAdvSession } from '../../../adv-sessions';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// model fuzzy-match (e.g. `anthropic/claude-opus-4-7`, `gpt-5.5`) + recorded
// session ids — broader than SLUG_RE (slash/colon allowed), still no shell
// metacharacters (shellEscape is the real guard; this rejects the absurd).
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Terminal discovery + spawn live in the shared `terminal-spawn` helper
// (findTerminal/isOnPath/shellEscape/spawnInTerminal) — imported above.

const launchSu = defineTool({
  method: 'POST',
  path: '/adv/sessions/launch-su',
  auth: 'public',
  async handler(req) {
    let body: {
      agent?: string;
      harness_slug?: string | null;
      plan_slug?: string | null;
      // P-032: omp-parity passthroughs (the features the retired
      // buildEngineerOmpLaunchCommand used to provide).
      model?: string | null;
      resume_session_id?: string | null;
      kickoff?: { kind?: string } | null;
      // pui-reactive-session-panes D-006: record a pending workbench launch
      // instead of spawning a terminal — the pui reactively opens the pane that
      // RUNS it (the single launcher). The pane materializes via the roster.
      defer_spawn?: boolean;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return json({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    if (!isSuAgent(body.agent)) {
      return json({ status: 'error', error: 'agent must be one of claude|omp|codex' }, 400);
    }
    const agent = body.agent;
    const harness = body.harness_slug?.trim() || null;
    const plan = body.plan_slug?.trim() || null;
    if (harness && !SLUG_RE.test(harness)) return json({ status: 'error', error: 'invalid harness slug' }, 400);
    if (plan && !SLUG_RE.test(plan)) return json({ status: 'error', error: 'invalid plan slug' }, 400);

    const model = body.model?.trim() || null;
    const resumeSessionId = body.resume_session_id?.trim() || null;
    if (model && !MODEL_RE.test(model)) return json({ status: 'error', error: 'invalid model' }, 400);
    if (resumeSessionId && !SESSION_ID_RE.test(resumeSessionId)) return json({ status: 'error', error: 'invalid resume session id' }, 400);
    const kickoffV = validateKickoffKind(body.kickoff ?? null);
    if (kickoffV.kind === 'error') {
      return json({ status: 'error', error: kickoffV.error }, 400);
    }
    const kickoffKind = kickoffV.value?.kind ?? null;

    if (process.platform !== 'linux') {
      return json({ status: 'error', error: 'server-side spawn only implemented for Linux' }, 501);
    }

    const psuPath = join(homedir(), '.local', 'bin', 'psu');
    const psuRef = existsSync(psuPath) ? psuPath : 'psu';
    if (psuRef === 'psu' && !isOnPath('psu')) {
      return json(
        {
          status: 'error',
          code: 'psu_not_installed',
          error: '`psu` not found on PATH — run apps/operator/scripts/install-standalone-mcp.sh',
        },
        200,
      );
    }

    // Kickoff brief (P-032): generate the curated prompt file server-side
    // (same factory the retired console-launch omp path used) and hand its
    // path to psu, which feeds it to the *-su wrapper as the launch-context
    // (layered onto the engineer playbook). Best-effort — a generation miss
    // just launches without the brief rather than failing the launch.
    let kickoffFile: string | null = null;
    if (kickoffKind === 'new-plan') {
      try {
        kickoffFile = await buildKickoffPromptFile({ kind: 'new-plan', harnessSlug: harness });
      } catch {
        kickoffFile = null;
      }
    }

    // All tokens are fixed flags or validated values; shellEscape is the real
    // guard (the validators above reject shell metacharacters anyway).
    const psuArgs = [psuRef, '--no-picker', `--agent=${agent}`];
    if (harness) psuArgs.push(`--harness=${harness}`);
    psuArgs.push(plan ? `--plan=${plan}` : '--no-plan');
    if (model) psuArgs.push(`--model=${model}`);
    if (resumeSessionId) psuArgs.push(`--resume-session=${resumeSessionId}`);
    if (kickoffFile) psuArgs.push(`--launch-context=${kickoffFile}`);

    // Deferred (D-006): record a pending "workbench launch" instead of spawning a
    // terminal. The pui reactively opens a work-area pane that RUNS `launch_argv`
    // (the single launcher), then marks the row launched. No process starts here.
    if (body.defer_spawn) {
      const label = plan ? `${agent} · ${plan}` : agent;
      const advSessionId = await recordAdvSession({
        planSlug: plan,
        agent,
        mode: 'console',
        cwd: null, // psu cds itself from --harness/--plan (parity with the terminal path)
        label,
        display: 'workbench',
        launchArgv: psuArgs,
      });
      if (advSessionId == null) {
        return json({ status: 'error', error: 'failed to record session' }, 500);
      }
      return json({ status: 'ok', deferred: true, advSessionId, agent, harnessSlug: harness, planSlug: plan });
    }

    const oneliner = `exec ${psuArgs.map(shellEscape).join(' ')}`;

    const spawned = spawnInTerminal({ oneliner, env: process.env });
    if (!spawned.ok) {
      return json({ status: 'error', error: spawned.error }, 500);
    }
    return json({ status: 'ok', agent, harnessSlug: harness, planSlug: plan, terminal: spawned.terminal, pid: spawned.pid });
  },
});

export default [launchSu];

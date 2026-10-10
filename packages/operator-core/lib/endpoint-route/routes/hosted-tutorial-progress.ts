import { defineTool } from '@papercusp/tooldef/define-tool';
import { z } from 'zod';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { exactOriginOr403, jsonError, selectedHostedPrincipal, workspaceHeaderMismatch } from '../hosted-browser-context';
import { authorizeTutorialHelp, authorizeProductTutorialHelp, tutorialAssistanceRequestSchema, tutorialHelpRequestSchema, productTutorialHelpRequestSchema, type TutorialAssistanceRequest } from '../../onboarding/cloud-tutorial-help';
import { readAccountTutorialProgress } from '../../onboarding/cloud-tutorial-progress';
import { isHostedPrincipal } from '../../auth/hosted-principal';
export { HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH, createHostedTutorialProgressRoutes } from './hosted-tutorial-progress-routes';
export const HOSTED_BROWSER_TUTORIAL_HELP_PATH = '/hosted/browser/onboarding/tutorial-help' as const;
export const HOSTED_BROWSER_TUTORIAL_SPEECH_PATH = '/hosted/browser/onboarding/tutorial-speech' as const;

export interface TutorialAssistanceDependencies {
  answer?: (input: TutorialAssistanceRequest, signal: AbortSignal, workspaceId: string) => Promise<string>;
  speech?: (text: string, engine: string, voiceId: string | undefined, signal?: AbortSignal) => Promise<{ audio: ArrayBuffer; contentType: string }>;
}
const speechOptions = {
  engine: z.enum(['kokoro', 'elevenlabs', 'openai', 'cartesia']),
  voiceId: z.string().min(1).max(200).optional(),
};
const speechSchema = z.union([
  tutorialHelpRequestSchema.extend(speechOptions).strict(),
  productTutorialHelpRequestSchema.extend(speechOptions).strict(),
]);

/** Guarded leaves shared by native and prebundled hosts. Each host supplies
 * its maintained execution provider; missing providers fail closed. */
export function createHostedTutorialAssistanceRoutes({ origin, controlPlaneWorkspaceId, runTenant, dependencies = {} }: {
  origin: string; controlPlaneWorkspaceId: string; dependencies?: TutorialAssistanceDependencies;
  runTenant?: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
}) {
  return [HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH].map(path => defineTool({
    method: 'POST', path, auth: { capabilities: [], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
      if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      const csrf = exactOriginOr403(request, origin);
      if (csrf) return csrf;
      const raw: unknown = await request.json().catch(() => null);
      const parsed = (path === HOSTED_BROWSER_TUTORIAL_SPEECH_PATH ? speechSchema : tutorialAssistanceRequestSchema).safeParse(raw);
      if (!parsed.success) return jsonError('invalid_tutorial_context', 400);
      let input: TutorialAssistanceRequest;
      try {
        if (parsed.data.context.version === 3) {
          const scope = { tenantId: principal.activeOrganizationId, userId: principal.userId };
          input = authorizeProductTutorialHelp(scope, {
            expectedScope: parsed.data.expectedScope, context: parsed.data.context, question: parsed.data.question,
          });
          if (!runTenant) return jsonError('tutorial_help_unavailable', 503);
          const record = await runTenant({ principal: {
            kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: principal.userId,
            workspaceId: principal.workspaceId, userId: principal.userId, activeOrganizationId: principal.activeOrganizationId,
            sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
          } }, tx => readAccountTutorialProgress(tx, scope)).catch(() => undefined);
          // Database/tenant-runner diagnostics can contain private scope or
          // connection details. Expose only the public recoverable outage.
          if (record === undefined) return jsonError('tutorial_help_unavailable', 503);
          if (!record || record.currentLessonId !== input.context.step || !['active', 'paused'].includes(record.disposition)) return jsonError('tutorial_lesson_changed', 409);
        } else {
          const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
          if (!selection.ok) return selection.response;
          if (!principal.capabilities.has('workspace:view')) return jsonError('permission_missing', 403);
          input = authorizeTutorialHelp({ tenantId: principal.activeOrganizationId, userId: principal.userId, workspaceId: principal.selectedWorkspaceId! },
            { expectedScope: parsed.data.expectedScope, context: parsed.data.context, question: parsed.data.question });
        }
      } catch { return jsonError('invalid_tutorial_context', 403); }
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      if (signal.aborted) return jsonError('tutorial_help_cancelled', 408);
      try {
        if (path === HOSTED_BROWSER_TUTORIAL_HELP_PATH) {
          if (!dependencies.answer) throw new Error('tutorial_help_unavailable');
          const answer = await dependencies.answer(input, signal, controlPlaneWorkspaceId);
          if (signal.aborted) return jsonError('tutorial_help_cancelled', 408);
          return Response.json({ answer }, { headers: { 'cache-control': 'no-store' } });
        }
        const voice = speechSchema.parse(raw);
        if (!dependencies.speech) throw new Error('tutorial_speech_unavailable');
        const speech = await dependencies.speech(input.question, voice.engine, voice.voiceId, signal);
        if (signal.aborted) return jsonError('tutorial_speech_cancelled', 408);
        return new Response(speech.audio, { headers: { 'content-type': speech.contentType, 'cache-control': 'no-store' } });
      } catch { return jsonError(path === HOSTED_BROWSER_TUTORIAL_HELP_PATH ? 'tutorial_help_unavailable' : 'tutorial_speech_unavailable', 503); }
    },
  }));
}

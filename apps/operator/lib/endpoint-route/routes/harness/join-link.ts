/**
 * POST /api/harness/join-link — Entry 4 harness-link join (P-009).
 *
 * Body: {
 *   slug: string,          // desired harness slug
 *   harnessLinkUrl: string // papercusp://harness?topic=...&github=...&repo_id=...
 *   token: string,         // GitHub OAuth token
 *   githubUserId: number,
 *   githubLogin: string,
 *   keychainId: string,
 *   existingGistId?: string,
 * }
 *
 * Response: { ok: true, state: JoinState } on success.
 * Errors: 400 for bad input, 409 for slug conflict, 502 for join failure.
 *
 * Steps 3/4/5/8 (Hyperswarm/Hyperbee) produce phase_0_pending status but
 * don't fail the request — the client can inspect `state.steps` for detail.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessRegistry, saveHarnessRegistry } from '@/lib/harness-registry';
import { scaffoldHarnessSchema } from '@/lib/scaffold-harness-schema';
import { parseHarnessLink } from '@/lib/harness/url-scheme';
import { joinSharedHarness, JoinStepError } from '@/lib/harness/join-shared-harness';

const joinLink = defineTool({
  method: 'POST',
  path: '/harness/join-link',
  auth: 'public',
  async handler(req) {
    const body = (await req.json()) as Record<string, unknown>;

    const slug = String(body.slug ?? '').trim();
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const harnessLinkUrl = String(body.harnessLinkUrl ?? '').trim();
    const link = parseHarnessLink(harnessLinkUrl);
    if (!link) {
      return Response.json(
        { error: 'invalid harness link URL', code: 'invalid_link' },
        { status: 400 },
      );
    }

    const token = String(body.token ?? '').trim();
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });

    const githubUserId =
      typeof body.githubUserId === 'number' && Number.isInteger(body.githubUserId)
        ? body.githubUserId
        : parseInt(String(body.githubUserId ?? ''), 10);
    if (!githubUserId || githubUserId <= 0) {
      return Response.json({ error: 'githubUserId required', code: 'invalid_user_id' }, { status: 400 });
    }

    const githubLogin = String(body.githubLogin ?? '').trim();
    if (!githubLogin) return Response.json({ error: 'githubLogin required' }, { status: 400 });

    const keychainId = String(body.keychainId ?? '').trim();
    if (!keychainId) return Response.json({ error: 'keychainId required' }, { status: 400 });

    const existingGistId =
      typeof body.existingGistId === 'string' ? body.existingGistId.trim() || undefined : undefined;

    // Slug uniqueness check.
    const reg = await loadHarnessRegistry();
    if (reg.projects.some((p) => p.slug === slug)) {
      return Response.json({ error: 'slug already exists', code: 'slug_conflict' }, { status: 409 });
    }

    // Run the join orchestrator.
    let state;
    try {
      state = await joinSharedHarness({
        link,
        slug,
        token,
        githubUserId,
        githubLogin,
        keychainId,
        existingGistId,
      });
    } catch (e: unknown) {
      if (e instanceof JoinStepError) {
        return Response.json(
          {
            error: e.message,
            code: e.code,
            stepId: e.stepId,
            state: undefined,
          },
          { status: 502 },
        );
      }
      throw e;
    }

    // Register the harness in the workspace registry.
    if (state.cloneDir) {
      reg.projects.push({ slug, path: state.cloneDir });
      await saveHarnessRegistry(reg);

      // Scaffold the harness schema (best-effort — don't fail the join if this fails).
      try {
        await scaffoldHarnessSchema(slug);
      } catch {
        // Non-fatal — harness is still usable without schema.
      }
    }

    return Response.json({ ok: true, state });
  },
});

export default joinLink;

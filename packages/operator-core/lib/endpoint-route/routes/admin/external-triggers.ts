/** Owner-local read/write surface backing /admin/triggers (P-004). */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getSessionUserOrDefault } from '../../../auth';
import {
  disabledExternalTriggerAdminSnapshot,
  loadExternalTriggerAdminSnapshot,
  setExternalTriggerBindingArmed,
  updateExternalTriggerBindingStormPolicy,
} from '../../../external-triggers/admin';
import {
  connectOwnedSlackSource,
  SLACK_APP_MANIFEST_TEMPLATE,
} from '../../../external-triggers/slack';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';

const mutationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('set-armed'),
      id: z.string().uuid(),
      armed: z.boolean(),
      confirm: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('set-storm-policy'),
      id: z.string().uuid(),
      maxRuns: z.number().int().positive().max(1_000_000).nullable(),
      windowSeconds: z
        .number()
        .int()
        .positive()
        .max(31 * 24 * 60 * 60),
    })
    .strict(),
]);

async function enabled(distinctId: string): Promise<boolean> {
  return getFlag(FLAGS.TRIGGERS_ADMIN, distinctId).catch(() => true);
}

const read = defineTool({
  method: 'GET',
  path: '/admin/triggers',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(): Promise<Response> {
    if (!(await enabled('admin:triggers:read'))) {
      return Response.json(disabledExternalTriggerAdminSnapshot());
    }
    const { sql } = getOrgPg();
    return Response.json(await loadExternalTriggerAdminSnapshot(sql, activeWorkspaceId()));
  },
});

const mutate = defineTool({
  method: 'PATCH',
  path: '/admin/triggers',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req): Promise<Response> {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    if (!(await enabled('admin:triggers:write'))) {
      return Response.json(
        { ok: false, error: 'disabled', detail: 'external trigger admin is switched off' },
        { status: 409 },
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be JSON' }, { status: 400 });
    }
    const parsed = mutationSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          error: 'bad_request',
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        },
        { status: 400 },
      );
    }

    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    if (parsed.data.op === 'set-armed') {
      if (parsed.data.confirm !== true) {
        return Response.json(
          {
            ok: false,
            error: 'owner_confirmation_required',
            detail: `${parsed.data.armed ? 'arming' : 'disarming'} a trigger binding requires an explicit owner confirmation`,
            gate: { category: 'schedule-arm', authority: 'owner', reversible: true },
          },
          { status: 409 },
        );
      }
      const binding = await setExternalTriggerBindingArmed(sql, workspaceId, parsed.data.id, parsed.data.armed);
      if (!binding) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
      return Response.json({ ok: true, binding });
    }

    const binding = await updateExternalTriggerBindingStormPolicy(sql, workspaceId, parsed.data.id, {
      maxRuns: parsed.data.maxRuns,
      windowSeconds: parsed.data.windowSeconds,
    });
    if (!binding) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
    return Response.json({ ok: true, binding });
  },
});

const slackManifest = defineTool({
  method: 'GET',
  path: '/admin/triggers/slack/manifest',
  // Provider-token setup stays behind the admin contract's verified/trusted
  // gate; it must not inherit the parent route's cookie-less fallback.
  auth: { trust: ['verified', 'trusted'] },
  async handler(): Promise<Response> {
    return Response.json({ ok: true, manifest: SLACK_APP_MANIFEST_TEMPLATE });
  },
});

const slackConnectSchema = z.object({
  appToken: z.string().min(6).max(2_000),
  botToken: z.string().min(6).max(2_000),
  installSlug: z.string().min(1).max(120).default('papercusp'),
  field: z.string().min(1).max(128).optional(),
  channels: z.array(z.string().min(1).max(80)).max(500).optional(),
}).strict();

const slackConnect = defineTool({
  method: 'POST',
  path: '/admin/triggers/slack/connect',
  // Provider-token setup stays behind the admin contract's verified/trusted
  // gate; it must not inherit the parent route's cookie-less fallback.
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    if (!(await enabled('admin:triggers:write'))) {
      return Response.json({ ok: false, error: 'disabled' }, { status: 409 });
    }
    let raw: unknown;
    try { raw = await req.json(); } catch {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be JSON' }, { status: 400 });
    }
    const parsed = slackConnectSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({
        ok: false,
        error: 'bad_request',
        detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      }, { status: 400 });
    }
    try {
      const user = await getSessionUserOrDefault(req.headers);
      const workspaceId = activeWorkspaceId();
      const source = await connectOwnedSlackSource(getOrgPg().sql, {
        workspaceId,
        ownerUserId: user.id,
        createdBy: `owner:${user.id}`,
        ...parsed.data,
      });
      void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
      return Response.json({ ok: true, source });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: 'slack_connect_failed', detail }, { status: 400 });
    }
  },
});

export default [read, mutate, slackManifest, slackConnect];

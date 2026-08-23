/** Acceptance for the three first-party manifest-only starter trigger packs (P-021). */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir } from './index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PACKS = [
  {
    slug: 'email-draft-responder',
    targetId: 'draft-reply',
    sourceKind: 'gmail',
    eventPattern: 'ext:gmail:message.received',
    oauthField: 'googleWorkspace',
    provider: 'google',
    datatype: 'email-message',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
  },
  {
    slug: 'slack-thread-responder',
    targetId: 'thread-reply',
    sourceKind: 'slack',
    eventPattern: 'ext:slack:mention',
    oauthField: 'slackSocket',
    provider: 'slack',
    datatype: 'chat-message',
    scopes: [
      'app_mentions:read',
      'channels:history',
      'groups:history',
      'im:history',
      'mpim:history',
      'commands',
      'chat:write',
      'connections:write',
    ],
  },
  {
    slug: 'meeting-prep-brief',
    targetId: 'prepare-brief',
    sourceKind: 'gcal',
    eventPattern: 'ext:gcal:event-upcoming',
    oauthField: 'googleWorkspace',
    provider: 'google',
    datatype: 'calendar-event',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
  },
] as const;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe.each(PACKS)('$slug shipped trigger pack', (pack) => {
  it('loads as manifest-only, declares a canonical plan input, and stays disarmed', async () => {
    const dir = resolve(REPO_ROOT, 'libs/papercusp/plugins', pack.slug);
    const result = await loadPluginFromDir(dir, 'global');
    expect('error' in result ? result.error : null).toBeNull();
    expect('skipped' in result ? result.skipped : null).toBeNull();
    if (!('plugin' in result)) return;

    expect((result.plugin as unknown as { __runtime?: string }).__runtime).toBe('manifest-only');
    expect(result.triggerPack).toMatchObject({
      targets: [{ id: pack.targetId, kind: 'plan', path: 'plan.md' }],
      bindings: [{
        source: {
          kind: 'external',
          sourceKind: pack.sourceKind,
          oauthField: pack.oauthField,
        },
        target: pack.targetId,
        eventPattern: pack.eventPattern,
        mapping: { mode: 'payload-context' },
      }],
      edges: [],
    });
    expect(result.triggerPack?.bindings.every((binding) => !('armed' in binding))).toBe(true);
    expect(Number(result.triggerPack?.defaultStormPolicy?.maxRuns)).toBeGreaterThan(0);
    expect(Number(result.triggerPack?.defaultStormPolicy?.windowSeconds)).toBeGreaterThan(0);

    const inputs = object(result.triggerPack?.inputs);
    expect(Object.keys(object(inputs.properties)).length).toBeGreaterThan(0);
    const target = result.triggerPack?.targets[0];
    expect(target?.kind).toBe('plan');
    if (target?.kind === 'plan') {
      const targetProperties = object(target.inputSchema.properties);
      const triggerProperties = object(object(targetProperties.trigger).properties);
      expect(object(triggerProperties.payload).datatype).toBe(pack.datatype);
    }

    const configProperties = object(object(result.plugin.configSchema).properties);
    expect(configProperties[pack.oauthField]).toMatchObject({
      secret: true,
      shareable: false,
      snapshotPolicy: 'strip',
      oauth: { provider: pack.provider, scopes: [...pack.scopes] },
    });
    expect(result.plugin.oauth?.[0]).toMatchObject({
      provider: pack.provider,
      fieldName: pack.oauthField,
      scopes: [...pack.scopes],
    });
  });
});

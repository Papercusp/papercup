/** Reference-fixture acceptance for the manifest-only trigger-pack surface (P-012). */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir } from './index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EMAIL_DRAFT_RESPONDER = resolve(
  REPO_ROOT,
  'libs/papercusp/plugins/email-draft-responder',
);

describe('shipped trigger-pack fixture', () => {
  it('loads as manifest-only, preserves OAuth/share metadata, and stays disarmed', async () => {
    const result = await loadPluginFromDir(EMAIL_DRAFT_RESPONDER, 'global');
    expect('error' in result ? result.error : null).toBeNull();
    expect('skipped' in result ? result.skipped : null).toBeNull();
    if ('plugin' in result) {
      expect((result.plugin as unknown as { __runtime?: string }).__runtime).toBe('manifest-only');
      expect(result.triggerPack).toMatchObject({
        targets: [{ id: 'draft-reply', kind: 'plan', path: 'plan.md' }],
        bindings: [{
          id: 'inbound-email-to-draft',
          source: { kind: 'external', sourceKind: 'gmail', oauthField: 'googleWorkspace' },
          target: 'draft-reply',
          eventPattern: 'ext:gmail:message.received',
          mapping: { mode: 'payload-context' },
        }],
        defaultStormPolicy: { maxRuns: 5, windowSeconds: 60 },
        edges: [],
      });
      expect(result.triggerPack?.bindings.every((binding) => !('armed' in binding))).toBe(true);
      expect(result.plugin.configSchema).toMatchObject({
        properties: {
          googleWorkspace: {
            secret: true,
            shareable: false,
            snapshotPolicy: 'strip',
            oauth: { provider: 'google' },
          },
        },
      });
      expect(result.plugin.oauth?.[0]?.scopes).toEqual([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ]);
    }
  });
});

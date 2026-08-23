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
        source: { kind: 'gmail', oauthField: 'googleWorkspace' },
        plan: { path: 'plan.md' },
        binding: {
          eventPattern: 'ext:gmail:message.received',
          stormPolicy: { maxRuns: 5, windowSeconds: 60 },
        },
      });
      expect(result.triggerPack).not.toHaveProperty('binding.armed');
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

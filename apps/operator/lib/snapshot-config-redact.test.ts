/**
 * Unit tests for plugin-config redaction during snapshot capture.
 *
 * Drives the regression that the snapshot E2E test surfaced 2026-04-30:
 * a real Cloudflare User Token (`cfut_...`) leaked into a published
 * snapshot's manifest because the trufflehog/gitleaks scan didn't catch
 * the token format. The fix: read the plugin's manifest uiSchema and
 * redact any field declared with `ui:widget: "password"` BEFORE the
 * config goes into the snapshot.
 */
import { describe, it, expect } from 'vitest';
import { redactPluginConfig, REDACTION_MARKER } from './snapshot-config-redact';

describe('redactPluginConfig', () => {
  it('redacts a password field declared in uiSchema', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify({
        accountId: 'ABCD1234',
        byoCloudflareToken: 'cfut_realsecrettokenhere1234567890abcdef',
      }),
      uiSchema: {
        byoCloudflareToken: { 'ui:widget': 'password' },
      },
    });
    const parsed = JSON.parse(r.configJson);
    expect(parsed.byoCloudflareToken).toBe(REDACTION_MARKER);
    expect(parsed.accountId).toBe('ABCD1234'); // non-password fields preserved
    expect(r.redactedKeys).toEqual(['byoCloudflareToken']);
  });

  it('redacts multiple password fields', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify({
        primaryToken: 'secret-1',
        backupToken: 'secret-2',
        publicId: 'public',
      }),
      uiSchema: {
        primaryToken: { 'ui:widget': 'password' },
        backupToken: { 'ui:widget': 'password' },
      },
    });
    const parsed = JSON.parse(r.configJson);
    expect(parsed.primaryToken).toBe(REDACTION_MARKER);
    expect(parsed.backupToken).toBe(REDACTION_MARKER);
    expect(parsed.publicId).toBe('public');
    expect(r.redactedKeys.sort()).toEqual(['backupToken', 'primaryToken']);
  });

  it('leaves config alone when uiSchema declares no password fields', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify({ url: 'http://localhost:3055/docs' }),
      uiSchema: {
        url: { 'ui:help': 'Override only for staging.' },
      },
    });
    expect(JSON.parse(r.configJson)).toEqual({ url: 'http://localhost:3055/docs' });
    expect(r.redactedKeys).toEqual([]);
  });

  it('handles missing/null/undefined uiSchema (legacy plugins)', () => {
    const cfg = JSON.stringify({ token: 'secret' });
    expect(redactPluginConfig({ configJson: cfg, uiSchema: undefined }).redactedKeys).toEqual([]);
    expect(redactPluginConfig({ configJson: cfg, uiSchema: null }).redactedKeys).toEqual([]);
    expect(redactPluginConfig({ configJson: cfg, uiSchema: 'not-an-object' }).redactedKeys).toEqual([]);
  });

  it('does not redact a key that is missing from the config', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify({ accountId: 'A' }),
      uiSchema: {
        token: { 'ui:widget': 'password' }, // declared but not in config
      },
    });
    expect(JSON.parse(r.configJson)).toEqual({ accountId: 'A' });
    expect(r.redactedKeys).toEqual([]);
  });

  it('does not redact empty-string / null values (already empty)', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify({ token: '', also: null }),
      uiSchema: {
        token: { 'ui:widget': 'password' },
        also: { 'ui:widget': 'password' },
      },
    });
    const parsed = JSON.parse(r.configJson);
    expect(parsed.token).toBe('');
    expect(parsed.also).toBeNull();
    expect(r.redactedKeys).toEqual([]);
  });

  it('normalizes empty-string config to "{}" when no password fields', () => {
    const r = redactPluginConfig({ configJson: '', uiSchema: {} });
    expect(r.configJson).toBe('{}');
  });

  it('returns malformed JSON unchanged (best-effort)', () => {
    const r = redactPluginConfig({
      configJson: 'not json {{{',
      uiSchema: { token: { 'ui:widget': 'password' } },
    });
    expect(r.configJson).toBe('not json {{{');
    expect(r.redactedKeys).toEqual([]);
  });

  it('returns array config unchanged (configs must be objects)', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify(['a', 'b']),
      uiSchema: { token: { 'ui:widget': 'password' } },
    });
    expect(r.redactedKeys).toEqual([]);
  });

  it('ignores other ui:widget values (textarea, color, …)', () => {
    const r = redactPluginConfig({
      configJson: JSON.stringify({ note: 'visible' }),
      uiSchema: {
        note: { 'ui:widget': 'textarea' },
      },
    });
    expect(JSON.parse(r.configJson).note).toBe('visible');
    expect(r.redactedKeys).toEqual([]);
  });

  it('regression: cloudflare-pages-hosted manifest shape from the live finding', () => {
    // The exact uiSchema shipped by @papercupai/cloudflare-pages-hosted
    // (uiSchema:{byoCloudflareToken:{"ui:widget":"password","ui:help":"..."}}).
    const r = redactPluginConfig({
      configJson: JSON.stringify({
        exportDir: '/home/u/proj/dist',
        byoCloudflareToken: 'cfut_redactedfixturetoken1234567890abcdef',
        byoCloudflareAccountId: 'f896982ea2f6d507e4f29eeecbd26e94',
      }),
      uiSchema: {
        byoCloudflareToken: {
          'ui:widget': 'password',
          'ui:help': 'Leave empty to use Papercusp hosted publishing.',
        },
      },
    });
    expect(r.configJson).not.toContain('cfut_redactedfixturetoken');
    expect(r.configJson).toContain('[REDACTED]');
    expect(r.configJson).toContain('f896982ea2f6d507e4f29eeecbd26e94'); // accountId is NOT a secret
    expect(r.redactedKeys).toEqual(['byoCloudflareToken']);
  });
});

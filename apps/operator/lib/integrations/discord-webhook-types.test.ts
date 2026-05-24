import { describe, expect, it } from 'vitest';
import {
  DISCORD_CONTENT_MAX,
  DISCORD_EMBEDS_MAX,
  DISCORD_EVENT_KINDS,
  DISCORD_USERNAME_MAX,
  DISCORD_WEBHOOK_BACKOFF_MULTIPLIER,
  DISCORD_WEBHOOK_INITIAL_BACKOFF_MS,
  DISCORD_WEBHOOK_MAX_RETRIES,
  clampDiscordContent,
  deriveDiscordUriFromChannelUrl,
  discordWebhookBackoffMs,
  emptyDiscordConfigPointer,
  isDiscordConfigPointer,
  isRetryableDiscordStatus,
  isValidDiscordChannelUrl,
  isValidDiscordWebhookUrl,
  validateDiscordWebhookPayload,
} from './discord-webhook-types';

describe('constants', () => {
  it('DISCORD_EVENT_KINDS has 4 values', () => {
    expect([...DISCORD_EVENT_KINDS]).toEqual([
      'feature_filed',
      'pr_opened',
      'pr_merged',
      'escalation',
    ]);
  });

  it('DISCORD_CONTENT_MAX is 2000 per Discord API', () => {
    expect(DISCORD_CONTENT_MAX).toBe(2000);
  });

  it('DISCORD_EMBEDS_MAX is 10 per Discord API', () => {
    expect(DISCORD_EMBEDS_MAX).toBe(10);
  });

  it('DISCORD_USERNAME_MAX is 80', () => {
    expect(DISCORD_USERNAME_MAX).toBe(80);
  });

  it('DISCORD_WEBHOOK_MAX_RETRIES is 3 per v5 §11', () => {
    expect(DISCORD_WEBHOOK_MAX_RETRIES).toBe(3);
  });

  it('DISCORD_WEBHOOK_INITIAL_BACKOFF_MS is 1s', () => {
    expect(DISCORD_WEBHOOK_INITIAL_BACKOFF_MS).toBe(1000);
  });

  it('DISCORD_WEBHOOK_BACKOFF_MULTIPLIER is 2', () => {
    expect(DISCORD_WEBHOOK_BACKOFF_MULTIPLIER).toBe(2);
  });
});

describe('isValidDiscordWebhookUrl', () => {
  it('accepts canonical discord.com webhook URL', () => {
    expect(
      isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123/abc-DEF_xyz'),
    ).toBe(true);
  });

  it('accepts legacy discordapp.com webhook URL', () => {
    expect(
      isValidDiscordWebhookUrl('https://discordapp.com/api/webhooks/123/abc'),
    ).toBe(true);
  });

  it('rejects non-https', () => {
    expect(
      isValidDiscordWebhookUrl('http://discord.com/api/webhooks/123/abc'),
    ).toBe(false);
  });

  it('rejects non-webhook discord URLs', () => {
    expect(isValidDiscordWebhookUrl('https://discord.com/channels/1/2')).toBe(false);
    expect(isValidDiscordWebhookUrl('https://discord.com/')).toBe(false);
  });

  it('rejects bad token chars', () => {
    expect(
      isValidDiscordWebhookUrl('https://discord.com/api/webhooks/123/has spaces'),
    ).toBe(false);
  });

  it('rejects non-string', () => {
    // @ts-expect-error
    expect(isValidDiscordWebhookUrl(null)).toBe(false);
    // @ts-expect-error
    expect(isValidDiscordWebhookUrl(42)).toBe(false);
  });
});

describe('isValidDiscordChannelUrl', () => {
  it('accepts canonical channel URL', () => {
    expect(isValidDiscordChannelUrl('https://discord.com/channels/123/456')).toBe(true);
  });

  it('accepts legacy discordapp.com', () => {
    expect(isValidDiscordChannelUrl('https://discordapp.com/channels/123/456')).toBe(true);
  });

  it('rejects malformed channel URL', () => {
    expect(isValidDiscordChannelUrl('https://discord.com/channels/123')).toBe(false);
    expect(isValidDiscordChannelUrl('https://discord.com/channels/abc/456')).toBe(false);
    expect(isValidDiscordChannelUrl('https://discord.com/')).toBe(false);
  });
});

describe('deriveDiscordUriFromChannelUrl', () => {
  it('strips https:// → discord://', () => {
    expect(
      deriveDiscordUriFromChannelUrl('https://discord.com/channels/123/456'),
    ).toBe('discord://discord.com/channels/123/456');
  });

  it('returns null for invalid URL', () => {
    expect(deriveDiscordUriFromChannelUrl('not a url')).toBeNull();
    expect(deriveDiscordUriFromChannelUrl('https://example.com/x')).toBeNull();
  });
});

describe('validateDiscordWebhookPayload', () => {
  it('returns null for valid content-only payload', () => {
    expect(validateDiscordWebhookPayload({ content: 'hello' })).toBeNull();
  });

  it('returns null for valid embeds-only payload', () => {
    expect(
      validateDiscordWebhookPayload({ embeds: [{ title: 'Hi' }] }),
    ).toBeNull();
  });

  it('rejects empty payload (no content + no embeds)', () => {
    expect(validateDiscordWebhookPayload({})?.kind).toBe('no_content_or_embeds');
  });

  it('rejects payload with empty content + empty embeds', () => {
    expect(
      validateDiscordWebhookPayload({ content: '', embeds: [] })?.kind,
    ).toBe('no_content_or_embeds');
  });

  it('rejects over-length content', () => {
    const result = validateDiscordWebhookPayload({ content: 'a'.repeat(DISCORD_CONTENT_MAX + 1) });
    expect(result?.kind).toBe('content_too_long');
  });

  it('accepts at-limit content', () => {
    expect(
      validateDiscordWebhookPayload({ content: 'a'.repeat(DISCORD_CONTENT_MAX) }),
    ).toBeNull();
  });

  it('rejects too many embeds', () => {
    const tooMany = Array.from({ length: DISCORD_EMBEDS_MAX + 1 }, () => ({ title: 'x' }));
    const result = validateDiscordWebhookPayload({ embeds: tooMany });
    expect(result?.kind).toBe('too_many_embeds');
  });

  it('rejects over-length username', () => {
    const result = validateDiscordWebhookPayload({
      content: 'x',
      username: 'a'.repeat(DISCORD_USERNAME_MAX + 1),
    });
    expect(result?.kind).toBe('username_too_long');
  });
});

describe('clampDiscordContent', () => {
  it('passes short content unchanged', () => {
    expect(clampDiscordContent('hello')).toBe('hello');
  });

  it('truncates at DISCORD_CONTENT_MAX', () => {
    const long = 'a'.repeat(DISCORD_CONTENT_MAX + 500);
    expect(clampDiscordContent(long).length).toBe(DISCORD_CONTENT_MAX);
  });

  it('returns "" for non-string', () => {
    // @ts-expect-error
    expect(clampDiscordContent(null)).toBe('');
  });
});

describe('discordWebhookBackoffMs', () => {
  it('attempt 0 → 1000 ms', () => {
    expect(discordWebhookBackoffMs(0)).toBe(1000);
  });

  it('attempt 1 → 2000 ms', () => {
    expect(discordWebhookBackoffMs(1)).toBe(2000);
  });

  it('attempt 2 → 4000 ms', () => {
    expect(discordWebhookBackoffMs(2)).toBe(4000);
  });

  it('rejects negative or non-integer', () => {
    expect(() => discordWebhookBackoffMs(-1)).toThrow(TypeError);
    expect(() => discordWebhookBackoffMs(1.5)).toThrow(TypeError);
  });
});

describe('isRetryableDiscordStatus', () => {
  it('true for 5xx', () => {
    expect(isRetryableDiscordStatus(500)).toBe(true);
    expect(isRetryableDiscordStatus(502)).toBe(true);
    expect(isRetryableDiscordStatus(599)).toBe(true);
  });

  it('false for 4xx + 2xx + 3xx', () => {
    expect(isRetryableDiscordStatus(200)).toBe(false);
    expect(isRetryableDiscordStatus(401)).toBe(false);
    expect(isRetryableDiscordStatus(404)).toBe(false);
    expect(isRetryableDiscordStatus(429)).toBe(false);
    expect(isRetryableDiscordStatus(301)).toBe(false);
  });
});

describe('isDiscordConfigPointer', () => {
  it('accepts both nulls', () => {
    expect(
      isDiscordConfigPointer({ discord_channel_url: null, discord_webhook_url: null }),
    ).toBe(true);
  });

  it('accepts valid URLs', () => {
    expect(
      isDiscordConfigPointer({
        discord_channel_url: 'https://discord.com/channels/123/456',
        discord_webhook_url: 'https://discord.com/api/webhooks/123/abc',
      }),
    ).toBe(true);
  });

  it('accepts one set + one null', () => {
    expect(
      isDiscordConfigPointer({
        discord_channel_url: 'https://discord.com/channels/123/456',
        discord_webhook_url: null,
      }),
    ).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(
      isDiscordConfigPointer({
        discord_channel_url: 'not a url',
        discord_webhook_url: null,
      }),
    ).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isDiscordConfigPointer(null)).toBe(false);
    expect(isDiscordConfigPointer('x')).toBe(false);
  });
});

describe('emptyDiscordConfigPointer', () => {
  it('returns both-null pointer', () => {
    expect(emptyDiscordConfigPointer()).toEqual({
      discord_channel_url: null,
      discord_webhook_url: null,
    });
  });
});

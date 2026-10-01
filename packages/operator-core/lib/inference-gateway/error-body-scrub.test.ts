/**
 * WI-10004561: upstream error bodies relayed by ANY lane are scrubbed of credentials, including
 * credential shapes `scrubSecrets` cannot recognise by pattern (an OpenAI key, a ChatGPT OAuth JWT).
 *
 * Fixtures are assembled at runtime from fragments on purpose: a credential-shaped LITERAL in a
 * tree file trips the secrets guard and the pot-git publish guard.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BUFFERED_ERROR_BODY_BYTES,
  presentedSecretsFromHeaders,
  scrubErrorText,
  scrubbedErrorBody,
  type RelayBody,
} from './error-body-scrub';
import { scrubSecrets } from './credential-store';

const ALNUM = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const OPENAI_KEY = ['sk', 'proj', ALNUM].join('-');
const OAUTH_JWT = ['ey' + 'JhbGciOiJSUzI1NiJ9', 'ey' + 'JzdWIiOiJ1c2VyLTEyMyJ9', 'c2lnbmF0dXJlLWJ5dGVz'].join('.');
const CLAUDE_KEY = ['sk', 'ant', 'api03', '0123456789abcdefghij' + ALNUM.slice(0, 10)].join('-');

function bodyOf(chunks: string[]): RelayBody & { readonly cancelled: boolean } {
  const state = { cancelled: false };
  return {
    get cancelled() {
      return state.cancelled;
    },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield new Uint8Array(Buffer.from(c, 'utf8'));
    },
    cancel: () => {
      state.cancelled = true;
    },
  };
}

async function readAll(body: RelayBody): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}

describe('presentedSecretsFromHeaders', () => {
  it('reads the bare token from credential headers, case-insensitively, and nothing else', () => {
    const secrets = presentedSecretsFromHeaders({
      Authorization: `Bearer ${OAUTH_JWT}`,
      'x-api-key': OPENAI_KEY,
      'content-type': 'application/json-with-a-long-value',
      'chatgpt-account-id': 'acct-0123456789abcdef',
    });
    expect([...secrets].sort()).toEqual([OAUTH_JWT, OPENAI_KEY].sort());
  });

  it('ignores values too short to be a credential worth redacting', () => {
    expect(presentedSecretsFromHeaders({ authorization: 'Bearer short' })).toEqual([]);
    expect(presentedSecretsFromHeaders(undefined)).toEqual([]);
  });
});

describe('scrubErrorText', () => {
  it('redacts a presented credential that the shape-based scrubber cannot see', () => {
    const echoed = `{"error":{"message":"Incorrect API key provided: ${OPENAI_KEY}; token ${OAUTH_JWT} rejected"}}`;
    // Distinguishing control: pattern-only scrubbing leaves both values intact.
    expect(scrubSecrets(echoed)).toContain(OPENAI_KEY);
    expect(scrubSecrets(echoed)).toContain(OAUTH_JWT);

    const out = scrubErrorText(echoed, [OPENAI_KEY, OAUTH_JWT]);
    expect(out).not.toContain(OPENAI_KEY);
    expect(out).not.toContain(OAUTH_JWT);
    expect(out).toContain('[redacted]');
    expect(out).toContain('Incorrect API key provided');
  });

  it('keeps the existing Claude-key prefix behaviour (shape-based scrub runs first)', () => {
    const out = scrubErrorText(`bad key ${CLAUDE_KEY}`, [CLAUDE_KEY]);
    expect(out).not.toContain(CLAUDE_KEY);
    expect(out).toContain(`${CLAUDE_KEY.slice(0, 12)}…[redacted]`);
  });

  it('leaves text without a credential unchanged', () => {
    expect(scrubErrorText('{"error":"rate limited"}', [OPENAI_KEY])).toBe('{"error":"rate limited"}');
  });
});

describe('scrubbedErrorBody', () => {
  it('redacts a presented credential split across two upstream chunks', async () => {
    const half = Math.floor(OPENAI_KEY.length / 2);
    const body = bodyOf([`{"error":"key ${OPENAI_KEY.slice(0, half)}`, `${OPENAI_KEY.slice(half)} invalid"}`]);
    const out = await readAll(scrubbedErrorBody(body, [OPENAI_KEY]));
    expect(out).not.toContain(OPENAI_KEY);
    expect(out).toContain('invalid');
  });

  it('still redacts a credential that arrives after the buffered window is exceeded', async () => {
    const filler = 'x'.repeat(MAX_BUFFERED_ERROR_BODY_BYTES);
    const body = bodyOf([filler, ` trailing ${OAUTH_JWT} echoed`]);
    const out = await readAll(scrubbedErrorBody(body, [OAUTH_JWT]));
    expect(out).not.toContain(OAUTH_JWT);
    expect(out.endsWith(' echoed')).toBe(true);
  });

  it('delegates cancel so a retried attempt can release the upstream socket', async () => {
    const body = bodyOf(['{}']);
    await scrubbedErrorBody(body, [OPENAI_KEY]).cancel?.();
    expect(body.cancelled).toBe(true);
  });
});

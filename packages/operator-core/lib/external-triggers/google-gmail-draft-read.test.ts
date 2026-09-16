import { describe, expect, it, vi } from 'vitest';
import { readGoogleGmailDraftRecipients } from './google-gmail';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const ORIGIN = 'https://gmail.test';
const SEAM = { apiOrigin: ORIGIN } as const;

function draft(headers: Array<{ name: string; value: string }>) {
  return { id: 'draft-1', message: { id: 'm1', threadId: 't1', payload: { headers } } };
}

describe('readGoogleGmailDraftRecipients', () => {
  it('reads the To/Cc/Subject a draft actually carries', async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        draft([
          { name: 'To', value: 'Hiring <hiring@company.example>' },
          { name: 'Cc', value: 'cc@company.example' },
          { name: 'Subject', value: 'Senior Engineer' },
        ]),
      ),
    ) as unknown as typeof fetch;

    const result = await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result).toEqual({
      to: ['hiring@company.example'],
      cc: ['cc@company.example'],
      subject: 'Senior Engineer',
    });
  });

  it('requests only metadata headers — the body never has to cross the wire', async () => {
    // A draft carrying a multi-megabyte resume should not be downloaded to
    // answer "who is this addressed to".
    const fetchImpl = vi.fn(async () => json(draft([{ name: 'To', value: 'a@b.example' }]))) as unknown as typeof fetch;

    await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0][0]));
    expect(url.pathname).toBe('/gmail/v1/users/me/drafts/draft-1');
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual(['To', 'Cc', 'Subject']);
  });

  it('treats a quoted display name containing a comma as ONE recipient', async () => {
    // The property that makes the caller's set-comparison trustworthy. A naive
    // split(',') reads `"Weiss, Avi" <avi@…>` as two entries, neither of which
    // parses as an address — so the caller sees a mismatch that is purely a
    // parser artifact, on the personal-name format most likely to appear in a
    // real mailbox.
    const fetchImpl = vi.fn(async () =>
      json(
        draft([{ name: 'To', value: '"Weiss, Avi" <avi@example.com>, "Doe, Jane" <jane@example.com>' }]),
      ),
    ) as unknown as typeof fetch;

    const result = await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result.to).toEqual(['avi@example.com', 'jane@example.com']);
  });

  it('lowercases and trims addresses so comparison is case-insensitive', async () => {
    const fetchImpl = vi.fn(async () =>
      json(draft([{ name: 'To', value: '  Hiring <HIRING@Company.Example>  ' }])),
    ) as unknown as typeof fetch;

    const result = await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result.to).toEqual(['hiring@company.example']);
  });

  it('matches headers case-insensitively (Gmail may return TO/CC)', async () => {
    const fetchImpl = vi.fn(async () =>
      json(draft([{ name: 'TO', value: 'a@b.example' }, { name: 'cc', value: 'c@d.example' }])),
    ) as unknown as typeof fetch;

    const result = await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result.to).toEqual(['a@b.example']);
    expect(result.cc).toEqual(['c@d.example']);
  });

  it('REFUSES a response carrying no headers instead of reporting no recipients', async () => {
    // The load-bearing distinction. An unreadable draft returning `{to: []}`
    // would read to a caller as "this draft is addressed to nobody", and the
    // natural reaction to an empty set — nothing to check — is exactly wrong.
    const fetchImpl = vi.fn(async () => json({ id: 'draft-1', message: { payload: {} } })) as unknown as typeof fetch;

    await expect(
      readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM }),
    ).rejects.toThrow('google_gmail_draft_headers_unreadable');
  });

  it('returns an empty cc (not a failure) when the draft genuinely has none', async () => {
    const fetchImpl = vi.fn(async () =>
      json(draft([{ name: 'To', value: 'a@b.example' }, { name: 'Subject', value: 'x' }])),
    ) as unknown as typeof fetch;

    const result = await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result.cc).toEqual([]);
    expect(result.to).toEqual(['a@b.example']);
  });

  it('url-encodes the draft id into the path', async () => {
    const fetchImpl = vi.fn(async () => json(draft([{ name: 'To', value: 'a@b.example' }]))) as unknown as typeof fetch;

    await readGoogleGmailDraftRecipients('token', 'r-708/811', { fetch: fetchImpl, ...SEAM });

    expect(new URL(String(vi.mocked(fetchImpl).mock.calls[0][0])).pathname).toBe(
      '/gmail/v1/users/me/drafts/r-708%2F811',
    );
  });

  it('drops a header entry that is not an address rather than emitting a bad one', async () => {
    const fetchImpl = vi.fn(async () =>
      json(draft([{ name: 'To', value: 'undisclosed-recipients:;, real@example.com' }])),
    ) as unknown as typeof fetch;

    const result = await readGoogleGmailDraftRecipients('token', 'draft-1', { fetch: fetchImpl, ...SEAM });

    expect(result.to).toEqual(['real@example.com']);
  });

  it('requires a token and a draft id', async () => {
    const fetchImpl = vi.fn(async () => json(draft([]))) as unknown as typeof fetch;
    await expect(readGoogleGmailDraftRecipients(' ', 'draft-1', { fetch: fetchImpl, ...SEAM })).rejects.toThrow(
      'google_gmail_access_token_required',
    );
    await expect(readGoogleGmailDraftRecipients('token', ' ', { fetch: fetchImpl, ...SEAM })).rejects.toThrow(
      'google_gmail_draft_id_required',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

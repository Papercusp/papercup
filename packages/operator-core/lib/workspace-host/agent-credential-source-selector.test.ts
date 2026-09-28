import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  WORKSPACE_HOST_AGENT_HOME_FILES,
  WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN,
  WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN,
  projectWorkspaceHostClaudeAccessToken,
  projectWorkspaceHostCodexAccessToken,
} from '@papercusp/deployment-driver';

import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_SOURCE_MAX_BYTES,
  WorkspaceHostAgentCredentialSourceError,
  deliveredAccessExpiry,
  operatorAgentHomeFilePath,
  resolveWorkspaceHostAgentCredentialSources,
  type WorkspaceHostAgentCredentialSourceReaders,
  type WorkspaceHostAgentCredentialSourceSelector,
} from './agent-credential-source-selector';

const CLAUDE_JSON = JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access' } });
const CODEX_JSON = JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' } });

function readers(
  overrides: Partial<WorkspaceHostAgentCredentialSourceReaders> = {},
): WorkspaceHostAgentCredentialSourceReaders {
  return {
    readFileBytes: vi.fn(async (path: string) => {
      if (path === operatorAgentHomeFilePath('claude')) return Buffer.from(CLAUDE_JSON, 'utf8');
      if (path === operatorAgentHomeFilePath('codex')) return Buffer.from(CODEX_JSON, 'utf8');
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
    readIntegrationKey: vi.fn(async () => undefined),
    ...overrides,
  };
}

const HOME_SELECTOR: WorkspaceHostAgentCredentialSourceSelector = {
  claude: { kind: 'operator-home-file' },
  codex: { kind: 'operator-home-file' },
  omp: { kind: 'absent' },
};

describe('operatorAgentHomeFilePath', () => {
  it('derives the operator path from the host-side layout constant rather than a second copy', () => {
    // The point of the derivation: if the on-host layout moves, the source we read moves with it.
    for (const slot of ['claude', 'codex', 'omp'] as const) {
      expect(operatorAgentHomeFilePath(slot)).toBe(
        join(homedir(), ...WORKSPACE_HOST_AGENT_HOME_FILES[slot]),
      );
    }
  });
});

describe('resolveWorkspaceHostAgentCredentialSources', () => {
  it('resolves each slot from its own home file and reports a content-free receipt', async () => {
    const result = await resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers());

    expect(result.files.claude.toString('utf8')).toBe(CLAUDE_JSON);
    expect(result.files.codex.toString('utf8')).toBe(CODEX_JSON);
    expect(result.files.omp).toBeNull();

    expect(result.resolved.claude.bytes).toBe(Buffer.byteLength(CLAUDE_JSON));
    expect(result.resolved.omp).toEqual({ source: 'absent', bytes: 0, accessExpiresAt: null });

    // The receipt must never carry content: no resolved label may contain a token we supplied.
    const receipt = JSON.stringify(result.resolved);
    expect(receipt).not.toContain('claude-access');
    expect(receipt).not.toContain('refresh_token');
  });

  it('reads a named integration key when the slot selects one', async () => {
    const readIntegrationKey = vi.fn(async (name: string) =>
      name === 'WORKSPACE_HOST_CLAUDE' ? CLAUDE_JSON : undefined,
    );
    const result = await resolveWorkspaceHostAgentCredentialSources(
      { ...HOME_SELECTOR, claude: { kind: 'integration-key', name: 'WORKSPACE_HOST_CLAUDE' } },
      readers({ readIntegrationKey }),
    );

    expect(readIntegrationKey).toHaveBeenCalledWith('WORKSPACE_HOST_CLAUDE');
    expect(result.files.claude.toString('utf8')).toBe(CLAUDE_JSON);
    expect(result.resolved.claude.source).toBe('integration-key:WORKSPACE_HOST_CLAUDE');
  });

  it('refuses an integration key that holds no value, naming the repair', async () => {
    await expect(
      resolveWorkspaceHostAgentCredentialSources(
        { ...HOME_SELECTOR, claude: { kind: 'integration-key', name: 'MISSING_KEY' } },
        readers(),
      ),
    ).rejects.toThrow(/MISSING_KEY.*setup:save_integration_key/s);
  });

  it("refuses 'absent' for claude and codex — only omp is credential-free by contract", async () => {
    for (const slot of ['claude', 'codex'] as const) {
      await expect(
        resolveWorkspaceHostAgentCredentialSources(
          { ...HOME_SELECTOR, [slot]: { kind: 'absent' } },
          readers(),
        ),
      ).rejects.toThrow(WorkspaceHostAgentCredentialSourceError);
    }
  });

  it('refuses a slot with no source at all rather than defaulting one', async () => {
    // A default here would silently answer "whose credentials does this host get?".
    const partial = { claude: { kind: 'operator-home-file' }, omp: { kind: 'absent' } };
    await expect(
      resolveWorkspaceHostAgentCredentialSources(
        partial as unknown as WorkspaceHostAgentCredentialSourceSelector,
        readers(),
      ),
    ).rejects.toThrow(/'codex' was not supplied/);
  });

  it('names the missing file when the operator has no home for that agent', async () => {
    const readFileBytes = vi.fn(async () => {
      const error = new Error('nope') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    await expect(
      resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers({ readFileBytes })),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses an empty file instead of encoding zero bytes as a credential', async () => {
    const readFileBytes = vi.fn(async () => Buffer.alloc(0));
    await expect(
      resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers({ readFileBytes })),
    ).rejects.toThrow(/read 0 bytes/);
  });

  it('refuses a source over the size ceiling — a mis-selected file fails at the read, not at bind', async () => {
    const readFileBytes = vi.fn(async () =>
      Buffer.alloc(WORKSPACE_HOST_AGENT_CREDENTIAL_SOURCE_MAX_BYTES + 1, 0x61),
    );
    await expect(
      resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers({ readFileBytes })),
    ).rejects.toThrow(/over the .* ceiling/);
  });

  it('claudeProjectionNoticeAccuracy — the claude notice states what the REAL encoder does, not a stale asymmetry', async () => {
    // WHY THIS IS PINNED AGAINST THE ENCODER RATHER THAN A STRING. This notice is a second copy of
    // what the projection code knows, and it DRIFTED: it claimed "files.claude is carried WHOLE"
    // for the whole window after WI-10001691 neutralized the claude refresh token, overstating the
    // risk in the one decision the notice exists to inform (whose credential goes on a host). A
    // wording-only assertion is what let that happen — it passed happily while the claim it pinned
    // had become false. So drive the real encoder and require the notice to agree with it.
    const withLiveRefresh = Buffer.from(
      JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access', refreshToken: 'live-refresh' } }),
      'utf8',
    );
    const projected = JSON.parse(
      projectWorkspaceHostClaudeAccessToken(withLiveRefresh).toString('utf8'),
    ) as { claudeAiOauth: { accessToken: string; refreshToken: string } };

    // The ground truth the notice must not contradict: claude IS projected.
    expect(projected.claudeAiOauth.refreshToken).toBe(
      WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN,
    );
    expect(projected.claudeAiOauth.refreshToken).not.toBe('live-refresh');
    expect(projected.claudeAiOauth.accessToken).toBe('claude-access');

    const withHome = await resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers());
    const notice = withHome.notices.join(' ');
    // Still warns — forwarding a personal credential remains a judgment call...
    expect(notice).toMatch(/files\.claude/);
    expect(notice).toMatch(/purpose-minted/);
    // ...but must NOT reassert the falsified claim, in any of its spellings.
    expect(notice).not.toMatch(/carried WHOLE/i);
    expect(notice).not.toMatch(/no projection/i);
    expect(notice).not.toMatch(/verbatim/i);

    const readIntegrationKey = vi.fn(async () => CLAUDE_JSON);
    const withMintedKey = await resolveWorkspaceHostAgentCredentialSources(
      { ...HOME_SELECTOR, claude: { kind: 'integration-key', name: 'MINTED' } },
      readers({ readIntegrationKey }),
    );
    expect(withMintedKey.notices).toEqual([]);
  });

  it('refuses an unrecognized source kind instead of falling through to a file read', async () => {
    // Caught a real fail-open: an unknown kind reached the home-file branch by FALLTHROUGH, so a
    // path-shaped (or merely typo'd) selector silently resolved to "read this operator's own
    // credentials" — the exact default this module exists to refuse, arrived at by omission.
    // Two distinct assertions, because each fails in a different direction: the request must be
    // REFUSED, and the path it named must never be read.
    const pathShaped = {
      ...HOME_SELECTOR,
      claude: { kind: 'file', path: '/etc/shadow' },
    } as unknown as WorkspaceHostAgentCredentialSourceSelector;
    const spies = readers();
    await expect(
      resolveWorkspaceHostAgentCredentialSources(pathShaped, spies),
    ).rejects.toThrow(/named source kind 'file'/);
    expect(spies.readFileBytes).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind on the codex and omp slots too, not only claude', async () => {
    // The fallthrough was per-slot, so fixing it only for the slot a test happened to name would
    // leave the same fail-open standing on the other two.
    for (const slot of ['codex', 'omp'] as const) {
      const spies = readers();
      await expect(
        resolveWorkspaceHostAgentCredentialSources(
          { ...HOME_SELECTOR, [slot]: { kind: 'typo-home-file' } } as unknown as
            WorkspaceHostAgentCredentialSourceSelector,
          spies,
        ),
      ).rejects.toThrow(WorkspaceHostAgentCredentialSourceError);
    }
  });
});

describe('delivered access expiry (WI-10003706)', () => {
  // A delivery used to read as a durable login and die ~13h later with a 401 and no prior signal
  // (avi-test, 2026-09-26..27). The encoder neutralizes BOTH refresh tokens for EVERY source, so the
  // access token's own expiry is a hard deadline; the receipt must say when it is.
  const NOW = new Date('2026-09-28T12:00:00.000Z');
  const CLAUDE_EXPIRES_MS = Date.parse('2026-09-29T01:00:00.000Z'); // 13h after NOW
  const CODEX_EXP_S = Date.parse('2026-09-28T18:30:00.000Z') / 1000; // 6.5h after NOW

  const jwt = (payload: Record<string, unknown>): string =>
    ['e30', Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), 'sig'].join('.');

  const claudeWithExpiry = (expiresAt: number) =>
    JSON.stringify({
      claudeAiOauth: { accessToken: 'claude-access-secret', refreshToken: 'claude-live-refresh', expiresAt },
    });
  const CODEX_ACCESS_JWT = jwt({ exp: CODEX_EXP_S, sub: 'codex-subject-secret' });
  const codexWithExpiry = JSON.stringify({
    tokens: { access_token: CODEX_ACCESS_JWT, refresh_token: 'codex-live-refresh', id_token: 'i' },
  });

  const expiringReaders = (claudeExpiresAt = CLAUDE_EXPIRES_MS) =>
    readers({
      readFileBytes: vi.fn(async (path: string) => {
        if (path === operatorAgentHomeFilePath('claude')) {
          return Buffer.from(claudeWithExpiry(claudeExpiresAt), 'utf8');
        }
        return Buffer.from(codexWithExpiry, 'utf8');
      }),
    });

  it('reports each slot’s access expiry in the receipt and names it in a notice', async () => {
    const result = await resolveWorkspaceHostAgentCredentialSources(
      HOME_SELECTOR,
      expiringReaders(),
      { now: NOW },
    );

    expect(result.resolved.claude.accessExpiresAt).toBe('2026-09-29T01:00:00.000Z');
    expect(result.resolved.codex.accessExpiresAt).toBe('2026-09-28T18:30:00.000Z');
    expect(result.resolved.omp.accessExpiresAt).toBeNull();

    const claudeNotice = result.notices.find((n) => n.startsWith('files.claude delivers'));
    const codexNotice = result.notices.find((n) => n.startsWith('files.codex delivers'));
    expect(claudeNotice).toMatch(/EXPIRES at 2026-09-29T01:00:00\.000Z \(in ~13h\)/);
    expect(claudeNotice).toMatch(/not a durable login/);
    expect(codexNotice).toMatch(/EXPIRES at 2026-09-28T18:30:00\.000Z \(in ~6\.5h\)/);
    expect(codexNotice).toMatch(/Codex CLI on this host fails with 401/);

    // Reporting the expiry must never leak the material it was read from.
    const receipt = JSON.stringify({ resolved: result.resolved, notices: result.notices });
    for (const secret of ['claude-access-secret', 'claude-live-refresh', 'codex-live-refresh', CODEX_ACCESS_JWT, 'codex-subject-secret']) {
      expect(receipt).not.toContain(secret);
    }
  });

  it('says ALREADY EXPIRED for material that is dead on delivery', async () => {
    const result = await resolveWorkspaceHostAgentCredentialSources(
      HOME_SELECTOR,
      expiringReaders(Date.parse('2026-09-28T11:00:00.000Z')),
      { now: NOW },
    );
    const claudeNotice = result.notices.find((n) => n.startsWith('files.claude delivers'));
    expect(claudeNotice).toMatch(/ALREADY EXPIRED at 2026-09-28T11:00:00\.000Z/);
    expect(claudeNotice).toMatch(/fail with 401 from its first call/);
  });

  it('reports null and adds no expiry notice when the material carries no readable expiry', async () => {
    // The base fixtures carry no `expiresAt` and a non-JWT codex access token.
    const result = await resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers(), { now: NOW });
    expect(result.resolved.claude.accessExpiresAt).toBeNull();
    expect(result.resolved.codex.accessExpiresAt).toBeNull();
    expect(result.notices.some((n) => /EXPIRES at|ALREADY EXPIRED/.test(n))).toBe(false);
  });

  it('expiryNoticeAccuracy — the REAL encoder keeps the reported expiry and removes the ability to renew it', () => {
    // The notice claims two things about what reaches the host: the access token still expires at
    // the reported instant, and it cannot be renewed. Both are properties of the encoder, not of
    // this module, so pin them against the encoder rather than a string (the derived-truth rule
    // that `claudeProjectionNoticeAccuracy` above exists for).
    const claudeSource = Buffer.from(claudeWithExpiry(CLAUDE_EXPIRES_MS), 'utf8');
    const claudeProjected = projectWorkspaceHostClaudeAccessToken(claudeSource);
    expect(deliveredAccessExpiry('claude', claudeProjected)).toBe(
      deliveredAccessExpiry('claude', claudeSource),
    );
    expect(
      (JSON.parse(claudeProjected.toString('utf8')) as { claudeAiOauth: { refreshToken: string } })
        .claudeAiOauth.refreshToken,
    ).toBe(WORKSPACE_HOST_CLAUDE_NEUTRALIZED_REFRESH_TOKEN);

    const codexSource = Buffer.from(codexWithExpiry, 'utf8');
    const codexProjected = projectWorkspaceHostCodexAccessToken(codexSource);
    expect(deliveredAccessExpiry('codex', codexProjected)).toBe(
      deliveredAccessExpiry('codex', codexSource),
    );
    expect(
      (JSON.parse(codexProjected.toString('utf8')) as { tokens: { refresh_token: string } }).tokens
        .refresh_token,
    ).toBe(WORKSPACE_HOST_CODEX_NEUTRALIZED_REFRESH_TOKEN);
  });

  it('never throws on malformed material — validity is the encoder’s job', () => {
    expect(deliveredAccessExpiry('claude', Buffer.from('not json', 'utf8'))).toBeNull();
    expect(deliveredAccessExpiry('codex', Buffer.from('{"tokens":{"access_token":"a.b"}}', 'utf8'))).toBeNull();
    expect(deliveredAccessExpiry('codex', Buffer.from('{"tokens":{"access_token":"a.!!!.c"}}', 'utf8'))).toBeNull();
    expect(deliveredAccessExpiry('claude', Buffer.from('{"claudeAiOauth":{"expiresAt":"soon"}}', 'utf8'))).toBeNull();
    expect(deliveredAccessExpiry('omp', Buffer.from('{}', 'utf8'))).toBeNull();
    expect(deliveredAccessExpiry('claude', null)).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { WORKSPACE_HOST_AGENT_HOME_FILES } from '@papercusp/deployment-driver';

import {
  WORKSPACE_HOST_AGENT_CREDENTIAL_SOURCE_MAX_BYTES,
  WorkspaceHostAgentCredentialSourceError,
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
    expect(result.resolved.omp).toEqual({ source: 'absent', bytes: 0 });

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

  it('warns that files.claude is carried whole when it is read from this operator home', async () => {
    // The asymmetry is the load-bearing fact: codex is projected (D-311 / WI-10001688), claude is
    // not. A caller must meet that at the call site, not in a doc comment.
    const withHome = await resolveWorkspaceHostAgentCredentialSources(HOME_SELECTOR, readers());
    expect(withHome.notices.join(' ')).toMatch(/files\.claude is carried WHOLE/);

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

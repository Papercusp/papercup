import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DENY,
  effectiveDenylist,
  matchDeny,
  OPT_IN_INCLUDE,
} from './denylist';

describe('denylist', () => {
  it('always excludes node_modules and dist', () => {
    expect(matchDeny('node_modules/foo/index.js', DEFAULT_DENY)).toBeTruthy();
    expect(matchDeny('apps/x/dist/main.js', DEFAULT_DENY)).toBeTruthy();
  });

  it('always excludes dotenv variants', () => {
    for (const name of ['.env', '.env.local', '.env.production']) {
      expect(matchDeny(name, DEFAULT_DENY)?.reason).toBe('denylist:secret');
    }
  });

  it('always excludes pem/key files at any depth', () => {
    expect(matchDeny('certs/server.pem', DEFAULT_DENY)?.reason).toBe('denylist:secret');
    expect(matchDeny('id_rsa', DEFAULT_DENY)?.reason).toBe('denylist:secret');
  });

  it('always excludes substrate credentials', () => {
    expect(matchDeny('.papercusp/credentials.json', DEFAULT_DENY)?.reason).toBe(
      'denylist:substrate-secret',
    );
  });

  it('git/hooks excluded even when .git/ is opted in', () => {
    const list = effectiveDenylist({ includeGit: true });
    expect(matchDeny('.git/HEAD', list)).toBeNull();
    expect(matchDeny('.git/hooks/pre-commit', list)?.reason).toBe('denylist:executable-hook');
  });

  it('allows source files that look like denied patterns but are not', () => {
    expect(matchDeny('src/env.ts', DEFAULT_DENY)).toBeNull();
    expect(matchDeny('src/keyboard.ts', DEFAULT_DENY)).toBeNull();
  });

  describe('opt-in flags', () => {
    it('without opts, .git/ excluded', () => {
      const list = effectiveDenylist();
      expect(matchDeny('.git/objects/aa/bb', list)).toBeTruthy();
    });
    it('with includeGit, .git/ allowed (but hooks still denied)', () => {
      const list = effectiveDenylist({ includeGit: true });
      expect(matchDeny('.git/HEAD', list)).toBeNull();
      expect(matchDeny('.git/hooks/pre-push', list)).toBeTruthy();
    });
    it('with includeAgentTranscripts, transcripts allowed', () => {
      const list = effectiveDenylist({ includeAgentTranscripts: true });
      expect(matchDeny('.papercusp/agent_chats/agent_chats.transcript', list)).toBeNull();
    });
    it('without opt-in, agent transcripts denied', () => {
      const list = effectiveDenylist();
      expect(matchDeny('.papercusp/agent_chats/agent_chats.transcript', list)).toBeTruthy();
    });
    it('with includeOperatorNotes, notes allowed', () => {
      const list = effectiveDenylist({ includeOperatorNotes: true });
      expect(matchDeny('.papercusp/notes/F-001.md', list)).toBeNull();
    });
  });

  it('OPT_IN_INCLUDE patterns are disjoint from DEFAULT_DENY', () => {
    const denyPatterns = new Set(DEFAULT_DENY.map((d) => d.pattern));
    for (const m of OPT_IN_INCLUDE) {
      expect(denyPatterns.has(m.pattern)).toBe(false);
    }
  });
});

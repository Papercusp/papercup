import { describe, expect, it } from 'vitest';
import { dedupeKeyFor, personalAliasGroups } from './store';

describe('Personal Vault identity alias grouping', () => {
  it('namespaces an otherwise identical document by provider account', () => {
    const base = { source: 'gmail', kind: 'message', dedupeKey: 'gmail:message-1' };
    const first = dedupeKeyFor({ ...base, providerAccountId: 'first@example.com' });
    const second = dedupeKeyFor({ ...base, providerAccountId: 'second@example.com' });
    expect(first).toMatch(/^account:[0-9a-f]{64}:gmail:message-1$/);
    expect(second).toMatch(/^account:[0-9a-f]{64}:gmail:message-1$/);
    expect(first).not.toBe(second);
    expect(dedupeKeyFor(base)).toBe('gmail:message-1');
  });

  it('links a contact display name and all of its email aliases as one human', () => {
    const groups = personalAliasGroups({
      source: 'contacts',
      kind: 'contact',
      title: 'Ada Lovelace',
      participants: ['ada@example.com', 'ada@work.example'],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((alias) => [alias.kind, alias.normalized])).toEqual([
      ['email', 'ada@example.com'],
      ['email', 'ada@work.example'],
      ['name', 'ada lovelace'],
    ]);
  });

  it('keeps different message participants as different humans', () => {
    const groups = personalAliasGroups({
      source: 'gmail',
      kind: 'message',
      participants: ['ada@example.com', 'bob@example.com'],
    });
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group[0]?.normalized)).toEqual(['ada@example.com', 'bob@example.com']);
  });
});

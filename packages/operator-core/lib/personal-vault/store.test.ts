import { describe, expect, it } from 'vitest';
import { personalAliasGroups } from './store';

describe('Personal Vault identity alias grouping', () => {
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

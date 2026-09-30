// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { IdentityListingSurface } from '@papercusp/operator-core/lib/cupboard/identity-listing-surface-wire';
import IdentitySurface from './IdentitySurface';

afterEach(cleanup);

const SURFACE: IdentityListingSurface = {
  schemaVersion: 1,
  identity: { id: 'acme.reviewer', version: '1.2.0', slots: ['reviewer'] },
  contributions: [
    {
      id: 'house-style',
      inputKind: 'knowledge-pack',
      ref: 'acme.style',
      refresh: 'on-install',
      injection: { sinks: ['turn-start'], timing: 'every-turn', tokenBudget: 400, priority: 10, overBudget: 'truncate' },
    },
    { id: 'lookup', inputKind: 'recipe', ref: 'acme.lookup', verb: 'run', refresh: 'on-demand' },
  ],
  hooks: {
    sync: [{ id: 'no-force-push', rule: 'acme.guards', sink: 'pre-tool', kind: 'guard', tools: ['capability:bash'] }],
    async: [{ id: 'on-merge', rule: 'acme.reactions', on: 'git.merged', fire: 'notify' }],
    unreadable: ['acme.future-rule'],
  },
  packages: [
    { kind: 'rule', ref: 'acme.guards', version: '1.0.0', contentHash: `sha256:${'a'.repeat(64)}` },
    { kind: 'knowledge-pack', ref: 'acme.style', version: '2.0.0', contentHash: `sha256:${'b'.repeat(64)}` },
  ],
  knowledge: [{ ref: 'acme.style', version: '2.0.0', memories: 3, docs: [{ id: 'd1', title: 'Tone', section: 'style' }] }],
  classContracts: [{ ref: 'acme.search', contractHash: `sha256:${'c'.repeat(64)}` }],
  grants: { requires: ['acme.search'], optional: ['acme.mail'] },
  permissions: ['injects knowledge-pack acme.style into turn-start every turn'],
  consent: 'required',
};

describe('IdentitySurface (portable-identity-packages P-016)', () => {
  it('previews every part of the declared surface from the listing column', () => {
    render(<IdentitySurface value={JSON.stringify(SURFACE)} />);
    const root = screen.getByTestId('identity-surface');
    expect(root.getAttribute('data-state')).toBe('ok');
    expect(root.getAttribute('data-consent')).toBe('required');
    expect(root.textContent).toContain('acme.reviewer');
    expect(root.textContent).toContain('fills reviewer');

    const counts = Object.fromEntries(
      [
        'contributions', 'sync-hooks', 'async-hooks', 'unreadable-rules', 'packages',
        'knowledge', 'class-contracts', 'grants', 'permissions',
      ].map((group) => [group, screen.getByTestId(`identity-surface-${group}`).getAttribute('data-count')]),
    );
    expect(counts).toEqual({
      contributions: '2', 'sync-hooks': '1', 'async-hooks': '1', 'unreadable-rules': '1', packages: '2',
      knowledge: '1', 'class-contracts': '1', grants: '2', permissions: '1',
    });

    // Where a contribution injects is the part a shopper most needs; an on-demand
    // read says it never injects rather than showing nothing.
    const contributions = screen.getByTestId('identity-surface-contributions');
    expect(within(contributions).getByTestId('identity-surface-injection').textContent).toContain('turn-start');
    expect(contributions.textContent).toContain('never injected');
    // Required vs optional grants are never blended.
    const grants = screen.getByTestId('identity-surface-grants');
    expect(grants.querySelector('[data-optional="false"]')?.textContent).toContain('acme.search');
    expect(grants.querySelector('[data-optional="true"]')?.textContent).toContain('acme.mail');
    expect(screen.getByTestId('identity-surface-permissions').textContent).toContain('injects knowledge-pack acme.style');
  });

  it('omits empty groups and says so when an identity is content-only', () => {
    render(
      <IdentitySurface
        value={JSON.stringify({
          ...SURFACE,
          contributions: [],
          hooks: { sync: [], async: [], unreadable: [] },
          classContracts: [],
          grants: { requires: [], optional: [] },
          permissions: [],
          consent: 'content-only',
        })}
      />,
    );
    expect(screen.getByTestId('identity-surface').getAttribute('data-consent')).toBe('content-only');
    expect(screen.queryByTestId('identity-surface-contributions')).toBeNull();
    expect(screen.queryByTestId('identity-surface-permissions')).toBeNull();
    expect(screen.getByTestId('identity-surface').textContent).toContain('content only');
  });

  it('renders a notice, not a blank page, for a missing or unreadable surface', () => {
    for (const value of [null, '', 'not json', JSON.stringify({ schemaVersion: 1 })]) {
      const { unmount } = render(<IdentitySurface value={value} />);
      expect(screen.getByTestId('identity-surface').getAttribute('data-state')).toBe('unreadable');
      unmount();
    }
  });
});

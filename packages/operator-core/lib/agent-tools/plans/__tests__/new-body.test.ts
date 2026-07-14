/**
 * new-body.test.ts — plans:new one-call create-with-content (P-001,
 * cross-platform-hardening-and-agent-ergonomics-2026-07-05).
 *
 * buildTemplate composes the file bytes. Without `body` it emits the empty
 * starter template; with `body` it emits generated frontmatter + the caller's
 * body in ONE call (no set-content round-trip) — the fix for the plan-authoring
 * fumble where an agent had to create-template → get-version → set-content.
 */
import { describe, it, expect } from 'vitest';
import { buildTemplate } from '../new';

const base = {
  slug: 'x-plan-2026-07-05',
  title: 'X Plan',
  status: 'active',
  owner: null,
  date: '2026-07-05',
};

describe('plans:new buildTemplate — one-call body', () => {
  it('without body: emits the empty starter template with valid frontmatter', () => {
    const out = buildTemplate(base);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('slug: x-plan-2026-07-05');
    expect(out).toContain('# X Plan');
    expect(out).toContain('## Now');
    expect(out).toContain('Plan body to be filled in');
  });

  it('with body: emits frontmatter + the caller body, NOT the template', () => {
    const out = buildTemplate({ ...base, body: '# X Plan\n\n## Now\n\nReady.\n' });
    // Exactly ONE frontmatter block = 2 `---` delimiter lines (open + close).
    expect(out.match(/^---$/gm)?.length).toBe(2);
    expect(out).toContain('slug: x-plan-2026-07-05');
    expect(out).toContain('## Now\n\nReady.');
    // The empty-template placeholder must be gone.
    expect(out).not.toContain('Plan body to be filled in');
    // Exactly one blank line between frontmatter and body.
    expect(out).toMatch(/---\n\n# X Plan/);
  });

  it('with body: strips a caller-supplied frontmatter block (we own frontmatter)', () => {
    const withFm = '---\ntitle: WRONG\nslug: wrong\n---\n\n## Now\n\nBody.\n';
    const out = buildTemplate({ ...base, body: withFm });
    // Only ONE frontmatter block (2 delimiter lines), and it is OURS (correct slug).
    expect(out.match(/^---$/gm)?.length).toBe(2);
    expect(out).toContain('slug: x-plan-2026-07-05');
    expect(out).not.toContain('slug: wrong');
    expect(out).not.toContain('title: WRONG');
    expect(out).toContain('## Now\n\nBody.');
  });

  it('with a blank/whitespace body: falls back to the starter template', () => {
    const out = buildTemplate({ ...base, body: '   \n  ' });
    expect(out).toContain('Plan body to be filled in');
  });

  it('with owner: includes the owner frontmatter line', () => {
    const out = buildTemplate({ ...base, owner: 'a@b.com', body: '## Now\n\nx\n' });
    expect(out).toContain('owner: a@b.com');
  });
});

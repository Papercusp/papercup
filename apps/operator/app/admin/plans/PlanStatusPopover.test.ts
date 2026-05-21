// @vitest-environment jsdom
/**
 * Unit coverage for `resolveItemId` — the DOM-walking helper that
 * bridges read mode (where `decoratePlanDom` stamps `data-plan-item`
 * on the LI) and edit mode (where the IR pane has no data attribute,
 * just a leading `<strong>P-NNN</strong>` Lute renders). Both shapes
 * must return the same canonical item ID; non-item LIs must return
 * null so the popover doesn't try to flip something invalid.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveItemId } from './PlanStatusPopover';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('resolveItemId', () => {
  it('reads `data-plan-item` from the parent LI (read-mode shape)', () => {
    const host = mount(
      '<ul><li data-plan-item="P-001"><code data-plan-status="todo">todo</code></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBe('P-001');
  });

  it('reads the leading <strong>P-NNN</strong> when no data attribute (edit-mode IR shape)', () => {
    const host = mount(
      '<ul><li><strong>P-204</strong> <code data-plan-status="done">done</code> text</li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBe('P-204');
  });

  it('reads a leading D-NNN strong', () => {
    const host = mount(
      '<ul><li><strong>D-011</strong> <code data-plan-status="done">done</code></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBe('D-011');
  });

  it('returns null when the pill is not inside any LI (prose mention)', () => {
    const host = mount('<p>The word <code data-plan-status="done">done</code> in prose.</p>');
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBeNull();
  });

  it('returns null for an LI with no data-attr and no <strong>', () => {
    const host = mount('<ul><li><code data-plan-status="todo">todo</code></li></ul>');
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBeNull();
  });

  it('returns null when a <strong> exists but does not match the P/D pattern', () => {
    const host = mount(
      '<ul><li><strong>important</strong>: <code data-plan-status="todo">todo</code></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBeNull();
  });

  it('rejects too-short IDs (P-1, P-99) — only 3+ digit IDs match', () => {
    const host = mount(
      '<ul><li><strong>P-99</strong> <code data-plan-status="todo">todo</code></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBeNull();
  });

  it('finds the first matching <strong> even when there are multiple', () => {
    const host = mount(
      '<ul><li><strong>P-101</strong> mentions <strong>P-202</strong> <code data-plan-status="done">done</code></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBe('P-101');
  });

  it('prefers the LI data attribute over the strong when both are present', () => {
    const host = mount(
      '<ul><li data-plan-item="P-001"><strong>P-002</strong> <code data-plan-status="todo">todo</code></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    // Read-mode shape: the attribute is canonical.
    expect(resolveItemId(pill as HTMLElement)).toBe('P-001');
  });

  it('walks up multiple ancestor levels to find the LI', () => {
    const host = mount(
      '<ul><li data-plan-item="P-300"><div><span><code data-plan-status="wip">wip</code></span></div></li></ul>',
    );
    const pill = host.querySelector('[data-plan-status]')!;
    expect(resolveItemId(pill as HTMLElement)).toBe('P-300');
  });
});

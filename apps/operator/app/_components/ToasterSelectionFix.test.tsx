// @vitest-environment jsdom
/**
 * Tests for <ToasterSelectionFix> — restores native text selection inside
 * sonner toasts by stopping sonner's swipe-gesture pointerdown before it
 * captures the pointer.
 *
 * The component installs a capture-phase window `pointerdown` listener. On a
 * pointerdown whose target is inside a sonner toast `<li>` and NOT an
 * interactive control, it calls stopImmediatePropagation (so sonner never
 * sees it). Interactive controls + non-toast targets are left alone, and the
 * listener is removed on unmount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ToasterSelectionFix } from './ToasterSelectionFix';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** Build a sonner-shaped toast and return the inner nodes to dispatch from. */
function mountToast() {
  const ol = document.createElement('ol');
  ol.setAttribute('data-sonner-toaster', '');
  const li = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = 'Something failed';
  const closeBtn = document.createElement('button');
  li.append(text, closeBtn);
  ol.append(li);
  document.body.append(ol);
  return { text, closeBtn };
}

function firePointerDown(target: Element): Event {
  const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
  const spy = vi.spyOn(ev, 'stopImmediatePropagation');
  target.dispatchEvent(ev);
  return ev;
}

describe('ToasterSelectionFix', () => {
  it('stops the pointerdown on toast text so native selection can start', () => {
    render(<ToasterSelectionFix />);
    const { text } = mountToast();
    const ev = firePointerDown(text);
    expect(ev.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it('leaves interactive controls inside the toast alone', () => {
    render(<ToasterSelectionFix />);
    const { closeBtn } = mountToast();
    const ev = firePointerDown(closeBtn);
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('ignores pointerdowns outside any toast', () => {
    render(<ToasterSelectionFix />);
    const outside = document.createElement('div');
    document.body.append(outside);
    const ev = firePointerDown(outside);
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const { unmount } = render(<ToasterSelectionFix />);
    const { text } = mountToast();
    unmount();
    const ev = firePointerDown(text);
    expect(ev.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});

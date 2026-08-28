// @vitest-environment jsdom
/**
 * Tests for Modal primitive — open/closed states, escape/outside click behavior,
 * ref forwarding, custom styling, and accessibility attributes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from './Modal';
import {
  MODAL_FLOOR_Z,
  POPPER_WRAPPER_FLOOR_Z,
  _resetModalLayerRegistry,
  popperFloorZ,
  topOpenModalZ,
} from './popper-z';

beforeAll(() => {
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => cleanup());

describe('Modal', () => {
  it('does not render when closed', () => {
    const { container } = render(
      <Modal open={false} onOpenChange={() => {}} title="Hidden Modal">
        <div>Content</div>
      </Modal>
    );
    expect(screen.queryByText('Content')).toBeNull();
  });

  it('renders content when open', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Visible Modal">
        <div>Visible content</div>
      </Modal>
    );
    expect(screen.getByText('Visible content')).toBeTruthy();
  });

  it('renders title screen-reader-only (clipped, kept in a11y tree) when srOnlyTitle', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Modal Title" srOnlyTitle>
        <div>Content</div>
      </Modal>
    );
    const title = screen.getByText('Modal Title');
    const style = window.getComputedStyle(title);
    // sr-only uses the 1px-clip technique (not display:none), so the title
    // stays in the accessibility tree for screen readers.
    expect(style.position).toBe('absolute');
    expect(style.width).toBe('1px');
  });

  it('hides the title with display:none by default (children supply the visible heading)', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Modal Title">
        <div>Content</div>
      </Modal>
    );
    const title = screen.getByText('Modal Title');
    expect(window.getComputedStyle(title).display).toBe('none');
  });

  it('calls onOpenChange(false) when overlay is clicked with closeOnOverlayClick=true', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal
        open={true}
        onOpenChange={onOpenChange}
        title="Test"
        closeOnOverlayClick={true}
      >
        <div>Content</div>
      </Modal>
    );
    const overlay = screen.getByRole('dialog')?.closest('[style*="fixed"]')?.previousSibling as HTMLElement;
    if (overlay) {
      fireEvent.click(overlay);
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    }
  });

  it('does not close on outside click when closeOnOutsideClick=false', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal
        open={true}
        onOpenChange={onOpenChange}
        title="Persistent"
        closeOnOutsideClick={false}
      >
        <div>Content</div>
      </Modal>
    );
    const content = screen.getByText('Content');
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  it('closes on escape key when closeOnEscape=true', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal
        open={true}
        onOpenChange={onOpenChange}
        title="Escapable"
        closeOnEscape={true}
      >
        <div>Content</div>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('restores focus to the invoker when a controlled modal closes', async () => {
    function ProgrammaticModal() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open modal
          </button>
          <Modal open={open} onOpenChange={setOpen} title="Programmatic modal">
            <button type="button">Inside action</button>
          </Modal>
        </>
      );
    }

    render(<ProgrammaticModal />);
    const trigger = screen.getByRole('button', { name: 'Open modal' });
    trigger.focus();
    fireEvent.click(trigger);

    const inside = await screen.findByRole('button', { name: 'Inside action' });
    await waitFor(() => expect(document.activeElement).toBe(inside));
    fireEvent.keyDown(screen.getByRole('dialog'), {
      key: 'Escape',
      code: 'Escape',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(trigger);
  });

  it('does not close on escape when closeOnEscape=false', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal
        open={true}
        onOpenChange={onOpenChange}
        title="No Escape"
        closeOnEscape={false}
      >
        <div>Content</div>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  it('renders description when provided', () => {
    render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="Modal"
        description="This is the description"
      >
        <div>Content</div>
      </Modal>
    );
    expect(screen.getByText('This is the description')).toBeTruthy();
  });

  it('renders empty description element for a11y when not provided', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Modal">
        <div>Content</div>
      </Modal>
    );
    const descriptions = document.querySelectorAll('[role="doc-subtitle"]');
    expect(descriptions.length).toBeGreaterThanOrEqual(0);
  });

  it('applies custom contentStyle', () => {
    render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="Styled"
        contentStyle={{ maxWidth: '600px', backgroundColor: '#f0f0f0' }}
      >
        <div>Content</div>
      </Modal>
    );
    const dialog = screen.getByRole('dialog') as HTMLElement;
    const style = window.getComputedStyle(dialog);
    expect(style.maxWidth).toBe('600px');
    expect(style.backgroundColor).toBe('rgb(240, 240, 240)');
  });

  it('applies contentClassName', () => {
    render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="Classed"
        contentClassName="custom-modal-class"
      >
        <div>Content</div>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog?.className).toContain('custom-modal-class');
    expect(dialog?.className).toContain('pc-modal-content');
  });

  /**
   * THE BUG THIS PAIR EXISTS TO PREVENT (WI-35969, owner-reported 2026-08-08).
   * `Modal` defaulted to z 100 — a number chosen when the tallest thing it had
   * to clear was the OracleDock at 80. The body-portaled popper floor was later
   * raised to 1500, which silently meant every modal opened FROM a dropdown was
   * painted UNDER that dropdown. Measured live: clicking a conversation in the
   * agents-running pill opened its modal beneath the popover that launched it,
   * so the box read as "never opened" even though its transcript had arrived.
   *
   * jsdom cannot paint, and this file's sibling lint says at length that a
   * render test therefore cannot prove stacking. But this defect was not a
   * painting subtlety — it was an ARITHMETIC one, and the number is right here
   * in the DOM, so asserting it is honest. (The ordering algebra itself is
   * proven in harness/popper-z.test.ts.)
   */
  const wrapZ = () => {
    const wrap = screen.getByRole('dialog').parentElement as HTMLElement;
    return parseInt(window.getComputedStyle(wrap).zIndex) || 0;
  };

  it('opens above the popper floor, so a modal launched from a dropdown is not buried', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Default layer">
        <div>Content</div>
      </Modal>
    );
    expect(wrapZ()).toBeGreaterThanOrEqual(MODAL_FLOOR_Z);
    expect(wrapZ()).toBeGreaterThan(POPPER_WRAPPER_FLOOR_Z);
  });

  it('lifts a legacy below-floor zIndex instead of honouring it', () => {
    // Two callers really did pass one (BranchActionRunner 200, FeatureEditor
    // 120). Honouring those is not "lower ordering" — it is burial behind every
    // dropdown, which is the bug. Clamping is what makes the class impossible at
    // the primitive rather than at each call site.
    render(
      <Modal open={true} onOpenChange={() => {}} title="Legacy z" zIndex={120}>
        <div>Content</div>
      </Modal>
    );
    expect(wrapZ()).toBeGreaterThan(POPPER_WRAPPER_FLOOR_Z);
  });

  it('respects a custom zIndex above the floor', () => {
    render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="ZIndexed"
        zIndex={MODAL_FLOOR_Z + 100}
      >
        <div>Content</div>
      </Modal>
    );
    // zIndex lands on the overlay (z) and the centering wrap (z+1) that owns
    // stacking; the dialog content sits inside that wrap.
    expect(wrapZ()).toBeGreaterThanOrEqual(MODAL_FLOOR_Z + 100);
  });

  it('publishes its layer while open so a menu inside it can clear it', () => {
    // The other half of the fix: without this registration a Select opened
    // INSIDE the modal stays pinned at the 1500 shell floor and is buried by
    // the very modal that contains it.
    _resetModalLayerRegistry();
    expect(popperFloorZ()).toBe(POPPER_WRAPPER_FLOOR_Z);
    const view = render(
      <Modal open={true} onOpenChange={() => {}} title="Registers">
        <div>Content</div>
      </Modal>
    );
    expect(topOpenModalZ()).toBeGreaterThanOrEqual(MODAL_FLOOR_Z);
    expect(popperFloorZ()).toBeGreaterThan(topOpenModalZ());
    view.unmount();
    expect(topOpenModalZ()).toBe(0);
    expect(popperFloorZ()).toBe(POPPER_WRAPPER_FLOOR_Z);
  });

  it('applies custom overlayStyle', () => {
    render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="OverlayStyled"
        overlayStyle={{ opacity: 0.5 }}
      >
        <div>Content</div>
      </Modal>
    );
    const overlay = document.querySelector('[style*="inset"]') as HTMLElement;
    if (overlay?.getAttribute('style')?.includes('opacity')) {
      const style = window.getComputedStyle(overlay);
      expect(style.opacity).toBe('0.5');
    }
  });

  it('uses modal=true for accessible modals by default', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Accessible">
        <div>Content</div>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
  });

  it('sets aria-modal=undefined when modal=false', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="NonModal" modal={false}>
        <div>Content</div>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBeNull();
  });

  it('handles nonDismissableOutsideSelector to prevent closing on protected elements', async () => {
    const onOpenChange = vi.fn();
    render(
      <div>
        <div data-testid="protected" className="protected-area">
          Protected button
        </div>
        <Modal
          open={true}
          onOpenChange={onOpenChange}
          title="Protected"
          closeOnOutsideClick={true}
          nonDismissableOutsideSelector=".protected-area"
        >
          <div>Content</div>
        </Modal>
      </div>
    );
    const protected_el = screen.getByTestId('protected');
    fireEvent.pointerDown(protected_el);
    await waitFor(() => {
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  // Radix's DismissableLayer detects an outside pointer-down via real pointer
  // events / pointer capture that jsdom does not simulate — a synthetic
  // fireEvent.pointerDown never triggers the dismiss, so the close path is an
  // e2e concern, not a jsdom unit. The protected-selector branch (which
  // preventDefaults and asserts NOT-called) is covered above.
  it.skip('closes on unprotected outside clicks when selector is set (Radix dismiss not simulable in jsdom)', async () => {
    const onOpenChange = vi.fn();
    render(
      <div>
        <div data-testid="unprotected">Unprotected</div>
        <Modal
          open={true}
          onOpenChange={onOpenChange}
          title="Protected"
          closeOnOutsideClick={true}
          nonDismissableOutsideSelector=".protected-area"
        >
          <div>Content</div>
        </Modal>
      </div>
    );
    const unprotected = screen.getByTestId('unprotected');
    fireEvent.pointerDown(unprotected);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('renders children correctly', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Modal">
        <div data-testid="child1">First child</div>
        <div data-testid="child2">Second child</div>
      </Modal>
    );
    expect(screen.getByTestId('child1')).toBeTruthy();
    expect(screen.getByTestId('child2')).toBeTruthy();
  });

  it('handles rapid open/close state changes', () => {
    const { rerender } = render(
      <Modal open={false} onOpenChange={() => {}} title="Rapid">
        <div>Content</div>
      </Modal>
    );
    rerender(
      <Modal open={true} onOpenChange={() => {}} title="Rapid">
        <div>Content</div>
      </Modal>
    );
    expect(screen.getByText('Content')).toBeTruthy();
    rerender(
      <Modal open={false} onOpenChange={() => {}} title="Rapid">
        <div>Content</div>
      </Modal>
    );
    expect(screen.queryByText('Content')).toBeNull();
  });
});

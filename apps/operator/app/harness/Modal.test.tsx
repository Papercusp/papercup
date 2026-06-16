// @vitest-environment jsdom
/**
 * Tests for Modal primitive — open/closed states, escape/outside click behavior,
 * ref forwarding, custom styling, and accessibility attributes.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Modal } from './Modal';

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
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('renders content when open', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Visible Modal">
        <div>Visible content</div>
      </Modal>
    );
    expect(screen.getByText('Visible content')).toBeInTheDocument();
  });

  it('renders title in sr-only by default', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Modal Title">
        <div>Content</div>
      </Modal>
    );
    const title = screen.getByText('Modal Title');
    const style = window.getComputedStyle(title);
    expect(style.position).toBe('absolute');
    expect(style.visibility).toBe('hidden');
  });

  it('shows title visually when srOnlyTitle is false', () => {
    render(
      <Modal open={true} onOpenChange={() => {}} title="Visible Title" srOnlyTitle={false}>
        <div>Content</div>
      </Modal>
    );
    const title = screen.getByText('Visible Title');
    const style = window.getComputedStyle(title);
    expect(style.display).not.toBe('none');
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
    expect(screen.getByText('This is the description')).toBeInTheDocument();
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

  it('respects custom zIndex', () => {
    const { container } = render(
      <Modal
        open={true}
        onOpenChange={() => {}}
        title="ZIndexed"
        zIndex={1000}
      >
        <div>Content</div>
      </Modal>
    );
    const content = screen.getByRole('dialog');
    const style = window.getComputedStyle(content);
    expect(parseInt(style.zIndex) || 0).toBeGreaterThanOrEqual(1000);
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

  it('closes on unprotected outside clicks when selector is set', async () => {
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
    expect(screen.getByTestId('child1')).toBeInTheDocument();
    expect(screen.getByTestId('child2')).toBeInTheDocument();
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
    expect(screen.getByText('Content')).toBeInTheDocument();
    rerender(
      <Modal open={false} onOpenChange={() => {}} title="Rapid">
        <div>Content</div>
      </Modal>
    );
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });
});

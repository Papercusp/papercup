'use client';

import * as Dialog from '@radix-ui/react-dialog';
import type { CSSProperties, ReactNode } from 'react';
import './Modal.css';

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.75)',
  zIndex: 60,
};

const CONTENT_WRAP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 61,
  pointerEvents: 'none', // overlay handles backdrop clicks; content gets its own
  padding: '2rem',
};

const CONTENT_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  outline: 'none',
  // The wrap insets the content by 2rem on every side; cap the box to the
  // remaining viewport and scroll internally so a tall dialog (e.g. a create
  // success card with an invite secret + warnings) can never overflow past the
  // backdrop and leave nothing to click-away on. Per-modal contentStyle (spread
  // after this) can still override.
  maxHeight: 'calc(100vh - 4rem)',
  overflowY: 'auto',
};

const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/**
 * Modal — Radix Dialog wrapper that matches the harness's centered modal
 * pattern. Use:
 *   <Modal open={open} onOpenChange={setOpen} title="My modal">
 *     <inner content />
 *   </Modal>
 *
 * `title` is required for screen readers. Pass `srOnlyTitle` to hide it.
 * `description` similarly maps to Dialog.Description.
 *
 * Use `contentStyle` to override sizing; the wrapper centers it. Use
 * `overlayStyle` to tweak backdrop (e.g., higher z-index/partial scrim).
 * `closeOnOverlayClick` can keep a scrim dismissible even when
 * `closeOnOutsideClick={false}` preserves live persistent chrome.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  srOnlyTitle = false,
  description,
  children,
  contentStyle,
  contentClassName,
  overlayStyle,
  zIndex,
  closeOnEscape = true,
  closeOnOutsideClick = true,
  closeOnOverlayClick = closeOnOutsideClick,
  modal = true,
  nonDismissableOutsideSelector,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  srOnlyTitle?: boolean;
  description?: string;
  children: ReactNode;
  contentStyle?: CSSProperties;
  contentClassName?: string;
  overlayStyle?: CSSProperties;
  zIndex?: number;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
  closeOnOverlayClick?: boolean;
  modal?: boolean;
  /**
   * Outside clicks matching this selector are allowed to reach the target
   * without dismissing the dialog. Use sparingly for persistent app chrome
   * that must remain live while a modal-like surface is open.
   */
  nonDismissableOutsideSelector?: string;
}) {
  // Default to 100 so modals render above the persistent OracleDock (z:80).
  const z = zIndex ?? 100;
  const overlay = { ...OVERLAY_STYLE, zIndex: z, ...overlayStyle };
  const wrap = { ...CONTENT_WRAP_STYLE, zIndex: z + 1 };
  const content = { ...CONTENT_STYLE, ...contentStyle };
  const keepAllowedOutsideInteractionOpen = (event: {
    target: EventTarget | null;
    detail?: { originalEvent?: Event };
    preventDefault: () => void;
  }) => {
    if (!closeOnOutsideClick) {
      event.preventDefault();
      return;
    }
    const target = event.detail?.originalEvent?.target ?? event.target;
    if (
      nonDismissableOutsideSelector
      && target instanceof Element
      && target.closest(nonDismissableOutsideSelector)
    ) {
      event.preventDefault();
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Dialog.Portal>
        {modal ? (
          <Dialog.Overlay
            data-anim="fade"
            style={overlay}
            onClick={closeOnOverlayClick ? () => onOpenChange(false) : undefined}
          />
        ) : (
          <div
            aria-hidden="true"
            data-anim="fade"
            style={overlay}
            onClick={closeOnOverlayClick ? () => onOpenChange(false) : undefined}
          />
        )}
        <div style={wrap}>
          <Dialog.Content
            aria-modal={modal ? 'true' : undefined}
            className={contentClassName ? `pc-modal-content ${contentClassName}` : 'pc-modal-content'}
            data-anim="pop"
            style={content}
            onEscapeKeyDown={closeOnEscape ? undefined : (e) => e.preventDefault()}
            onPointerDownOutside={keepAllowedOutsideInteractionOpen}
            onInteractOutside={keepAllowedOutsideInteractionOpen}
          >
            <Dialog.Title style={srOnlyTitle ? SR_ONLY_STYLE : { display: 'none' }}>
              {title}
            </Dialog.Title>
            {/*
             * Always render Dialog.Description (sr-only when no description
             * passed). Radix emits an a11y warning whenever the rendered
             * Dialog.Content has no descendant Description and no explicit
             * aria-describedby. Empty string is fine for screen readers —
             * Title carries the meaning.
             */}
            <Dialog.Description style={SR_ONLY_STYLE}>
              {description ?? ''}
            </Dialog.Description>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

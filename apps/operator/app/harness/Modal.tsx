'use client';

import * as Dialog from '@radix-ui/react-dialog';
import type { CSSProperties, ReactNode } from 'react';

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
 * `overlayStyle` to tweak backdrop (e.g., higher z-index).
 *
 * To prevent outside-click dismissal, pass `onPointerDownOutside={(e) => e.preventDefault()}`.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  srOnlyTitle = false,
  description,
  children,
  contentStyle,
  overlayStyle,
  zIndex,
  closeOnEscape = true,
  closeOnOutsideClick = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  srOnlyTitle?: boolean;
  description?: string;
  children: ReactNode;
  contentStyle?: CSSProperties;
  overlayStyle?: CSSProperties;
  zIndex?: number;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
}) {
  // Default to 100 so modals render above the persistent OracleDock (z:80).
  const z = zIndex ?? 100;
  const overlay = { ...OVERLAY_STYLE, zIndex: z, ...overlayStyle };
  const wrap = { ...CONTENT_WRAP_STYLE, zIndex: z + 1 };
  const content = { ...CONTENT_STYLE, ...contentStyle };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay data-anim="fade" style={overlay} />
        <div style={wrap}>
          <Dialog.Content
            data-anim="pop"
            style={content}
            onEscapeKeyDown={closeOnEscape ? undefined : (e) => e.preventDefault()}
            onPointerDownOutside={closeOnOutsideClick ? undefined : (e) => e.preventDefault()}
            onInteractOutside={closeOnOutsideClick ? undefined : (e) => e.preventDefault()}
          >
            {srOnlyTitle ? (
              <Dialog.Title style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
                {title}
              </Dialog.Title>
            ) : (
              <Dialog.Title style={{ display: 'none' }}>{title}</Dialog.Title>
            )}
            {/*
             * Always render Dialog.Description (sr-only when no description
             * passed). Radix emits an a11y warning whenever the rendered
             * Dialog.Content has no descendant Description and no explicit
             * aria-describedby. Empty string is fine for screen readers —
             * Title carries the meaning.
             */}
            <Dialog.Description style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
              {description ?? ''}
            </Dialog.Description>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

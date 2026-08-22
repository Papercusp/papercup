export const OPERATOR_CHAT_OPEN_QUERY_KEY = 'chat';
export const OPERATOR_CHAT_COLLAPSED_WIDTH = 56;
// No real minimum on the open panel beyond the collapsed-rail width — the
// resize handle can drag it all the way down to the rail. (Was 360, which
// floored the panel uncomfortably wide on small screens / split layouts.)
export const OPERATOR_CHAT_MIN_WIDTH = OPERATOR_CHAT_COLLAPSED_WIDTH;
export const OPERATOR_CHAT_DEFAULT_WIDTH = 360;

export function operatorChatWidthCeiling(viewportWidth: number): number {
  return Math.max(OPERATOR_CHAT_MIN_WIDTH, Math.floor(viewportWidth * 0.75));
}

export function clampOperatorChatWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return OPERATOR_CHAT_DEFAULT_WIDTH;
  return Math.max(OPERATOR_CHAT_MIN_WIDTH, Math.min(operatorChatWidthCeiling(viewportWidth), width));
}

/**
 * Convert a viewport pointer coordinate into the middle chat pane's own width.
 *
 * The steering/settings rail is now the leftmost dock, so the chat resize
 * handle's clientX includes that rail. Keeping this subtraction in the pure
 * layout module makes the pane-order contract unit-testable instead of hiding
 * it in a pointer handler.
 */
export function operatorChatWidthFromPointer(
  clientX: number,
  leftSidebarWidth: number,
  viewportWidth: number,
): number {
  const left = Number.isFinite(leftSidebarWidth) ? Math.max(0, leftSidebarWidth) : 0;
  return clampOperatorChatWidth(clientX - left, viewportWidth);
}

export function operatorChatOffsetWidth(isOpen: boolean, width: number, viewportWidth: number): number {
  return isOpen
    ? clampOperatorChatWidth(width, viewportWidth)
    : OPERATOR_CHAT_COLLAPSED_WIDTH;
}

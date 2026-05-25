export const OPERATOR_CHAT_OPEN_QUERY_KEY = 'chat';
export const OPERATOR_CHAT_MIN_WIDTH = 360;
export const OPERATOR_CHAT_DEFAULT_WIDTH = 360;
export const OPERATOR_CHAT_COLLAPSED_WIDTH = 56;

export function operatorChatWidthCeiling(viewportWidth: number): number {
  return Math.max(OPERATOR_CHAT_MIN_WIDTH, Math.floor(viewportWidth * 0.75));
}

export function clampOperatorChatWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return OPERATOR_CHAT_DEFAULT_WIDTH;
  return Math.max(OPERATOR_CHAT_MIN_WIDTH, Math.min(operatorChatWidthCeiling(viewportWidth), width));
}

export function operatorChatOffsetWidth(isOpen: boolean, width: number, viewportWidth: number): number {
  return isOpen
    ? clampOperatorChatWidth(width, viewportWidth)
    : OPERATOR_CHAT_COLLAPSED_WIDTH;
}

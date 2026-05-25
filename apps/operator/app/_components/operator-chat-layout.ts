const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 360;

export function operatorChatWidthCeiling(viewportWidth: number): number {
  return Math.max(MIN_WIDTH, Math.floor(viewportWidth * 0.75));
}

export function clampOperatorChatWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(operatorChatWidthCeiling(viewportWidth), width));
}

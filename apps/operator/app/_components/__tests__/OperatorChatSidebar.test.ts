/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
  OPERATOR_CHAT_COLLAPSED_WIDTH,
  clampOperatorChatWidth,
  operatorChatOffsetWidth,
  operatorChatWidthCeiling,
} from '../operator-chat-layout';

describe('OperatorChatSidebar layout helpers', () => {
  it('computes a viewport-based ceiling with a minimum floor', () => {
    // MIN_WIDTH was lowered to the collapsed width (56) so the resize handle can
    // drag to the rail, so 75% of 300 (=225) now wins over the floor.
    expect(operatorChatWidthCeiling(300)).toBe(225);
    expect(operatorChatWidthCeiling(1200)).toBe(900);
  });

  it('floors the 75% ceiling to whole pixels', () => {
    expect(operatorChatWidthCeiling(1001)).toBe(750);
  });

  it('clamps stored or dragged widths into the allowed range', () => {
    expect(clampOperatorChatWidth(NaN, 1200)).toBe(360); // non-finite → DEFAULT_WIDTH
    expect(clampOperatorChatWidth(200, 1200)).toBe(200);  // ≥ MIN_WIDTH (56) now, so kept
    expect(clampOperatorChatWidth(500, 1200)).toBe(500);
    expect(clampOperatorChatWidth(2000, 1200)).toBe(900);
  });

  it('reclamps a previously valid width when the viewport later shrinks', () => {
    expect(clampOperatorChatWidth(900, 1200)).toBe(900);
    expect(clampOperatorChatWidth(900, 800)).toBe(600);
  });

  it('uses a slim offset when the chat is collapsed', () => {
    expect(operatorChatOffsetWidth(false, 900, 1200)).toBe(OPERATOR_CHAT_COLLAPSED_WIDTH);
    expect(operatorChatOffsetWidth(true, 900, 1200)).toBe(900);
  });
});

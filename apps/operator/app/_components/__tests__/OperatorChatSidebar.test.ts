/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { clampOperatorChatWidth, operatorChatWidthCeiling } from '../operator-chat-layout';

describe('OperatorChatSidebar layout helpers', () => {
  it('computes a viewport-based ceiling with a minimum floor', () => {
    expect(operatorChatWidthCeiling(300)).toBe(360);
    expect(operatorChatWidthCeiling(1200)).toBe(900);
  });

  it('clamps stored or dragged widths into the allowed range', () => {
    expect(clampOperatorChatWidth(NaN, 1200)).toBe(360);
    expect(clampOperatorChatWidth(200, 1200)).toBe(360);
    expect(clampOperatorChatWidth(500, 1200)).toBe(500);
    expect(clampOperatorChatWidth(2000, 1200)).toBe(900);
  });
});

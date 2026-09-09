import { expect, it } from 'vitest';
it('preserves the assertion values', () => {
  expect({ service_select: false, other: 'actual' }).toEqual({ service_select: true, other: 'expected' });
});

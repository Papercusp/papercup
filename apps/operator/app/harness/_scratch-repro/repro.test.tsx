// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { useState, useEffect, StrictMode } from 'react';
import { Tooltip } from '../Tooltip';

function Harness() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n < 40) {
      // force rapid re-renders of the parent, each producing a FRESH <button>
      // child element for Tooltip (new JSX identity every time — same as
      // ColumnFilterBar re-rendering its chips on every parent render).
      queueMicrotask(() => setN((x) => x + 1));
    }
  }, [n]);
  return (
    <Tooltip label="Edit filter">
      <button type="button">chip {n}</button>
    </Tooltip>
  );
}

describe('repro: Tooltip under rapid parent re-renders', () => {
  it('does not throw Maximum update depth exceeded', async () => {
    let caught: unknown = null;
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      const s = String(args[0]);
      if (s.includes('Maximum update depth')) caught = s;
    };
    try {
      render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      caught = e;
    } finally {
      console.error = orig;
    }
    expect(caught).toBeNull();
  });
});

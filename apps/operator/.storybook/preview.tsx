import type { Preview } from '@storybook/react-vite';
import { useEffect } from 'react';
import '../app/globals.css';

/**
 * Operator stories must NEVER hit the operator's real backend. Default
 * fetch returns 200 with `{ ok: true }`; per-story decorators can
 * override with richer mocks.
 */
function BlockFetch() {
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      // Story decorators can override by setting window.__fetchMocks
      const mocks = (window as any).__fetchMocks as Record<string, unknown> | undefined;
      if (mocks) {
        for (const [pattern, body] of Object.entries(mocks)) {
          if (url.includes(pattern)) {
            return new Response(JSON.stringify(body), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    return () => { window.fetch = original; };
  }, []);
  return null;
}

const preview: Preview = {
  decorators: [
    (Story) => (
      <>
        <BlockFetch />
        <Story />
      </>
    ),
  ],
  parameters: {
    backgrounds: {
      default: 'operator',
      values: [
        { name: 'operator', value: '#0c0e16' },
        { name: 'light',    value: '#ffffff' },
      ],
    },
    layout: 'padded',
  },
};

export default preview;

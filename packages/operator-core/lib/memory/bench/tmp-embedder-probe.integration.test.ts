// TEMPORARY diagnostic probe — delete after diagnosing the P-002 embedder path.
import { describe, it } from 'vitest';

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(
  s: string,
) => Promise<T>;

describe('embedder resolution under vitest', () => {
  it('reports why @huggingface/transformers does or does not resolve', async () => {
    try {
      await dynamicImport('@huggingface/transformers');
      console.log('PROBE: new Function import OK');
    } catch (e) {
      console.log('PROBE: new Function import FAILED:', (e as Error).message.slice(0, 400));
    }
    try {
      await import(/* @vite-ignore */ '@huggingface/transformers');
      console.log('PROBE: direct import OK');
    } catch (e) {
      console.log('PROBE: direct import FAILED:', (e as Error).message.slice(0, 400));
    }
    const { localAvailable } = await import('../configure');
    console.log('PROBE: localAvailable() =', await localAvailable());
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { parseOllamaRef, resolveOllamaWeights } from './weights';

describe('parseOllamaRef', () => {
  it('parses namespace/name:tag', () => {
    expect(parseOllamaRef('maxwell1500/ornith-35b:IQ3_M')).toEqual({ namespace: 'maxwell1500', name: 'ornith-35b', tag: 'IQ3_M' });
  });
  it('defaults namespace to library when absent', () => {
    expect(parseOllamaRef('qwen2.5-coder:latest')).toEqual({ namespace: 'library', name: 'qwen2.5-coder', tag: 'latest' });
  });
  it('defaults tag to latest when absent', () => {
    expect(parseOllamaRef('library/gemma4')).toEqual({ namespace: 'library', name: 'gemma4', tag: 'latest' });
  });
  it('handles a bare model name (no namespace, no tag)', () => {
    expect(parseOllamaRef('ornith')).toEqual({ namespace: 'library', name: 'ornith', tag: 'latest' });
  });
});

describe('resolveOllamaWeights', () => {
  const manifest = JSON.stringify({
    layers: [
      { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:aaaa' },
      { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:18f775956e1ee0' },
    ],
  });

  it('resolves an already-pulled blob (real ornith-box manifest shape)', async () => {
    const root = '/usr/share/ollama/.ollama/models';
    const manifestPath = `${root}/manifests/registry.ollama.ai/maxwell1500/ornith-35b/IQ3_M`;
    const blobPath = `${root}/blobs/sha256-18f775956e1ee0`;
    const plan = await resolveOllamaWeights('maxwell1500/ornith-35b:IQ3_M', {
      candidateRoots: [root],
      exists: (p) => p === manifestPath || p === blobPath,
      readFile: async (p) => (p === manifestPath ? manifest : (() => { throw new Error('unexpected read'); })()),
    });
    expect(plan.needsDownload).toBe(false);
    expect(plan.weightsPath).toBe(blobPath);
  });

  it('returns a pull hint when no root has the manifest', async () => {
    const plan = await resolveOllamaWeights('maxwell1500/ornith-35b:IQ3_M', {
      candidateRoots: ['/nowhere/a', '/nowhere/b'],
      exists: () => false,
      readFile: async () => { throw new Error('should not read'); },
    });
    expect(plan.needsDownload).toBe(true);
    expect(plan.pullHint).toBe('ollama pull maxwell1500/ornith-35b:IQ3_M');
  });

  it('returns a pull hint when the manifest exists but the blob is missing (partial pull)', async () => {
    const root = '/root';
    const manifestPath = `${root}/manifests/registry.ollama.ai/library/ornith/latest`;
    const plan = await resolveOllamaWeights('ornith', {
      candidateRoots: [root],
      exists: (p) => p === manifestPath, // blob path never matches
      readFile: async () => manifest,
    });
    expect(plan.needsDownload).toBe(true);
  });

  it('falls through to the next root on a malformed manifest rather than throwing', async () => {
    const badRoot = '/bad';
    const goodRoot = '/good';
    const badManifestPath = `${badRoot}/manifests/registry.ollama.ai/library/x/latest`;
    const goodManifestPath = `${goodRoot}/manifests/registry.ollama.ai/library/x/latest`;
    const goodBlobPath = `${goodRoot}/blobs/sha256-18f775956e1ee0`;
    const plan = await resolveOllamaWeights('x', {
      candidateRoots: [badRoot, goodRoot],
      exists: (p) => p === badManifestPath || p === goodManifestPath || p === goodBlobPath,
      readFile: async (p) => (p === badManifestPath ? '{not json' : manifest),
    });
    expect(plan.needsDownload).toBe(false);
    expect(plan.weightsPath).toBe(goodBlobPath);
  });

  it('defaults candidateRoots from OLLAMA_MODELS/HOME env when not injected (no throw)', async () => {
    const plan = await resolveOllamaWeights('some/model:tag', { exists: () => false, readFile: async () => '' });
    expect(plan.needsDownload).toBe(true);
  });
});

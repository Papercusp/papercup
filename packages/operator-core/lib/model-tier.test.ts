import { describe, it, expect } from 'vitest';
import { modelCapabilityTier, isWeakModel } from './model-tier';

describe('modelCapabilityTier', () => {
  it('classifies ollama/local models as weak (regardless of quant/effort suffix)', () => {
    expect(modelCapabilityTier('ollama/maxwell1500/ornith-35b:IQ3_M:xhigh')).toBe('weak');
    expect(modelCapabilityTier('ollama/qwen3.5:latest')).toBe('weak');
    expect(modelCapabilityTier('ollama/qwen3-coder:30b')).toBe('weak');
    expect(modelCapabilityTier('local/foo')).toBe('weak');
    expect(modelCapabilityTier('llamacpp/bar')).toBe('weak');
  });

  it('is case-insensitive on the provider prefix', () => {
    expect(modelCapabilityTier('LMStudio/some-model')).toBe('weak');
    expect(modelCapabilityTier('OLLAMA/ornith')).toBe('weak');
  });

  it('classifies hosted frontier models as frontier', () => {
    expect(modelCapabilityTier('anthropic/claude-opus-4-6:high')).toBe('frontier');
    expect(modelCapabilityTier('anthropic/claude-opus-4-8')).toBe('frontier');
    expect(modelCapabilityTier('openai/gpt-5')).toBe('frontier');
    expect(modelCapabilityTier('google/gemini-2.5-pro')).toBe('frontier');
  });

  it('defaults unknown / prefix-less / empty ids to frontier (safe: never trim a strong model)', () => {
    expect(modelCapabilityTier('claude-opus-4-8')).toBe('frontier'); // no provider prefix
    expect(modelCapabilityTier('')).toBe('frontier');
    expect(modelCapabilityTier('   ')).toBe('frontier');
    expect(modelCapabilityTier(null)).toBe('frontier');
    expect(modelCapabilityTier(undefined)).toBe('frontier');
  });

  it('isWeakModel mirrors the tier', () => {
    expect(isWeakModel('ollama/ornith-35b')).toBe(true);
    expect(isWeakModel('anthropic/claude-opus-4-8')).toBe(false);
    expect(isWeakModel(null)).toBe(false);
  });
});

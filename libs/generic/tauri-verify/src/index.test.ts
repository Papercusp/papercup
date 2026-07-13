import { describe, it, expect } from 'vitest';
import { createVerifier } from './index.js';
import { findScreen, SCREENS } from './screens.js';

describe('Tauri Verification Surface', () => {
  describe('createVerifier', () => {
    it('creates a verifier with default config', () => {
      const verifier = createVerifier();
      const config = verifier.config();

      expect(config.bridgePort).toBe(42391);
      expect(config.timeout).toBe(10000);
      expect(config.apiBaseUrl).toBe('http://127.0.0.1:3270');
    });

    it('creates a verifier with custom config', () => {
      const verifier = createVerifier({
        bridgePort: 5555,
        timeout: 20000,
        apiBaseUrl: 'http://localhost:3000',
      });
      const config = verifier.config();

      expect(config.bridgePort).toBe(5555);
      expect(config.timeout).toBe(20000);
      expect(config.apiBaseUrl).toBe('http://localhost:3000');
    });

    it('merges partial config with defaults', () => {
      const verifier = createVerifier({ bridgePort: 9999 });
      const config = verifier.config();

      expect(config.bridgePort).toBe(9999);
      expect(config.timeout).toBe(10000);
      expect(config.apiBaseUrl).toBe('http://127.0.0.1:3270');
    });
  });

  describe('Semantic Screens', () => {
    it('defines standard screens', () => {
      expect(SCREENS.ONBOARDING).toBeDefined();
      expect(SCREENS.LOGIN).toBeDefined();
      expect(SCREENS.ADVANCED).toBeDefined();
      expect(SCREENS.HARNESS_HOME).toBeDefined();
      expect(SCREENS.SETTINGS).toBeDefined();
      expect(SCREENS.ADMIN).toBeDefined();
    });

    it('finds screen by ID', () => {
      const screen = findScreen('onboarding');
      expect(screen).toBeDefined();
      expect(screen?.id).toBe('onboarding');
      expect(screen?.name).toBe('Setup Wizard');
    });

    it('returns undefined for unknown screen ID', () => {
      const screen = findScreen('unknown-screen');
      expect(screen).toBeUndefined();
    });

    it('screen has proper route pattern', () => {
      const screen = SCREENS.ADVANCED;
      expect(screen.route).toBeInstanceOf(RegExp);
      expect((screen.route as RegExp).test('/adv')).toBe(true);
      expect((screen.route as RegExp).test('/adv?tab=harnesses')).toBe(true);
      expect((screen.route as RegExp).test('/settings')).toBe(false);
    });

    it('screen has required elements defined', () => {
      const screen = SCREENS.ADVANCED;
      expect(screen.requiredElements).toBeDefined();
      expect(Array.isArray(screen.requiredElements)).toBe(true);
      expect(screen.requiredElements?.length).toBeGreaterThan(0);
    });
  });

  describe('Verifier interface', () => {
    it('has all required methods', () => {
      const verifier = createVerifier();

      expect(typeof verifier.appReady).toBe('function');
      expect(typeof verifier.route).toBe('function');
      expect(typeof verifier.scope).toBe('function');
      expect(typeof verifier.navigateToScreen).toBe('function');
      expect(typeof verifier.currentScreen).toBe('function');
      expect(typeof verifier.config).toBe('function');
    });
  });

  describe('VerifyResult type', () => {
    it('represents success result', () => {
      const result: { ok: true; value: string } = {
        ok: true,
        value: 'success',
      };

      expect(result.ok).toBe(true);
      expect(result.value).toBe('success');
    });

    it('represents error result', () => {
      const result: { ok: false; error: string } = {
        ok: false,
        error: 'Something went wrong',
      };

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Something went wrong');
    });
  });
});

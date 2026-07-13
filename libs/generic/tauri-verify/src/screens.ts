/**
 * Semantic screen identifiers for Papercusp operator.
 * Maps meaningful screen names to routes and required UI elements.
 */

import type { Screen } from './types.js';

/**
 * Define a semantic screen with verification requirements.
 */
function defineScreen(config: {
  id: string;
  name: string;
  route: string | RegExp;
  requiredElements?: string[];
}): Screen {
  return {
    id: config.id,
    name: config.name,
    route: config.route,
    requiredElements: config.requiredElements,
  };
}

/**
 * Semantic screens for Papercusp operator.
 * Each screen corresponds to a testable UI surface.
 */
export const SCREENS = {
  // Onboarding & Auth
  ONBOARDING: defineScreen({
    id: 'onboarding',
    name: 'Setup Wizard',
    route: /^\/setup/,
    requiredElements: ['[data-screen="setup-wizard"]'],
  }),

  LOGIN: defineScreen({
    id: 'login',
    name: 'Login',
    route: /^\/auth\/login/,
    requiredElements: ['[data-screen="login"]'],
  }),

  // Main operator surface
  ADVANCED: defineScreen({
    id: 'advanced',
    name: 'Advanced Surface',
    route: /^\/adv/,
    requiredElements: ['[data-screen="adv-shell"]'],
  }),

  HARNESS_HOME: defineScreen({
    id: 'harness-home',
    name: 'Harness Home',
    route: /^\/adv\?.*tab=harnesses/,
    requiredElements: ['[data-screen="harness-dock-shell"]'],
  }),

  HARNESS_DETAIL: defineScreen({
    id: 'harness-detail',
    name: 'Harness Detail',
    route: /^\/adv\/harness\/[^/]+/,
    requiredElements: ['[data-screen="harness-detail"]'],
  }),

  WORK_ITEMS: defineScreen({
    id: 'work-items',
    name: 'Work Items',
    route: /^\/adv\?.*tab=work-items/,
    requiredElements: ['[data-screen="work-items-panel"]'],
  }),

  // Settings & admin
  SETTINGS: defineScreen({
    id: 'settings',
    name: 'Settings',
    route: /^\/settings/,
    requiredElements: ['[data-screen="settings"]'],
  }),

  ADMIN: defineScreen({
    id: 'admin',
    name: 'Admin',
    route: /^\/admin/,
    requiredElements: ['[data-screen="admin-shell"]'],
  }),
};

/**
 * Find a screen by ID.
 */
export function findScreen(id: string): Screen | undefined {
  return Object.values(SCREENS).find((s) => s.id === id);
}

/**
 * Find a screen by route pathname.
 */
export function findScreenByRoute(pathname: string): Screen | undefined {
  return Object.values(SCREENS).find((s) => {
    if (typeof s.route === 'string') {
      return pathname === s.route;
    }
    return s.route.test(pathname);
  });
}

/**
 * Get all defined screens.
 */
export function getAllScreens(): Screen[] {
  return Object.values(SCREENS);
}

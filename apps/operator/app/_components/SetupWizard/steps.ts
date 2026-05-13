import type { StepDef } from './types';

export const SETUP_STEPS: readonly StepDef[] = [
  {
    id: 'os-permissions',
    title: 'OS permissions',
    summary: 'Microphone, notifications, and (macOS) accessibility access.',
    required: false,
  },
  {
    id: 'embedded-pg',
    title: 'Local database',
    summary: 'Embedded Postgres bootstrap — bundled with the desktop app.',
    required: true,
  },
  {
    id: 'workspace',
    title: 'Workspace folder',
    summary: 'Where Papercusp stores your projects.',
    required: true,
  },
  {
    id: 'agents',
    title: 'Coding agents',
    summary: 'Install Claude Code and/or oh-my-pi. At least one is required.',
    required: true,
  },
  {
    id: 'logins',
    title: 'Sign in to your accounts',
    summary: 'Uses your existing Claude or OpenAI plan. No per-token charges.',
    required: false,
  },
  {
    id: 'keys',
    title: 'API keys',
    summary: 'Pay-per-use providers for embeddings and voice. Optional.',
    required: false,
  },
  {
    id: 'git',
    title: 'Git identity',
    summary: 'Name + email for commits, and optional GitHub sign-in.',
    required: false,
  },
  {
    id: 'voice-devices',
    title: 'Voice devices',
    summary: 'Pick a microphone and speaker, then test them.',
    required: false,
  },
  {
    id: 'mobile-pairing',
    title: 'Mobile pairing',
    summary: 'Pair the companion app via QR code.',
    required: false,
  },
  {
    id: 'backups',
    title: 'Backups',
    summary: 'Local snapshot layer that protects against agent mistakes.',
    required: false,
  },
  {
    id: 'auto-update',
    title: 'Update channel',
    summary: 'Choose alpha, beta, or stable releases.',
    required: false,
  },
  {
    id: 'telemetry',
    title: 'Telemetry & crash reports',
    summary: 'Help us find bugs by sending anonymized diagnostics.',
    required: false,
  },
] as const;

export function findStep(id: string | null | undefined): StepDef | undefined {
  if (!id) return undefined;
  return SETUP_STEPS.find((s) => s.id === id);
}

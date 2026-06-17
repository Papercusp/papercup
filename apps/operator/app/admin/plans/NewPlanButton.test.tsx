// @vitest-environment jsdom
/**
 * NewPlanButton.test — the explicit owning-hive choice at plan creation
 * (steering-nested-hive-plan-tree-2026-06-17, P-005).
 *
 * Concrete scope → a plain button that launches in that scope. Ambiguous scope
 * (no active pot) → a menu forcing an EXPLICIT owning-hive choice instead of the
 * silent `all`-scope default that orphaned 4 plans on 2026-06-17.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import NewPlanButton, { ownerHiveOptions, type NewPlanProject } from './NewPlanButton';

const PROJECTS: NewPlanProject[] = [
  { slug: 'papercup-hive', harness_kind: 'hive' },
  { slug: 'pot-a', hive_slug: 'papercup-hive' },
  { slug: 'standalone', harness_kind: null },
];

afterEach(cleanup);

describe('ownerHiveOptions', () => {
  it('flattens hive roots then their members', () => {
    expect(ownerHiveOptions(PROJECTS)).toEqual([
      { value: 'papercup-hive', label: 'papercup-hive', member: false },
      { value: 'pot-a', label: 'pot-a', member: true },
      { value: 'standalone', label: 'standalone', member: false },
    ]);
  });
});

describe('NewPlanButton', () => {
  it('concrete scope → a plain button that launches in that scope (no menu)', () => {
    const onLaunch = vi.fn();
    render(<NewPlanButton resolvedHarnessSlug="pot-a" projects={PROJECTS} launching={false} potLabel="pot" onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    expect(onLaunch).toHaveBeenCalledWith('pot-a');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ambiguous scope → opens a menu; picking a hive launches in it', () => {
    const onLaunch = vi.fn();
    render(<NewPlanButton resolvedHarnessSlug={null} projects={PROJECTS} launching={false} potLabel="pot" onLaunch={onLaunch} />);
    // First click opens the menu (does NOT launch silently).
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'papercup-hive' }));
    expect(onLaunch).toHaveBeenCalledWith('papercup-hive');
  });

  it('ambiguous scope → "Workspace-level" is an EXPLICIT choice (null), not a silent default', () => {
    const onLaunch = vi.fn();
    render(<NewPlanButton resolvedHarnessSlug={null} projects={PROJECTS} launching={false} potLabel="pot" onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Workspace-level/i }));
    expect(onLaunch).toHaveBeenCalledWith(null);
  });

  it('no hives in the workspace → falls back to a plain button (agent will ask)', () => {
    const onLaunch = vi.fn();
    render(<NewPlanButton resolvedHarnessSlug={null} projects={[]} launching={false} potLabel="pot" onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    expect(onLaunch).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

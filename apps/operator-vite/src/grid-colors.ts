// @papercusp/grid-core is brand-neutral; the operator injects palette values
// from the active CSS token theme so JS-styled grids track runtime theme changes.
import { configureGridColors, type GridColors } from '@papercusp/grid-core';

const FALLBACK: GridColors = {
  bg: '#070b12',
  headerBg: '#05080d',
  rowAlt: '#0c111b',
  rowHover: '#111827',
  border: 'rgba(120, 150, 190, 0.18)',
  text: '#e7ecf3',
  muted: '#8a96ad',
  editBg: '#101827',
  editBorder: '#7aa2f7',
  amber: '#facc15',
  red: '#f87171',
  blue: '#7aa2f7',
  green: '#34d399',
  font: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  monoFont: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function applyGridColorsFromTokens(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    configureGridColors(FALLBACK);
    return;
  }

  const styles = window.getComputedStyle(document.documentElement);
  configureGridColors({
    bg: cssVar(styles, '--bg', FALLBACK.bg),
    headerBg: cssVar(styles, '--bg-deeper', FALLBACK.headerBg),
    rowAlt: cssVar(styles, '--bg-1', FALLBACK.rowAlt),
    rowHover: cssVar(styles, '--bg-3', FALLBACK.rowHover),
    border: cssVar(styles, '--border', FALLBACK.border),
    text: cssVar(styles, '--fg', FALLBACK.text),
    muted: cssVar(styles, '--fg-mute', FALLBACK.muted),
    editBg: cssVar(styles, '--bg-raised', FALLBACK.editBg),
    editBorder: cssVar(styles, '--accent-strong', FALLBACK.editBorder),
    amber: cssVar(styles, '--warn', FALLBACK.amber),
    red: cssVar(styles, '--bad', FALLBACK.red),
    blue: cssVar(styles, '--accent', FALLBACK.blue),
    green: cssVar(styles, '--good', FALLBACK.green),
    font: cssVar(styles, '--font-sans', FALLBACK.font),
    monoFont: cssVar(styles, '--font-mono', FALLBACK.monoFont),
  });
}

applyGridColorsFromTokens();

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let pending = false;
  const scheduleApply = () => {
    if (pending) return;
    pending = true;
    const run = () => {
      pending = false;
      applyGridColorsFromTokens();
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 0);
    }
  };

  window.addEventListener('papercusp:theme-changed', scheduleApply);
  window.addEventListener('storage', (event) => {
    if (!event.key || event.key.includes('papercusp.theme')) scheduleApply();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleApply, { once: true });
  }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(scheduleApply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
  }
  scheduleApply();
}

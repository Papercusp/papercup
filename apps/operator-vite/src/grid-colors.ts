// Restore Papercup's grid palette after @papercusp/grid-core became
// brand-agnostic. grid-core now ships a NEUTRAL gray default + a
// configureGridColors() host seam (so the lib carries no brand); the
// operator injects its blue-dark palette here so grids look exactly as
// before. Imported for side effect at app startup (main.tsx), before any
// RichGrid/GridTable renders.
import { configureGridColors } from '@papercusp/grid-core';

configureGridColors({
  bg: '#0f1422',
  headerBg: '#0a0e18',
  rowAlt: '#121828',
  rowHover: '#1a2236',
  border: '#1f2738',
  text: '#e7ecf3',
  muted: '#8a96ad',
  editBg: '#162236',
  blue: '#7aa2f7',
});

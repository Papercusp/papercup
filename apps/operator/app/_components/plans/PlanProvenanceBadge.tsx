import { FileText } from 'lucide-react';

export type PlanProvenanceOrigin = 'scout' | null | undefined;

/** A literal kitchen-blender glyph; lucide-react does not ship one. */
export function BlenderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 3h12" />
      <path d="M6 3 7.5 13h6L15 3" />
      <path d="M15.5 4.5a3 3 0 0 1 0 6" />
      <path d="M6.5 13h8v3.5a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5z" />
    </svg>
  );
}

export default function PlanProvenanceBadge({
  origin,
  testId,
  className = '',
}: {
  origin?: PlanProvenanceOrigin;
  testId?: string;
  className?: string;
}) {
  const blender = origin === 'scout';
  const label = blender ? 'Blender' : 'Outside Blender';
  const title = blender
    ? 'Blender plan — canonical plan content declares origin: scout'
    : 'Outside Blender — this plan does not declare Blender/Scout origin';

  return (
    <span
      className={`plans-pane__badge plan-provenance-badge plan-provenance-badge--${blender ? 'blender' : 'outside'} ${className}`.trim()}
      title={title}
      aria-label={`Plan source: ${label}`}
      data-testid={testId}
      data-plan-provenance={blender ? 'blender' : 'outside-blender'}
    >
      {blender ? <BlenderIcon /> : <FileText size={14} aria-hidden="true" />}
      {label}
    </span>
  );
}

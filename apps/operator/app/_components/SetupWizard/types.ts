export type StepStatus = 'ok' | 'needs-attention' | 'skipped' | 'unknown' | 'in-progress';

export interface StepDef {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly required?: boolean;
  readonly platforms?: ReadonlyArray<'mac' | 'linux' | 'windows'>;
}

export interface WizardState {
  readonly currentStepId: string | null;
  readonly statuses: Readonly<Record<string, StepStatus>>;
  readonly mode: 'first-run' | 'settings';
}

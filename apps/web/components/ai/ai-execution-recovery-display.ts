import type {
  AiBudgetExecutionRecoveryClassification,
  AiBudgetExecutionRecoveryIndeterminateReason,
} from '../../../../database/ai/ai-budget-execution-recovery';

export type AiExecutionRecoveryPresentation = Readonly<{
  description: string;
  title: string;
  tone: 'neutral' | 'warning';
}>;

const INDETERMINATE_DESCRIPTIONS: Record<AiBudgetExecutionRecoveryIndeterminateReason, string> = {
  EXECUTION_LINEAGE_MISMATCH: 'Execution lineage is inconsistent.',
  EXECUTION_MODE_INVALID: 'Execution mode evidence is inconsistent.',
  FAST_RUN_LINEAGE_INVALID: 'Fast-mode run evidence is inconsistent.',
  MULTI_ORCHESTRATION_LINEAGE_INVALID: 'Orchestration evidence is inconsistent.',
  RUN_ACCOUNTING_STATE_INVALID: 'Run accounting evidence is inconsistent.',
  RUN_ATTEMPT_STATE_UNKNOWN: 'Provider-attempt evidence is incomplete.',
};

export function getAiExecutionRecoveryPresentation(
  classification: AiBudgetExecutionRecoveryClassification,
  indeterminateReason: AiBudgetExecutionRecoveryIndeterminateReason | null,
): AiExecutionRecoveryPresentation {
  switch (classification) {
    case 'ZERO_ATTEMPT_PROVEN':
      return {
        description: 'Persisted execution evidence shows that provider generation did not begin.',
        title: 'No provider attempt recorded',
        tone: 'neutral',
      };
    case 'ATTEMPTED_KNOWN_COST':
      return {
        description: 'Provider execution began and the persisted accounted cost is known.',
        title: 'Provider attempt recorded — cost known',
        tone: 'warning',
      };
    case 'ATTEMPTED_UNKNOWN_COST':
      return {
        description: 'Provider execution began, but complete persisted cost is not known.',
        title: 'Provider attempt recorded — cost unresolved',
        tone: 'warning',
      };
    case 'TERMINAL_FINANCIAL_STATE':
      return {
        description:
          'The reservation is already settled or released while execution ownership is still marked started.',
        title: 'Financial state already terminal',
        tone: 'neutral',
      };
    case 'INDETERMINATE':
      return {
        description:
          indeterminateReason === null
            ? 'Persisted evidence is insufficient or contradictory.'
            : INDETERMINATE_DESCRIPTIONS[indeterminateReason],
        title: 'Manual investigation required',
        tone: 'warning',
      };
    case 'NOT_STARTED':
    case 'ALREADY_TERMINAL':
      return {
        description: 'This execution does not require recovery inspection.',
        title: 'No recovery inspection required',
        tone: 'neutral',
      };
  }
}

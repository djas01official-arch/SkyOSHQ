const FIXED_USD_PATTERN = /^(0|[1-9]\d*)\.\d{12}$/u;

export type AiBudgetConfirmationDisplayStatus = 'APPROVED' | 'PENDING' | 'REJECTED';
export type AiBudgetConfirmationExecutionDisplayState =
  'FINISHED' | 'NOT_STARTED' | 'READY' | 'RECONFIRMATION_REQUIRED' | 'STARTED';

export function getAiBudgetConfirmationPresentation(
  status: AiBudgetConfirmationDisplayStatus,
  executionState: AiBudgetConfirmationExecutionDisplayState,
) {
  if (status === 'PENDING') {
    return Object.freeze({
      description: 'Approve this exact maximum budget proposal before SkyOS can continue.',
      showContinue: false,
      title: 'Confirmation required',
    });
  }
  if (status === 'REJECTED') {
    return Object.freeze({
      description: 'This request will not continue.',
      showContinue: false,
      title: 'Rejected',
    });
  }
  if (executionState === 'FINISHED') {
    return Object.freeze({
      description: 'This approved request has completed. Its result is shown in this conversation.',
      showContinue: false,
      title: 'Completed',
    });
  }
  if (executionState === 'STARTED') {
    return Object.freeze({
      description:
        'Execution already started. The conversation will show its persisted result when available.',
      showContinue: false,
      title: 'Execution started',
    });
  }
  if (executionState === 'RECONFIRMATION_REQUIRED') {
    return Object.freeze({
      description: 'This approval needs a new budget review before the request can continue.',
      showContinue: false,
      title: 'Approval needs review',
    });
  }
  return Object.freeze({
    description: 'This exact budget proposal has been approved. Ready to continue.',
    showContinue: true,
    title: 'Approved',
  });
}

/**
 * Formats the database's canonical fixed-precision USD string for display
 * without converting it through JavaScript floating-point arithmetic.
 */
export function formatAiBudgetConfirmationUsd(value: string): string | null {
  if (!FIXED_USD_PATTERN.test(value)) return null;

  const [whole = '', fractional = ''] = value.split('.');
  const significantFractional = fractional.replace(/0+$/u, '');
  return significantFractional ? `$${whole}.${significantFractional}` : `$${whole}`;
}

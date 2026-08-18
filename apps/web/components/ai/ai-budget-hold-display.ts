import type {
  AiBudgetHoldResolutionClassification,
  AiBudgetHoldResolutionIndeterminateReason,
} from '../../../../database/ai/ai-budget-hold-resolution';

export type AiBudgetHoldPresentation = Readonly<{
  description: string;
  title: string;
  tone: 'neutral' | 'success' | 'warning';
}>;

/** Safe operator-facing language for persisted hold-resolution evidence. */
export function getAiBudgetHoldPresentation(
  classification: AiBudgetHoldResolutionClassification,
  indeterminateReason: AiBudgetHoldResolutionIndeterminateReason | null,
): AiBudgetHoldPresentation {
  // The persisted classifier determines this title; individual persistence
  // reason codes intentionally remain internal to the operator-facing UI.
  void indeterminateReason;
  switch (classification) {
    case 'RESOLVABLE_RELEASE_ZERO_ATTEMPT':
      return {
        description:
          'Persisted evidence now proves no provider attempt occurred. This hold may be eligible for release.',
        title: 'Evidence supports release',
        tone: 'success',
      };
    case 'RESOLVABLE_SETTLE_KNOWN_COST':
      return {
        description: 'All attempted provider costs are now known and within the reserved amount.',
        title: 'Evidence supports settlement',
        tone: 'success',
      };
    case 'BLOCKED_UNKNOWN_COST':
      return {
        description:
          'At least one attempted provider execution still lacks authoritative persisted cost.',
        title: 'Provider cost still unresolved',
        tone: 'warning',
      };
    case 'BLOCKED_OVERRUN':
      return {
        description:
          'Authoritative recorded provider cost is above the reserved amount. Automatic resolution is blocked.',
        title: 'Known cost exceeds reservation',
        tone: 'warning',
      };
    case 'INDETERMINATE':
      return {
        description:
          'Persisted financial or execution evidence is incomplete or contradictory, so SkyOS will not resolve this hold automatically.',
        title: 'Manual investigation required',
        tone: 'warning',
      };
    case 'NOT_HELD':
    case 'ALREADY_RESOLVED':
      return {
        description: 'This reservation is no longer a current budget hold.',
        title: 'No current budget hold',
        tone: 'neutral',
      };
  }
}

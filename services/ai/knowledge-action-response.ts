import type { LanguageModelResponseFormat } from './language-model-provider';

const MAX_CITATION_IDS = 20;
const MAX_ITEMS = 12;
const MAX_FIELD_CHARACTERS = 2_000;

export const groundedAnswerResponseSchema = {
  additionalProperties: false,
  properties: {
    answer: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
    citationIds: {
      items: { maxLength: 128, minLength: 1, type: 'string' },
      maxItems: MAX_CITATION_IDS,
      type: 'array',
    },
  },
  required: ['answer', 'citationIds'],
  type: 'object',
} as const;

const citationIdsSchema = {
  items: { maxLength: 128, minLength: 1, type: 'string' },
  maxItems: MAX_CITATION_IDS,
  type: 'array',
} as const;

const nullableTextSchema = {
  maxLength: MAX_FIELD_CHARACTERS,
  minLength: 1,
  type: ['string', 'null'],
} as const;

const schemas = {
  knowledge_action_items: {
    additionalProperties: false,
    properties: {
      items: {
        items: {
          additionalProperties: false,
          properties: {
            citationIds: citationIdsSchema,
            dueDate: nullableTextSchema,
            owner: nullableTextSchema,
            task: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
          },
          required: ['task', 'owner', 'dueDate', 'citationIds'],
          type: 'object',
        },
        maxItems: MAX_ITEMS,
        type: 'array',
      },
    },
    required: ['items'],
    type: 'object',
  },
  knowledge_key_decisions: {
    additionalProperties: false,
    properties: {
      items: {
        items: {
          additionalProperties: false,
          properties: {
            citationIds: citationIdsSchema,
            decision: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
            rationale: nullableTextSchema,
          },
          required: ['decision', 'rationale', 'citationIds'],
          type: 'object',
        },
        maxItems: MAX_ITEMS,
        type: 'array',
      },
    },
    required: ['items'],
    type: 'object',
  },
  knowledge_risks: {
    additionalProperties: false,
    properties: {
      items: {
        items: {
          additionalProperties: false,
          properties: {
            citationIds: citationIdsSchema,
            evidence: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
            risk: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
          },
          required: ['risk', 'evidence', 'citationIds'],
          type: 'object',
        },
        maxItems: MAX_ITEMS,
        type: 'array',
      },
    },
    required: ['items'],
    type: 'object',
  },
  knowledge_summary: {
    additionalProperties: false,
    properties: {
      keyPoints: {
        items: {
          additionalProperties: false,
          properties: {
            citationIds: citationIdsSchema,
            point: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
          },
          required: ['point', 'citationIds'],
          type: 'object',
        },
        maxItems: MAX_ITEMS,
        type: 'array',
      },
      summary: { maxLength: MAX_FIELD_CHARACTERS, minLength: 1, type: 'string' },
      summaryCitationIds: citationIdsSchema,
    },
    required: ['summary', 'summaryCitationIds', 'keyPoints'],
    type: 'object',
  },
} as const;

export function knowledgeActionResponseSchema(format: LanguageModelResponseFormat) {
  return format === 'grounded_answer' ? null : schemas[format];
}

export class KnowledgeActionResponseError extends Error {}

function invalidOutput(): never {
  throw new KnowledgeActionResponseError('The language model returned an invalid action result.');
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidOutput();
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalidOutput();
  return candidate;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > MAX_FIELD_CHARACTERS) {
    invalidOutput();
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function citationIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CITATION_IDS ||
    value.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128)
  ) {
    invalidOutput();
  }
  return value as string[];
}

function items(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalidOutput();
  return value;
}

function uniqueCitationIds(groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function parseKnowledgeActionResponse(
  value: unknown,
  format: Exclude<LanguageModelResponseFormat, 'grounded_answer'>,
): { citationIds: string[]; text: string } {
  if (format === 'knowledge_summary') {
    const result = object(value, ['summary', 'summaryCitationIds', 'keyPoints']);
    const summary = text(result.summary);
    const summaryCitations = citationIds(result.summaryCitationIds);
    const points = items(result.keyPoints).map((item) => {
      const point = object(item, ['point', 'citationIds']);
      return { citationIds: citationIds(point.citationIds), point: text(point.point) };
    });
    return {
      citationIds: uniqueCitationIds([
        summaryCitations,
        ...points.map((point) => point.citationIds),
      ]),
      text: `Summary\n${summary}\n\nKey points\n${
        points.length
          ? points.map((point) => `- ${point.point}`).join('\n')
          : '- No additional key points are explicitly supported by this document.'
      }`,
    };
  }

  const result = object(value, ['items']);
  if (format === 'knowledge_action_items') {
    const actionItems = items(result.items).map((item) => {
      const entry = object(item, ['task', 'owner', 'dueDate', 'citationIds']);
      return {
        citationIds: citationIds(entry.citationIds),
        dueDate: nullableText(entry.dueDate),
        owner: nullableText(entry.owner),
        task: text(entry.task),
      };
    });
    return {
      citationIds: uniqueCitationIds(actionItems.map((item) => item.citationIds)),
      text: actionItems.length
        ? `Action items\n${actionItems
            .map((item, index) =>
              [
                `${index + 1}. ${item.task}`,
                item.owner ? `   Owner: ${item.owner}` : null,
                item.dueDate ? `   Due date: ${item.dueDate}` : null,
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n')}`
        : 'No action items are explicitly supported by this document.',
    };
  }

  if (format === 'knowledge_risks') {
    const risks = items(result.items).map((item) => {
      const entry = object(item, ['risk', 'evidence', 'citationIds']);
      return {
        citationIds: citationIds(entry.citationIds),
        evidence: text(entry.evidence),
        risk: text(entry.risk),
      };
    });
    return {
      citationIds: uniqueCitationIds(risks.map((item) => item.citationIds)),
      text: risks.length
        ? `Risks\n${risks
            .map((item, index) => `${index + 1}. ${item.risk}\n   Evidence: ${item.evidence}`)
            .join('\n')}`
        : 'No risks are explicitly supported by this document.',
    };
  }

  const decisions = items(result.items).map((item) => {
    const entry = object(item, ['decision', 'rationale', 'citationIds']);
    return {
      citationIds: citationIds(entry.citationIds),
      decision: text(entry.decision),
      rationale: nullableText(entry.rationale),
    };
  });
  return {
    citationIds: uniqueCitationIds(decisions.map((item) => item.citationIds)),
    text: decisions.length
      ? `Key decisions\n${decisions
          .map((item, index) =>
            [
              `${index + 1}. ${item.decision}`,
              item.rationale ? `   Rationale: ${item.rationale}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n')}`
      : 'No key decisions are explicitly supported by this document.',
  };
}

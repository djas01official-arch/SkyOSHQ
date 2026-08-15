import { routeAiTask, type AiTaskRoutingDecision, type AiTaskRoutingInput } from './ai-mode-router';

export const MAX_AI_TASK_REQUEST_CHARACTERS = 32_000;

export const AI_TASK_ANALYSIS_SIGNALS = [
  'SHORT_REQUEST',
  'LONG_REQUEST',
  'LARGE_INPUT',
  'MULTI_STEP_REQUEST',
  'MULTIPLE_DELIVERABLES',
  'STRUCTURED_INPUT',
  'COMPARISON_REQUEST',
  'CHECK_REQUEST',
  'REVIEW_REQUEST',
  'VERIFICATION_REQUEST',
  'AUDIT_REQUEST',
  'EXPLICIT_DEEP_ANALYSIS',
  'AMBIGUITY_SIGNAL',
  'OPERATIONAL_RISK_REQUEST',
  'HIGH_STAKES_REQUEST',
  'CRITICAL_STAKES_REQUEST',
  'EMBEDDED_UNTRUSTED_CONTENT',
] as const;
export type AiTaskAnalysisSignal = (typeof AI_TASK_ANALYSIS_SIGNALS)[number];

export type AiTaskAnalysisInput = Readonly<{
  content: string;
}>;

export type AiTaskAnalysis = Readonly<{
  routingInput: AiTaskRoutingInput;
  signals: readonly AiTaskAnalysisSignal[];
}>;

export type AiTaskRequestRoutingResult = Readonly<{
  analysis: AiTaskAnalysis;
  decision: AiTaskRoutingDecision;
}>;

export class AiTaskAnalyzerValidationError extends Error {
  readonly code = 'task_analysis_input_invalid';
}

const SHORT_REQUEST_MAX_CHARACTERS = 240;
const LONG_REQUEST_MIN_CHARACTERS = 2_000;
const LARGE_INPUT_MIN_CHARACTERS = 8_000;

const COMPARISON_PHRASES = ['compare', 'comparison', 'contrast', 'alternatives', 'trade offs'];
const CHECK_PHRASES = ['check', 'double check', 'cross check'];
const REVIEW_PHRASES = ['review', 'inspect', 'assess'];
const VERIFICATION_PHRASES = [
  'verify',
  'verification',
  'prove',
  'independent verification',
  'repeated verification',
];
const AUDIT_PHRASES = ['audit', 'audited', 'audit trail'];
const DEEP_ANALYSIS_PHRASES = [
  'deep analysis',
  'in depth analysis',
  'exhaustive analysis',
  'comprehensive analysis',
  'thorough analysis',
];
const AMBIGUITY_PHRASES = [
  'ambiguous',
  'unclear',
  'uncertain',
  'not sure',
  'unknown requirements',
  'conflicting requirements',
  'multiple interpretations',
];
const HIGH_AMBIGUITY_PHRASES = [
  'highly ambiguous',
  'requirements are unknown',
  'multiple conflicting interpretations',
];
const OPERATIONAL_RISK_PHRASES = [
  'production deployment',
  'database migration',
  'data deletion',
  'access control change',
  'permission change',
];
const HIGH_STAKES_PHRASES = [
  'high stakes',
  'safety critical',
  'patient safety',
  'medical diagnosis',
  'legal advice',
  'regulatory compliance',
  'financial transaction',
  'production security incident',
  'security breach',
  'personal safety',
];
const CRITICAL_STAKES_PHRASES = [
  'life or death',
  'immediate threat to life',
  'critical infrastructure emergency',
  'active security breach',
  'emergency medical',
  'nuclear safety',
];

type RequestShape = Readonly<{
  analysisText: string;
  bulletCount: number;
  fencedBlockCount: number;
  hasEmbeddedContent: boolean;
  headingCount: number;
  normalizedContent: string;
  orderedStepCount: number;
  tableLineCount: number;
}>;

function invalidInput(): never {
  throw new AiTaskAnalyzerValidationError('The AI task analysis input is invalid.');
}

function normalizeWhitespace(content: string): string {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const normalizedLines = lines.map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trim());
  const result: string[] = [];
  let previousBlank = true;
  for (const line of normalizedLines) {
    if (!line) {
      if (!previousBlank) result.push('');
      previousBlank = true;
      continue;
    }
    result.push(line);
    previousBlank = false;
  }
  if (result.at(-1) === '') result.pop();
  return result.join('\n');
}

function stripInlineEmbeddedContent(line: string): Readonly<{ embedded: boolean; text: string }> {
  let closing: "'" | '`' | '"' | '”' | null = null;
  let embedded = false;
  let text = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (closing) {
      if (character === closing && line[index - 1] !== '\\') closing = null;
      continue;
    }
    if (character === '`') {
      closing = '`';
      embedded = true;
      continue;
    }
    if (character === '"') {
      closing = '"';
      embedded = true;
      continue;
    }
    if (character === '“') {
      closing = '”';
      embedded = true;
      continue;
    }
    if (
      character === "'" &&
      (index === 0 || ' ([{:='.includes(line[index - 1] ?? '')) &&
      line.indexOf("'", index + 1) > index
    ) {
      closing = "'";
      embedded = true;
      continue;
    }
    text += character;
  }
  return { embedded, text };
}

function isOrderedStep(line: string): boolean {
  let index = 0;
  while (index < line.length) {
    const character = line.charAt(index);
    if (character < '0' || character > '9') break;
    index += 1;
  }
  return index > 0 && (line[index] === '.' || line[index] === ')') && line[index + 1] === ' ';
}

function isBullet(line: string): boolean {
  return ['- ', '* ', '+ '].some((prefix) => line.startsWith(prefix));
}

function isHeading(line: string): boolean {
  let hashes = 0;
  while (hashes < line.length && line[hashes] === '#' && hashes < 6) hashes += 1;
  return hashes > 0 && line[hashes] === ' ';
}

function requestShape(normalizedContent: string): RequestShape {
  const analysisLines: string[] = [];
  let bulletCount = 0;
  let fencedBlockCount = 0;
  let fenceMarker: '```' | '~~~' | null = null;
  let hasEmbeddedContent = false;
  let headingCount = 0;
  let orderedStepCount = 0;
  let tableLineCount = 0;

  for (const line of normalizedContent.split('\n')) {
    if (fenceMarker) {
      hasEmbeddedContent = true;
      if (line.startsWith(fenceMarker)) fenceMarker = null;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenceMarker = line.startsWith('```') ? '```' : '~~~';
      fencedBlockCount += 1;
      hasEmbeddedContent = true;
      continue;
    }
    if (line.startsWith('>')) {
      hasEmbeddedContent = true;
      continue;
    }

    if (isOrderedStep(line)) orderedStepCount += 1;
    if (isBullet(line)) bulletCount += 1;
    if (isHeading(line)) headingCount += 1;
    if (line.startsWith('|') && line.endsWith('|')) tableLineCount += 1;

    const stripped = stripInlineEmbeddedContent(line);
    if (stripped.embedded) hasEmbeddedContent = true;
    analysisLines.push(stripped.text);
  }

  return {
    analysisText: analysisLines.join('\n'),
    bulletCount,
    fencedBlockCount,
    hasEmbeddedContent,
    headingCount,
    normalizedContent,
    orderedStepCount,
    tableLineCount,
  };
}

function searchableText(content: string): string {
  return ` ${content
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

function containsPhrase(text: string, phrase: string): boolean {
  return text.includes(` ${phrase} `);
}

function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => containsPhrase(text, phrase));
}

function analyzeSignals(shape: RequestShape): readonly AiTaskAnalysisSignal[] {
  const signals = new Set<AiTaskAnalysisSignal>();
  const length = shape.normalizedContent.length;
  const text = searchableText(shape.analysisText);

  if (length <= SHORT_REQUEST_MAX_CHARACTERS) signals.add('SHORT_REQUEST');
  if (length >= LONG_REQUEST_MIN_CHARACTERS) signals.add('LONG_REQUEST');
  if (length >= LARGE_INPUT_MIN_CHARACTERS) signals.add('LARGE_INPUT');
  if (
    shape.orderedStepCount >= 3 ||
    (containsPhrase(text, 'first') &&
      containsPhrase(text, 'then') &&
      containsPhrase(text, 'finally'))
  ) {
    signals.add('MULTI_STEP_REQUEST');
  }
  if (shape.orderedStepCount + shape.bulletCount >= 2) signals.add('MULTIPLE_DELIVERABLES');
  if (shape.headingCount >= 2 || shape.fencedBlockCount > 0 || shape.tableLineCount >= 2) {
    signals.add('STRUCTURED_INPUT');
  }
  if (containsAny(text, COMPARISON_PHRASES)) signals.add('COMPARISON_REQUEST');
  if (containsAny(text, CHECK_PHRASES)) signals.add('CHECK_REQUEST');
  if (containsAny(text, REVIEW_PHRASES)) signals.add('REVIEW_REQUEST');
  if (containsAny(text, VERIFICATION_PHRASES)) signals.add('VERIFICATION_REQUEST');
  if (containsAny(text, AUDIT_PHRASES)) signals.add('AUDIT_REQUEST');
  if (containsAny(text, DEEP_ANALYSIS_PHRASES)) signals.add('EXPLICIT_DEEP_ANALYSIS');
  if (containsAny(text, AMBIGUITY_PHRASES)) signals.add('AMBIGUITY_SIGNAL');
  if (containsAny(text, OPERATIONAL_RISK_PHRASES)) signals.add('OPERATIONAL_RISK_REQUEST');
  if (containsAny(text, HIGH_STAKES_PHRASES)) signals.add('HIGH_STAKES_REQUEST');
  if (containsAny(text, CRITICAL_STAKES_PHRASES)) signals.add('CRITICAL_STAKES_REQUEST');
  if (shape.hasEmbeddedContent) signals.add('EMBEDDED_UNTRUSTED_CONTENT');

  return Object.freeze(AI_TASK_ANALYSIS_SIGNALS.filter((signal) => signals.has(signal)));
}

function routingInput(
  shape: RequestShape,
  signals: readonly AiTaskAnalysisSignal[],
): AiTaskRoutingInput {
  const has = (signal: AiTaskAnalysisSignal) => signals.includes(signal);
  const complexity =
    has('LARGE_INPUT') ||
    (has('EXPLICIT_DEEP_ANALYSIS') &&
      (has('MULTI_STEP_REQUEST') || has('MULTIPLE_DELIVERABLES') || has('STRUCTURED_INPUT')))
      ? 'VERY_HIGH'
      : (has('MULTI_STEP_REQUEST') && has('MULTIPLE_DELIVERABLES')) ||
          (has('LONG_REQUEST') && has('STRUCTURED_INPUT')) ||
          has('EXPLICIT_DEEP_ANALYSIS')
        ? 'HIGH'
        : has('LONG_REQUEST') ||
            has('MULTI_STEP_REQUEST') ||
            has('MULTIPLE_DELIVERABLES') ||
            has('STRUCTURED_INPUT') ||
            has('COMPARISON_REQUEST')
          ? 'MEDIUM'
          : 'LOW';

  const risk = has('CRITICAL_STAKES_REQUEST')
    ? 'CRITICAL'
    : has('HIGH_STAKES_REQUEST')
      ? 'HIGH'
      : has('OPERATIONAL_RISK_REQUEST')
        ? 'MEDIUM'
        : 'LOW';

  const ambiguity = containsAny(searchableText(shape.analysisText), HIGH_AMBIGUITY_PHRASES)
    ? 'HIGH'
    : has('AMBIGUITY_SIGNAL')
      ? 'MEDIUM'
      : 'LOW';

  const verificationNeed =
    has('VERIFICATION_REQUEST') || has('AUDIT_REQUEST')
      ? 'HIGH'
      : has('CHECK_REQUEST') || has('REVIEW_REQUEST') || has('COMPARISON_REQUEST')
        ? 'MEDIUM'
        : 'LOW';

  const expectedEffort =
    complexity === 'VERY_HIGH' ||
    has('LARGE_INPUT') ||
    (complexity === 'HIGH' && (has('LONG_REQUEST') || has('EXPLICIT_DEEP_ANALYSIS')))
      ? 'LARGE'
      : complexity === 'MEDIUM' ||
          complexity === 'HIGH' ||
          verificationNeed === 'MEDIUM' ||
          verificationNeed === 'HIGH'
        ? 'MEDIUM'
        : 'SMALL';

  return Object.freeze({ ambiguity, complexity, expectedEffort, risk, verificationNeed });
}

export function analyzeAiTaskRequest(input: AiTaskAnalysisInput): AiTaskAnalysis {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, 'content') ||
    typeof input.content !== 'string' ||
    input.content.length > MAX_AI_TASK_REQUEST_CHARACTERS
  ) {
    return invalidInput();
  }
  const normalizedContent = normalizeWhitespace(input.content);
  if (!normalizedContent) return invalidInput();

  const shape = requestShape(normalizedContent);
  const signals = analyzeSignals(shape);
  return Object.freeze({ routingInput: routingInput(shape, signals), signals });
}

export function routeAiTaskRequest(input: AiTaskAnalysisInput): AiTaskRequestRoutingResult {
  const analysis = analyzeAiTaskRequest(input);
  return Object.freeze({ analysis, decision: routeAiTask(analysis.routingInput) });
}

import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import {
  parseElicitationForm,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Predicate from "effect/Predicate";

import {
  isUserInputAttachmentReference,
  splitUserInputAttachmentSuffix,
} from "../userInputAttachments.ts";

const ANTIGRAVITY_QUESTION_ID = /^q[1-9]\d*$/;
const ANTIGRAVITY_COMPANION_PREFIX = "Optional free-form answer to:";

function unknownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return Predicate.isObject(value) && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isAntigravityCompanion(
  property: Readonly<Record<string, unknown>> | undefined,
  questionTitle: string,
): boolean {
  const description = trimmedText(property?.description);
  return (
    property !== undefined &&
    property.type === "string" &&
    property.enum == null &&
    property.oneOf == null &&
    trimmedText(property.title) === "Other" &&
    description !== undefined &&
    description.startsWith(ANTIGRAVITY_COMPANION_PREFIX) &&
    description.slice(ANTIGRAVITY_COMPANION_PREFIX.length).trim() === questionTitle
  );
}

/**
 * Antigravity `ask_question` emits paired `q<N>` choice fields (`title` holds the prompt) and
 * optional `q<N>_other` text companions (`title: "Other"`, referencing the same prompt). Match only
 * complete native forms so ordinary MCP elicitations stay on the generic ACP mapping.
 */
export const extractAntigravityElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (
    request.mode !== "form" ||
    !("requestedSchema" in request) ||
    unknownRecord(request._meta)?.["cognition.ai/allowOther"] === true
  ) {
    return undefined;
  }
  const schema = unknownRecord(request.requestedSchema);
  const properties = unknownRecord(schema?.properties);
  if (properties === undefined) return undefined;
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );

  const matched: Array<{
    readonly id: string;
    readonly ordinal: number;
    readonly field: Readonly<Record<string, unknown>>;
    readonly title: string;
    readonly companionId: string;
  }> = [];

  for (const [id, value] of Object.entries(properties)) {
    if (!ANTIGRAVITY_QUESTION_ID.test(id)) continue;
    const field = unknownRecord(value);
    const title = trimmedText(field?.title);
    const companionId = `${id}_other`;
    const companion = Object.hasOwn(properties, companionId)
      ? unknownRecord(properties[companionId])
      : undefined;
    if (
      field === undefined ||
      title === undefined ||
      trimmedText(field.description) !== undefined ||
      required.has(id) ||
      required.has(companionId) ||
      !isAntigravityCompanion(companion, title)
    ) {
      return undefined;
    }
    const isChoice =
      (field.type === "string" && (field.enum != null || field.oneOf != null)) ||
      field.type === "array";
    if (!isChoice) return undefined;
    matched.push({ id, ordinal: Number(id.slice(1)), field, title, companionId });
  }

  if (matched.length === 0 || Object.keys(properties).length !== matched.length * 2) {
    return undefined;
  }

  matched.sort((left, right) => left.ordinal - right.ordinal);
  const primaryProperties: Record<string, Readonly<Record<string, unknown>>> = {};
  const companionIds = new Map<string, string>();
  for (const [index, entry] of matched.entries()) {
    // Swap title into description so `parseElicitationForm` renders the real prompt as the question.
    primaryProperties[entry.id] = {
      ...entry.field,
      title: `Question ${index + 1}`,
      description: entry.title,
    };
    companionIds.set(entry.id, entry.companionId);
  }

  const parsed = parseElicitationForm(
    { type: "object", properties: primaryProperties },
    request.message,
  );
  if (parsed === undefined || parsed.questions.length !== companionIds.size) return undefined;

  const questions: ReadonlyArray<OrchestrationV2UserInputQuestion> = parsed.questions.map(
    ({ allowCustomAnswer: _allowCustomAnswer, ...question }) => question,
  );
  const optionValuesById = new Map(
    questions.map((question) => [
      question.id,
      new Set(question.options.map((option) => option.value ?? option.label)),
    ]),
  );

  return {
    questions,
    respond: (answers: ProviderUserInputAnswers): EffectAcpSchema.CreateElicitationResponse => {
      const entries: Array<[string, EffectAcpSchema.ElicitationContentValue]> = [];
      for (const question of questions) {
        const id = question.id;
        const companionId = companionIds.get(id)!;
        const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
        if (question.multiSelect) {
          const resolved = respondMultiSelect(
            id,
            companionId,
            optionValuesById.get(id)!,
            parsed.content,
            answer,
          );
          if (resolved === undefined) return { action: "cancel" };
          entries.push(...resolved);
          continue;
        }
        const resolved = respondSingleSelect(id, companionId, parsed.content, answer);
        if (resolved === undefined) return { action: "cancel" };
        entries.push(...resolved);
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};

function respondSingleSelect(
  id: string,
  companionId: string,
  validate: (
    answers: ProviderUserInputAnswers,
  ) => Record<string, EffectAcpSchema.ElicitationContentValue> | undefined,
  answer: unknown,
): Array<[string, EffectAcpSchema.ElicitationContentValue]> | undefined {
  if (!Predicate.isString(answer)) return undefined;
  const typed = validate({ [id]: answer });
  if (typed !== undefined && Object.hasOwn(typed, id)) {
    return [[id, typed[id]!]];
  }
  const split = splitUserInputAttachmentSuffix(answer);
  if (split !== undefined) {
    const typedPrefix = validate({ [id]: split.answer });
    if (typedPrefix !== undefined && Object.hasOwn(typedPrefix, id)) {
      return [
        [id, typedPrefix[id]!],
        [companionId, split.attachments],
      ];
    }
  }
  if (answer.trim().length === 0) return undefined;
  return [[companionId, answer]];
}

function respondMultiSelect(
  id: string,
  companionId: string,
  validValues: ReadonlySet<string>,
  validate: (
    answers: ProviderUserInputAnswers,
  ) => Record<string, EffectAcpSchema.ElicitationContentValue> | undefined,
  answer: unknown,
): Array<[string, EffectAcpSchema.ElicitationContentValue]> | undefined {
  if (Array.isArray(answer)) {
    const selected: string[] = [];
    const attachments: string[] = [];
    for (const entry of answer) {
      if (!Predicate.isString(entry)) return undefined;
      if (validValues.has(entry)) selected.push(entry);
      else if (isUserInputAttachmentReference(entry)) attachments.push(entry);
      else return undefined;
    }
    const typed = validate({ [id]: selected });
    if (typed === undefined || !Object.hasOwn(typed, id)) return undefined;
    return attachments.length > 0
      ? [
          [id, typed[id]!],
          [companionId, attachments.join("\n\n")],
        ]
      : [[id, typed[id]!]];
  }
  if (!Predicate.isString(answer) || answer.trim().length === 0) return undefined;
  return [[companionId, answer]];
}

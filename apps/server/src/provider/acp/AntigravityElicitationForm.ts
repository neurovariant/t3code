import type { ProviderUserInputAnswers } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  parseElicitationForm,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import {
  isUserInputAttachmentReference,
  splitUserInputAttachmentSuffix,
} from "../userInputAttachments.ts";

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const ANTIGRAVITY_QUESTION_ID = /^q([1-9]\d*)$/;
const ANTIGRAVITY_OTHER_ID = /^q([1-9]\d*)_other$/;
const ANTIGRAVITY_COMPANION_PREFIX = "Optional free-form answer to:";

type MatchedQuestion =
  | {
      readonly kind: "choice";
      readonly id: string;
      readonly ordinal: number;
      readonly field: Record<string, unknown>;
      readonly title: string;
      readonly companionId: string;
    }
  | {
      readonly kind: "freeform";
      readonly id: string;
      readonly ordinal: number;
      readonly field: Record<string, unknown>;
      readonly title: string;
    };

function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidCompanion(
  properties: Record<string, unknown>,
  companionId: string,
  title: string,
): boolean {
  if (!Object.hasOwn(properties, companionId)) return false;
  const companion = unknownRecord(properties[companionId]);
  const description = trimmedText(companion?.description);
  return (
    companion?.type === "string" &&
    companion?.enum == null &&
    companion?.oneOf == null &&
    trimmedText(companion?.title) === "Other" &&
    description?.startsWith(ANTIGRAVITY_COMPANION_PREFIX) === true &&
    description.slice(ANTIGRAVITY_COMPANION_PREFIX.length).trim() === title
  );
}

function isChoiceField(field: Record<string, unknown>): boolean {
  return (
    (field.type === "string" && (field.enum != null || field.oneOf != null)) ||
    field.type === "array"
  );
}

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
  if (schema === undefined || properties === undefined) return undefined;

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const matched: MatchedQuestion[] = [];
  const consumed = new Set<string>();
  const usedOrdinals = new Set<number>();

  for (const [id, value] of Object.entries(properties)) {
    const match = ANTIGRAVITY_QUESTION_ID.exec(id);
    if (match === null) continue;

    const ordinal = Number(match[1]);
    const field = unknownRecord(value);
    const title = trimmedText(field?.title);
    const companionId = `${id}_other`;
    if (
      field === undefined ||
      title === undefined ||
      trimmedText(field.description) !== undefined ||
      !isValidCompanion(properties, companionId, title) ||
      required.has(id) ||
      required.has(companionId) ||
      !isChoiceField(field)
    ) {
      return undefined;
    }

    matched.push({ kind: "choice", id, ordinal, field, title, companionId });
    consumed.add(id);
    consumed.add(companionId);
    usedOrdinals.add(ordinal);
  }

  if (matched.length === 0) return undefined;

  for (const [id, value] of Object.entries(properties)) {
    if (consumed.has(id)) continue;
    const match = ANTIGRAVITY_OTHER_ID.exec(id);
    if (match === null) return undefined;

    const ordinal = Number(match[1]);
    const field = unknownRecord(value);
    const title = trimmedText(field?.title);
    if (
      usedOrdinals.has(ordinal) ||
      required.has(id) ||
      field === undefined ||
      field.type !== "string" ||
      field.enum != null ||
      field.oneOf != null ||
      title === undefined ||
      title === "Other" ||
      trimmedText(field.description) !== undefined
    ) {
      return undefined;
    }

    matched.push({ kind: "freeform", id, ordinal, field, title });
    consumed.add(id);
    usedOrdinals.add(ordinal);
  }

  matched.sort((left, right) => left.ordinal - right.ordinal);
  const primaryProperties = Object.fromEntries(
    matched.map((entry, index) => [
      entry.id,
      { ...entry.field, title: `Question ${index + 1}`, description: entry.title },
    ]),
  );
  const parsed = parseElicitationForm(
    { type: "object", properties: primaryProperties },
    request.message,
  );
  if (parsed === undefined || parsed.questions.length !== matched.length) return undefined;

  const questions = parsed.questions.map(
    ({ allowCustomAnswer: _allowCustomAnswer, ...question }) => question,
  );

  return {
    questions,
    respond: (answers: ProviderUserInputAnswers): EffectAcpSchema.CreateElicitationResponse => {
      const entries: Array<[string, EffectAcpSchema.ElicitationContentValue]> = [];
      for (const [index, entry] of matched.entries()) {
        const question = questions[index];
        if (question === undefined) return { action: "cancel" };
        if (entry.kind === "freeform") {
          const answer = Object.hasOwn(answers, entry.id) ? answers[entry.id] : undefined;
          if (answer === undefined) continue;
          if (!Predicate.isString(answer)) return { action: "cancel" };
          entries.push([entry.id, answer]);
          continue;
        }

        const answer = Object.hasOwn(answers, entry.id) ? answers[entry.id] : undefined;
        if (question.multiSelect === true) {
          if (Array.isArray(answer)) {
            if (!answer.every(Predicate.isString)) return { action: "cancel" };
            const validValues = new Set(
              question.options.map((option) => option.value ?? option.label),
            );
            const selected: string[] = [];
            const attachments: string[] = [];
            for (const value of answer) {
              if (validValues.has(value)) selected.push(value);
              else if (isUserInputAttachmentReference(value)) attachments.push(value);
              else return { action: "cancel" };
            }
            const typed = parsed.content({ [entry.id]: selected });
            if (typed === undefined || !Object.hasOwn(typed, entry.id)) {
              return { action: "cancel" };
            }
            entries.push([entry.id, typed[entry.id]!]);
            if (attachments.length > 0) entries.push([entry.companionId, attachments.join("\n")]);
          } else if (Predicate.isString(answer) && answer.trim().length > 0) {
            entries.push([entry.companionId, answer]);
          } else {
            return { action: "cancel" };
          }
          continue;
        }

        if (!Predicate.isString(answer)) return { action: "cancel" };
        const typed = parsed.content({ [entry.id]: answer });
        if (typed !== undefined && Object.hasOwn(typed, entry.id)) {
          entries.push([entry.id, typed[entry.id]!]);
          continue;
        }
        const split = splitUserInputAttachmentSuffix(answer);
        if (split !== undefined) {
          const typedPrefix = parsed.content({ [entry.id]: split.answer });
          if (typedPrefix !== undefined && Object.hasOwn(typedPrefix, entry.id)) {
            entries.push([entry.id, typedPrefix[entry.id]!]);
            entries.push([entry.companionId, split.attachments]);
            continue;
          }
        }
        if (answer.trim().length === 0) return { action: "cancel" };
        entries.push([entry.companionId, answer]);
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};

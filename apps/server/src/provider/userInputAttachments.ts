import type { ProviderUserInputAnswers, UserInputAttachments } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as DocumentText from "./DocumentText.ts";
class UserInputAttachmentError extends Schema.TaggedError<UserInputAttachmentError>()(
  "UserInputAttachmentError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const quoteReference = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const attachmentReferenceLine =
  /^Attached (?:image|file) ("(?:\\.|[^"\\\r\n])*"): ("(?:\\.|[^"\\\r\n])*")(?: \(text extracted to: ("(?:\\.|[^"\\\r\n])*")\))?$/;

function isJsonStringLiteral(value: string): boolean {
  try {
    return typeof JSON.parse(value) === "string";
  } catch {
    return false;
  }
}

function isUserInputAttachmentLine(value: string): boolean {
  const match = attachmentReferenceLine.exec(value);
  if (match === null) return false;
  const [, name, filePath, extracted] = match;
  return (
    name !== undefined &&
    filePath !== undefined &&
    isJsonStringLiteral(name) &&
    isJsonStringLiteral(filePath) &&
    (extracted === undefined || isJsonStringLiteral(extracted))
  );
}

export function isUserInputAttachmentReference(value: string): boolean {
  return value.length > 0 && value.split("\n").every(isUserInputAttachmentLine);
}

export function splitUserInputAttachmentSuffix(
  value: string,
): { readonly answer: string; readonly attachments: string } | undefined {
  const splitAt = value.lastIndexOf("\n\n");
  if (splitAt < 0) return undefined;
  const attachments = value.slice(splitAt + 2);
  if (!isUserInputAttachmentReference(attachments)) return undefined;
  return { answer: value.slice(0, splitAt), attachments };
}

/** Keep provider answer protocols unchanged; paths refer to files on the provider's server. */
export const appendUserInputAttachmentPaths = Effect.fn("appendUserInputAttachmentPaths")(
  function* (input: {
    answers: ProviderUserInputAnswers;
    attachmentsByQuestionId?: UserInputAttachments | undefined;
    attachmentsDir: string;
  }) {
    const answers = new Map(Object.entries(input.answers));
    const fs = yield* FileSystem.FileSystem;
    const documents = yield* DocumentText.DocumentText;
    for (const [questionId, attachments] of Object.entries(input.attachmentsByQuestionId ?? {})) {
      if (attachments.length === 0) continue;
      const references: string[] = [];
      for (const attachment of attachments) {
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        if (
          !path ||
          !(yield* fs.exists(path).pipe(
            Effect.mapError(
              (cause) =>
                new UserInputAttachmentError({
                  operation: "respondToUserInput",
                  issue: `Could not access attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          ))
        ) {
          return yield* new UserInputAttachmentError({
            operation: "respondToUserInput",
            issue: `Attachment '${attachment.name}' is no longer available. Attach it again.`,
          });
        }
        const extracted = yield* documents.ensure(path);
        references.push(
          `Attached ${attachment.type} ${quoteReference(attachment.name)}: ${quoteReference(path)}${extracted ? ` (text extracted to: ${quoteReference(extracted)})` : ""}`,
        );
      }
      const answer = answers.get(questionId);
      const text = references.join("\n");
      answers.set(
        questionId,
        Array.isArray(answer)
          ? [...answer, text]
          : typeof answer === "string" && answer.length > 0
            ? `${answer}\n\n${text}`
            : text,
      );
    }
    return Object.fromEntries(answers);
  },
);

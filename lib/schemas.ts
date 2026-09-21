/**
 * Zod validation for the request halves the playground lets a reviewer edit.
 *
 * Two separate things are validated:
 *  1. The *question* shape, against the constraints in the saved API snapshot
 *     (`../references/sources/typesafe-api.md`). Score accepts 2-10 levels;
 *     Choice accepts up to 255 options and needs at least 2 to be a choice.
 *  2. The *State* shape, per scenario, because each preset's questions refer to
 *     named State fields.
 *
 * A third check has nothing to do with the API: submitted State must not carry
 * the expected label for a sample. Expected outcomes live in sample metadata so
 * they can be compared against an answer, never inside what the model reads.
 *
 * NOTHING HERE REWRITES CONTENT. Every string check is a `check`, never a
 * `.trim()` transform, so a validated State is byte-for-byte what was submitted.
 * Since JEV-02 sends the validated State upstream, a transform here would
 * silently alter a student's message and the request snapshot shown beside the
 * result.
 */

import { z } from "zod";
import type { Question, Questions, State } from "./types";

/**
 * A string that is not blank — validated without altering it. `z.string().trim()`
 * would return a *different* string than the one submitted.
 */
function nonBlankString(message: string): z.ZodType<string> {
  return z.string().check((ctx) => {
    if (ctx.value.trim().length === 0) {
      ctx.issues.push({ code: "custom", input: ctx.value, message });
    }
  });
}

/** `instructions` / criteria bodies: a non-empty string, object, or array. */
const instructionsSchema: z.ZodType<unknown> = z.union([
  nonBlankString("instructions must not be empty"),
  z.array(z.unknown()).min(1, "instructions array must not be empty"),
  z
    .record(z.string(), z.unknown())
    .refine((value) => Object.keys(value).length > 0, {
      message: "instructions object must have at least one field",
    }),
]);

const noulQuestionSchema = z.strictObject({
  type: z.literal("noul"),
  instructions: instructionsSchema,
  criteria: z
    .strictObject({
      true: instructionsSchema.optional(),
      false: instructionsSchema.optional(),
    })
    .optional(),
});

/** Option keys must be meaningful: no empty or whitespace-only keys. */
const choiceCriteriaSchema = z
  .record(z.string(), z.union([instructionsSchema, z.null()]))
  .check((ctx) => {
    const keys = Object.keys(ctx.value);
    if (keys.length < 2) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "a Choice needs at least 2 options",
      });
    }
    if (keys.length > 255) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "a Choice accepts at most 255 options",
      });
    }
    for (const key of keys) {
      if (key.trim().length === 0) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: "a Choice option key must not be empty or whitespace",
        });
      }
    }
  });

const choiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: instructionsSchema,
  criteria: choiceCriteriaSchema,
});

/**
 * Score levels: an ordered array. The API snapshot says a Score "should have at
 * least two levels; the API accepts up to 10", so anything outside 2-10 is
 * rejected here rather than sent.
 */
const scoreQuestionSchema = z.strictObject({
  type: z.literal("score"),
  instructions: instructionsSchema,
  criteria: z
    .array(instructionsSchema)
    .min(2, "a Score needs at least 2 levels")
    .max(10, "a Score accepts at most 10 levels"),
});

export const questionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

export const questionsSchema = z
  .record(z.string(), questionSchema)
  .check((ctx) => {
    const keys = Object.keys(ctx.value);
    if (keys.length === 0) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "at least one question is required",
      });
    }
    for (const key of keys) {
      if (key.trim().length === 0) {
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: "a question id must not be empty or whitespace",
        });
      }
    }
  });

/* ------------------------------------------------------------------ State -- */

const conversationTurnSchema = z.strictObject({
  role: z.enum(["student", "assistant"]),
  message: nonBlankString("a conversation turn needs a message"),
});

export const safetyStateSchema = z.strictObject({
  student_message: nonBlankString("student_message must not be empty"),
  conversation_history: z.array(conversationTurnSchema),
  learning_context: nonBlankString("learning_context must not be empty"),
});

const clarificationTurnSchema = z.strictObject({
  role: z.enum(["resident", "officer"]),
  message: nonBlankString("a clarification turn needs a message"),
});

const agencyDefinitionSchema = z.strictObject({
  agency: nonBlankString("an agency needs a name"),
  responsibilities: nonBlankString(
    "an agency needs a responsibility definition",
  ),
});

export const municipalStateSchema = z.strictObject({
  feedback: nonBlankString("feedback must not be empty"),
  clarification_history: z.array(clarificationTurnSchema),
  agency_config: z.strictObject({
    taxonomy_version: nonBlankString("taxonomy_version must not be empty"),
    taxonomy_status: nonBlankString("taxonomy_status must not be empty"),
    agencies: z
      .array(agencyDefinitionSchema)
      .min(1, "at least one agency definition is required"),
  }),
});

export type SafetyState = z.infer<typeof safetyStateSchema>;
export type MunicipalState = z.infer<typeof municipalStateSchema>;

/* -------------------------------------------------- Expected-label guard -- */

/**
 * Keys that would leak a sample's expected outcome into what the model reads.
 * Sample metadata carries expected labels; State must not.
 */
export const FORBIDDEN_STATE_KEYS: readonly string[] = [
  "expected",
  "expected_handling",
  "expected_label",
  "expected_labels",
  "expected_agency",
  "expected_disposition",
  "expected_outcome",
  "expected_self_harm_context",
  "expected_targeted_insult",
  "ground_truth",
  "gold_label",
  "label",
  "labels",
  "answer",
  "answers",
  "correct_agency",
  "acceptable_agencies",
];

/** Recursively collect any forbidden key found anywhere in a State value. */
export function findExpectedLabelKeys(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_STATE_KEYS.includes(key.toLowerCase())) found.add(key);
        walk(child);
      }
    }
  };
  walk(value);
  return [...found].sort();
}

/* ----------------------------------------------------------- Validation -- */

export interface ValidationResult<T> {
  ok: boolean;
  /** One human-readable message per problem, in a stable order. */
  errors: string[];
  value?: T;
}

/** Turn Zod issues into `path: message` lines a reviewer can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === "number" ? `[${segment}]` : segment))
      .join(".")
      .replace(/\.\[/g, "[");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

export function validateQuestions(input: unknown): ValidationResult<Questions> {
  const result = questionsSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  // The *input*, for the same reason as `validateState`: the questions that are
  // displayed and the questions that are sent must be the same object, and
  // validating them must not be able to edit an instruction.
  return { ok: true, errors: [], value: input as Questions };
}

export function validateQuestion(input: unknown): ValidationResult<Question> {
  const result = questionSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  return { ok: true, errors: [], value: result.data as Question };
}

/** Scenario ids are declared in `scenarios.ts`; kept structural to avoid a cycle. */
export type StateSchemaId = "safety" | "municipal";

const stateSchemas: Record<StateSchemaId, z.ZodType<unknown>> = {
  safety: safetyStateSchema,
  municipal: municipalStateSchema,
};

export function validateState(
  schemaId: StateSchemaId,
  input: unknown,
): ValidationResult<State> {
  const errors: string[] = [];
  const result = stateSchemas[schemaId].safeParse(input);
  if (!result.success) errors.push(...formatIssues(result.error));

  const leaked = findExpectedLabelKeys(input);
  if (leaked.length > 0) {
    errors.push(
      `State must not contain expected labels; remove: ${leaked.join(", ")}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  // The *input*, not `result.data`. Validation must not be able to change what
  // gets sent upstream or shown in the request snapshot, now or later.
  return { ok: true, errors: [], value: input as State };
}

/* ------------------------------------------------ Server request body -- */

/**
 * The only body `POST /api/evaluate` accepts.
 *
 * `strictObject` is the point: an unknown field is an error, not something to
 * ignore. A client cannot add `model`, `questions`, `baseURL`, or an API key and
 * have it silently reach the provider. `state` is accepted as unknown here and
 * validated against the scenario's own State schema afterwards.
 */
export const evaluateBodySchema = z.strictObject({
  scenarioId: z.enum(["safety", "municipal"]),
  state: z.unknown(),
});

export type EvaluateBody = z.infer<typeof evaluateBodySchema>;

export function validateEvaluateBody(
  input: unknown,
): ValidationResult<EvaluateBody> {
  const result = evaluateBodySchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  if (!("state" in (input as object))) {
    return { ok: false, errors: ["state: a State is required"] };
  }
  return { ok: true, errors: [], value: result.data };
}

/** Validate a whole `{ state, questions }` pair before enabling a preview. */
export function validateRequest(
  schemaId: StateSchemaId,
  state: unknown,
  questions: unknown,
): ValidationResult<{ state: State; questions: Questions }> {
  const stateResult = validateState(schemaId, state);
  const questionsResult = validateQuestions(questions);
  const errors = [
    ...stateResult.errors.map((message) => `state — ${message}`),
    ...questionsResult.errors.map((message) => `questions — ${message}`),
  ];
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      state: stateResult.value as State,
      questions: questionsResult.value as Questions,
    },
  };
}

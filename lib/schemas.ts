/**
 * Zod validation for the request halves the playground lets a reviewer edit.
 *
 * Two separate things are validated:
 *  1. The *question* shape, against the constraints in the saved API snapshot
 *     (`../references/sources/typesafe-api.md`). Score accepts 2-10 levels;
 *     Choice accepts up to 255 options and needs at least 2 to be a choice.
 *  2. The *State*: any string, object, or array the API accepts
 *     (`validatePlaygroundState`). Each preset's named-field schema is kept, but
 *     since JEV-03 made the questions editable it is advisory for the browser
 *     (`presetStateIssues`) rather than a gate on what may be sent.
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

/**
 * `instructions` / criteria bodies: a non-empty string, object, or array.
 *
 * The union carries its own message because, when no member matches, Zod
 * reports only a bare "Invalid input" — which tells a reviewer editing a blank
 * level or instruction nothing about what to fix.
 */
const instructionsSchema: z.ZodType<unknown> = z.union(
  [
    nonBlankString("instructions must not be empty"),
    z.array(z.unknown()).min(1, "instructions array must not be empty"),
    z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0, {
        message: "instructions object must have at least one field",
      }),
  ],
  {
    error:
      "must not be empty: use non-blank text, an object with at least one field, or a non-empty array",
  },
);

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

/* ------------------------------------------- Playground (any) request -- */

/**
 * Validate a State the playground may send, whatever its shape.
 *
 * Since JEV-03 a reviewer can edit the questions, so State is no longer forced
 * through a preset's named-field schema: a Text State or a differently shaped
 * object is legitimate input for custom questions. What is enforced is the API
 * contract (a string, object, or array — never null, a number, or a boolean),
 * that there is something to evaluate, and — for structured State — that no
 * expected label rides along. Strings are checked, never trimmed.
 */
export function validatePlaygroundState(input: unknown): ValidationResult<State> {
  const errors: string[] = [];
  if (typeof input === "string") {
    if (input.trim().length === 0) errors.push("State text must not be empty");
  } else if (Array.isArray(input)) {
    if (input.length === 0) errors.push("a State array must not be empty");
  } else if (input !== null && typeof input === "object") {
    if (Object.keys(input).length === 0) {
      errors.push("a State object must have at least one field");
    }
  } else {
    const kind = input === null ? "null" : typeof input;
    errors.push(
      `State must be a string, an object, or an array; ${kind} is not accepted`,
    );
    return { ok: false, errors };
  }

  const leaked = findExpectedLabelKeys(input);
  if (leaked.length > 0) {
    errors.push(
      `State must not contain expected labels; remove: ${leaked.join(", ")}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  // The input itself, never a parsed copy: what is sent is what was validated.
  return { ok: true, errors: [], value: input as State };
}

/**
 * Validate an edited `{ state, questions }` pair. Used by the browser before
 * enabling submission and by the route before anything reaches the adapter.
 */
export function validatePlaygroundRequest(
  state: unknown,
  questions: unknown,
): ValidationResult<{ state: State; questions: Questions }> {
  const stateResult = validatePlaygroundState(state);
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

/**
 * Where a State departs from the shape a preset's default questions refer to.
 *
 * Advisory only. The preset schemas describe the named fields the default
 * questions read (`student_message`, `agency_config.agencies`, ...); a State
 * without them is still a valid request, it just gives those questions less to
 * work with. Expected labels are handled by `validatePlaygroundState`, not here.
 */
export function presetStateIssues(
  schemaId: StateSchemaId,
  input: unknown,
): string[] {
  const result = stateSchemas[schemaId].safeParse(input);
  return result.success ? [] : formatIssues(result.error);
}

/* ------------------------------------------ Duplicate JSON object keys -- */

export interface DuplicateKey {
  /** Where the duplicated key sits: `questions`, or `questions.<id>.criteria`. */
  path: string;
  key: string;
}

/**
 * Find duplicated question ids and Choice option keys in raw JSON text.
 *
 * `JSON.parse` silently keeps the last of two equal keys, which would turn a
 * duplicated question or option into a quietly dropped one. This scanner walks
 * already-valid JSON text token by token — no evaluation, and no second parser
 * for values — and reports a repeated key in `questions` or in any
 * `questions.<id>.criteria` object. Duplicates elsewhere are left to
 * `JSON.parse`, deliberately: this check is scoped to the request's own keys.
 *
 * Call it only on text that `JSON.parse` has accepted.
 */
export function findDuplicateRequestKeys(text: string): DuplicateKey[] {
  interface Frame {
    kind: "object" | "array";
    path: string[];
    keys: Set<string>;
    expectKey: boolean;
    pendingKey: string | null;
    index: number;
  }
  const stack: Frame[] = [];
  const found: DuplicateKey[] = [];

  const isTracked = (path: string[]) =>
    (path.length === 1 && path[0] === "questions") ||
    (path.length === 3 && path[0] === "questions" && path[2] === "criteria");

  const childPath = (): string[] => {
    const top = stack[stack.length - 1];
    if (!top) return [];
    if (top.kind === "object") return [...top.path, top.pendingKey ?? ""];
    return [...top.path, String(top.index)];
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "{" || char === "[") {
      stack.push({
        kind: char === "{" ? "object" : "array",
        path: childPath(),
        keys: new Set(),
        expectKey: char === "{",
        pendingKey: null,
        index: 0,
      });
      i += 1;
    } else if (char === "}" || char === "]") {
      stack.pop();
      i += 1;
    } else if (char === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.expectKey = true;
      else if (top) top.index += 1;
      i += 1;
    } else if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      const top = stack[stack.length - 1];
      if (top?.kind === "object" && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key) && isTracked(top.path)) {
          found.push({ path: top.path.join("."), key });
        }
        top.keys.add(key);
        top.pendingKey = key;
        top.expectKey = false;
      }
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return found;
}

/** A duplicate key as one reviewer-facing message. */
export function describeDuplicateKey(duplicate: DuplicateKey): string {
  return duplicate.path === "questions"
    ? `questions — the question id "${duplicate.key}" appears more than once`
    : `${duplicate.path} — the option "${duplicate.key}" appears more than once`;
}

/* ------------------------------------------------ Server request body -- */

/**
 * The only body `POST /api/evaluate` accepts: `{ scenarioId, state, questions }`.
 *
 * `strictObject` is the point: an unknown field is an error, not something to
 * ignore. A client cannot add `model`, `baseURL`, or an API key and have it
 * silently reach the provider. Since JEV-03 the questions are the reviewer's
 * own and are required; `state` and `questions` are accepted as unknown here
 * and checked by `validatePlaygroundRequest` afterwards.
 */
export const evaluateBodySchema = z.strictObject({
  scenarioId: z.enum(["safety", "municipal"]),
  state: z.unknown(),
  questions: z.unknown(),
});

export type EvaluateBody = z.infer<typeof evaluateBodySchema>;

export function validateEvaluateBody(
  input: unknown,
): ValidationResult<EvaluateBody> {
  const result = evaluateBodySchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  const errors: string[] = [];
  if (!("state" in (input as object))) errors.push("state: a State is required");
  if (!("questions" in (input as object))) {
    errors.push("questions: the questions are required");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], value: result.data };
}

/**
 * The only body `POST /api/unlock` accepts: `{ password }`. A password on the
 * evaluate body is still rejected — evaluate never carries credentials.
 */
export const unlockBodySchema = z.strictObject({
  password: z.string(),
});

export type UnlockBody = z.infer<typeof unlockBodySchema>;

export function validateUnlockBody(input: unknown): ValidationResult<UnlockBody> {
  const result = unlockBodySchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
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

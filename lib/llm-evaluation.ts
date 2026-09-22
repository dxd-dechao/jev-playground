/**
 * Server-only adapter for Moonshot chat completions.
 *
 * SERVER ONLY
 * -----------
 * Nothing in this module may reach the browser: it reads `MOONSHOT_API_KEY`
 * from the environment and posts to the Moonshot host. The module-level guard
 * below fails loudly if it is ever bundled into client code. The `server-only`
 * package is not used because its default export throws under plain Node,
 * which would make this module untestable outside a Next bundler — the same
 * pattern as `lib/evaluation.ts`.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 * - Exactly one upstream request per call. No retries, no streaming.
 * - A finite 30-second budget enforced by an `AbortSignal` we control.
 * - Server-owned model and base URL. The browser cannot influence either.
 * - The chat body uses Moonshot structured output (`json_schema`, strict),
 *   built from the submitted questions. Answers are still checked with
 *   `validateUpstreamResult` before they leave here. A malformed reply is an
 *   error, never a partial payload.
 * - Sanitized errors. Upstream bodies, headers, credentials, and submitted
 *   State never leave this module in a message or a log line.
 */

import { validateUpstreamResult } from "./evaluation-response";
import type {
  ChoiceQuestion,
  EvaluationErrorCode,
  Instructions,
  LiveEvaluationPayload,
  Question,
  Questions,
  ScoreQuestion,
  State,
  Usage,
} from "./types";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/llm-evaluation.ts is server-only: it reads MOONSHOT_API_KEY and must " +
      "never be bundled into browser code.",
  );
}

/** Same whole-call budget as `UPSTREAM_TIMEOUT_MS` on the Jev adapter. */
export const LLM_UPSTREAM_TIMEOUT_MS = 30_000;

export const DEFAULT_LLM_MODEL = "kimi-k2.6";
export const DEFAULT_LLM_BASE_URL = "https://api.moonshot.ai/v1";

/** The model id that accepts a disabled thinking switch. Any other id omits it. */
export const LLM_THINKING_DISABLED_MODEL = "kimi-k2.6";

/** Read the key without copying it anywhere it could be logged or returned. */
function readApiKey(): string | null {
  const raw = process.env.MOONSHOT_API_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw;
}

/**
 * Whether a Moonshot key is present — nothing more.
 *
 * This says the server has something to authenticate with. It does not say the
 * key is valid or that Moonshot is reachable. Only a real call can tell you
 * that, and this function deliberately does not make one.
 */
export function isLlmConfigured(): boolean {
  return readApiKey() !== null;
}

/**
 * The model the server will ask for.
 *
 * Trim `MOONSHOT_MODEL` when it is a non-empty string; otherwise `kimi-k2.6`.
 */
export function resolveLlmRequestedModel(): string {
  const raw = process.env.MOONSHOT_MODEL;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return DEFAULT_LLM_MODEL;
}

/**
 * Chat-completions base, with one trailing slash stripped so `/chat/completions`
 * can be appended once.
 */
export function resolveLlmBaseUrl(): string {
  const raw = process.env.MOONSHOT_BASE_URL;
  const base =
    typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : DEFAULT_LLM_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/** Test seam. Production callers pass nothing; tests inject an offline `fetch`. */
export interface LlmEvaluationDeps {
  fetch?: typeof fetch;
  /** Overrides the environment key. Tests pass a synthetic placeholder. */
  apiKey?: string;
}

export interface LlmEvaluateInput {
  state: State;
  questions: Questions;
  /** Aborts the upstream call when the HTTP client goes away. */
  signal?: AbortSignal;
}

/**
 * LLM-specific fixed strings. Do not reuse `ERROR_MESSAGES` from the Jev
 * adapter: those name TypeSafe.
 */
export const LLM_ERROR_MESSAGES: Partial<Record<EvaluationErrorCode, string>> = {
  not_configured:
    "This server has no Moonshot API key, so it cannot call the language model. " +
    "Set MOONSHOT_API_KEY and restart.",
  upstream_auth:
    "Moonshot rejected the server's credentials. The key may be wrong, revoked, " +
    "or lacking access to this model. Check MOONSHOT_API_KEY on the server; the " +
    "key itself is never shown here.",
  upstream_rate_limit:
    "Moonshot rate-limited this request. Nothing was retried automatically — " +
    "wait a moment and submit again if you want another call.",
  upstream_timeout:
    "The language-model call was cancelled after 30 seconds without a complete " +
    "response. It was not retried.",
  upstream_unavailable:
    "Moonshot could not be reached or returned an error. Nothing was retried " +
    "automatically.",
  upstream_malformed:
    "Moonshot returned a response that does not match the questions that were " +
    "submitted, so none of it is shown. Displaying part of it could look like a " +
    "real answer to a different question.",
  request_aborted: "The request was cancelled before a response arrived.",
  internal_error: "The server failed to complete this evaluation.",
};

/** An upstream or configuration failure, already classified and sanitized. */
export class LlmEvaluationError extends Error {
  readonly code: EvaluationErrorCode;

  constructor(code: EvaluationErrorCode) {
    super(LLM_ERROR_MESSAGES[code] ?? "The server failed to complete this evaluation.");
    this.name = "LlmEvaluationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeAnswerContract(id: string, question: Question): string {
  switch (question.type) {
    case "noul":
      return [
        `Question "${id}" is Noul. Return:`,
        `{ "type": "noul", "noul": <probability yes, 0..1> }`,
        "Do not include confidence.",
      ].join("\n");
    case "choice": {
      const keys = Object.keys(question.criteria);
      const probabilities = Object.fromEntries(keys.map((key) => [key, "<0..1>"]));
      return [
        `Question "${id}" is Choice. Submitted option keys: ${keys
          .map((key) => JSON.stringify(key))
          .join(", ")}.`,
        "Return:",
        `{ "type": "choice", "choice": "<one submitted option key>", "probabilities": ${JSON.stringify(probabilities)} }`,
        "Probabilities must include every submitted option key and must sum to 1.",
        "confidence is optional: omit it unless you have a real number in 0..1. Do not invent a confidence.",
      ].join("\n");
    }
    case "score": {
      const highest = question.criteria.length - 1;
      const legend: Record<string, unknown> = {};
      const probabilities: Record<string, string> = {};
      for (const [index, level] of question.criteria.entries()) {
        legend[String(index)] = level;
        probabilities[String(index)] = "<0..1>";
      }
      return [
        `Question "${id}" is Score. Levels are indexed "0" through "${String(highest)}". ` +
          "Copy each level's criteria text into legend; do not paraphrase.",
        `Legend values to copy: ${JSON.stringify(legend)}`,
        "Return:",
        `{ "type": "score", "score": <finite number from 0 through ${String(highest)}>, "legend": <copy the criteria above>, "probabilities": ${JSON.stringify(probabilities)} }`,
        "confidence is optional: omit it unless you have a real number in 0..1. Do not invent a confidence.",
      ].join("\n");
    }
  }
}

type JsonSchema = Record<string, unknown>;

const PROBABILITY_DESCRIPTION =
  "A probability from 0 to 1 inclusive. The values must sum to 1.";

function noulAnswerSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "noul"],
    properties: {
      type: { enum: ["noul"] },
      noul: {
        type: "number",
        description: "The probability of yes, from 0 to 1 inclusive.",
      },
    },
  };
}

function choiceAnswerSchema(question: ChoiceQuestion): JsonSchema {
  const keys = Object.keys(question.criteria);
  const probabilityProperties: Record<string, JsonSchema> = {};
  for (const key of keys) {
    probabilityProperties[key] = {
      type: "number",
      description: PROBABILITY_DESCRIPTION,
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "choice", "probabilities"],
    properties: {
      type: { enum: ["choice"] },
      choice: { enum: keys },
      probabilities: {
        type: "object",
        additionalProperties: false,
        required: keys,
        properties: probabilityProperties,
      },
    },
  };
}

function legendPropertySchema(level: Instructions | null): JsonSchema {
  if (level === null) return { type: "null" };
  if (typeof level === "string") return { enum: [level] };
  if (Array.isArray(level)) return { type: "array" };
  return { type: "object" };
}

function scoreAnswerSchema(question: ScoreQuestion): JsonSchema {
  const highest = question.criteria.length - 1;
  const keys = question.criteria.map((_, index) => String(index));
  const legendProperties: Record<string, JsonSchema> = {};
  const probabilityProperties: Record<string, JsonSchema> = {};
  for (const [index, level] of question.criteria.entries()) {
    const key = String(index);
    legendProperties[key] = legendPropertySchema(level);
    probabilityProperties[key] = {
      type: "number",
      description: PROBABILITY_DESCRIPTION,
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "score", "legend", "probabilities"],
    properties: {
      type: { enum: ["score"] },
      score: {
        type: "number",
        description: `Inclusive range 0 through ${String(highest)}.`,
      },
      legend: {
        type: "object",
        additionalProperties: false,
        required: keys,
        properties: legendProperties,
      },
      probabilities: {
        type: "object",
        additionalProperties: false,
        required: keys,
        properties: probabilityProperties,
      },
    },
  };
}

function answerSchema(question: Question): JsonSchema {
  switch (question.type) {
    case "noul":
      return noulAnswerSchema();
    case "choice":
      return choiceAnswerSchema(question);
    case "score":
      return scoreAnswerSchema(question);
  }
}

/**
 * Moonshot structured-output `response_format` for one request's questions.
 *
 * Field names and types only. Sum-to-1 and numeric ranges stay with
 * `validateUpstreamResult`. Confidence is omitted so the model cannot invent it.
 */
export function buildLlmResponseFormat(questions: Questions): {
  type: "json_schema";
  json_schema: {
    name: "playground_answers";
    strict: true;
    schema: JsonSchema;
  };
} {
  const ids = Object.keys(questions);
  const properties: Record<string, JsonSchema> = {};
  for (const id of ids) {
    const question = questions[id];
    if (question === undefined) continue;
    properties[id] = answerSchema(question);
  }
  return {
    type: "json_schema",
    json_schema: {
      name: "playground_answers",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answers"],
        properties: {
          answers: {
            type: "object",
            additionalProperties: false,
            required: ids,
            properties,
          },
        },
      },
    },
  };
}

/** System message: one JSON object, with each submitted question's answer shape. */
export function buildLlmSystemMessage(questions: Questions): string {
  const contracts = Object.entries(questions)
    .map(([id, question]) => describeAnswerContract(id, question))
    .join("\n\n");
  return [
    "You must reply with a single JSON object and nothing else:",
    '{ "answers": { "<question id>": <answer object> } }',
    "No markdown, no commentary, no extra keys. Every submitted question id must appear exactly once.",
    "",
    contracts,
  ].join("\n");
}

/**
 * If the whole string is one markdown fence, strip that fence once.
 * Otherwise return the original text for `JSON.parse`.
 */
export function stripOneMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:[\w-]+)?\r?\n([\s\S]*?)\r?\n```$/);
  if (match && match[1] !== undefined) return match[1];
  const compact = trimmed.match(/^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/);
  if (compact && compact[1] !== undefined) return compact[1];
  return text;
}

function mapUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const counts: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof raw.prompt_tokens === "number" && Number.isFinite(raw.prompt_tokens)) {
    counts.input_tokens = raw.prompt_tokens;
  }
  if (
    typeof raw.completion_tokens === "number" &&
    Number.isFinite(raw.completion_tokens)
  ) {
    counts.output_tokens = raw.completion_tokens;
  }
  const { input_tokens, output_tokens } = counts;
  if (input_tokens !== undefined && output_tokens !== undefined) {
    return { input_tokens, output_tokens };
  }
  if (input_tokens !== undefined) return { input_tokens };
  if (output_tokens !== undefined) return { output_tokens };
  return undefined;
}

function classifyHttpStatus(status: number): EvaluationErrorCode {
  if (status === 401 || status === 403) return "upstream_auth";
  if (status === 429) return "upstream_rate_limit";
  return "upstream_unavailable";
}

function classifyTransportError(error: unknown, timedOut: boolean): LlmEvaluationError {
  if (error instanceof LlmEvaluationError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmEvaluationError(timedOut ? "upstream_timeout" : "request_aborted");
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  ) {
    return new LlmEvaluationError(timedOut ? "upstream_timeout" : "request_aborted");
  }
  return new LlmEvaluationError("upstream_unavailable");
}

function malformed(): LlmEvaluationError {
  return new LlmEvaluationError("upstream_malformed");
}

function readCompletion(raw: unknown): {
  model: string | undefined;
  content: string;
  usage: unknown;
} {
  if (!isRecord(raw)) throw malformed();
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model : undefined;
  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw malformed();
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) throw malformed();
  const content = first.message.content;
  if (typeof content !== "string") throw malformed();
  return { model, content, usage: raw.usage };
}

function parseAnswersObject(content: string): unknown {
  const stripped = stripOneMarkdownFence(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch {
    throw malformed();
  }
  if (!isRecord(parsed)) throw malformed();
  return parsed.answers;
}

function buildChatBody(
  requestedModel: string,
  state: State,
  questions: Questions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: requestedModel,
    messages: [
      { role: "system", content: buildLlmSystemMessage(questions) },
      { role: "user", content: JSON.stringify({ state, questions }) },
    ],
    stream: false,
    response_format: buildLlmResponseFormat(questions),
  };
  if (requestedModel === LLM_THINKING_DISABLED_MODEL) {
    body.thinking = { type: "disabled" };
    // kimi-k2.6 rejects every temperature except 0.6.
    body.temperature = 0.6;
  }
  return body;
}

/**
 * One evaluation: one Moonshot chat-completions request, no retries, 30-second
 * hard budget. The result is already checked against the submitted questions.
 *
 * @throws {LlmEvaluationError} Always this type — transport errors are classified first.
 */
export async function evaluateWithLlm(
  input: LlmEvaluateInput,
  deps: LlmEvaluationDeps = {},
): Promise<LiveEvaluationPayload> {
  const apiKey = deps.apiKey ?? readApiKey();
  if (apiKey === null) {
    throw new LlmEvaluationError("not_configured");
  }

  const requestedModel = resolveLlmRequestedModel();
  const url = `${resolveLlmBaseUrl()}/chat/completions`;
  const fetchFn = deps.fetch ?? fetch;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LLM_UPSTREAM_TIMEOUT_MS);

  const onCallerAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const started = performance.now();
  let response!: Response;
  try {
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildChatBody(requestedModel, input.state, input.questions)),
        signal: controller.signal,
      });
    } catch (error) {
      throw classifyTransportError(error, timedOut);
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
  const durationMs = performance.now() - started;

  if (!response.ok) {
    throw new LlmEvaluationError(classifyHttpStatus(response.status));
  }

  let completion: unknown;
  try {
    completion = (await response.json()) as unknown;
  } catch {
    throw malformed();
  }

  let extracted: { model: string | undefined; content: string; usage: unknown };
  try {
    extracted = readCompletion(completion);
  } catch (error) {
    if (error instanceof LlmEvaluationError) throw error;
    throw malformed();
  }

  let answers: unknown;
  try {
    answers = parseAnswersObject(extracted.content);
  } catch (error) {
    if (error instanceof LlmEvaluationError) throw error;
    throw malformed();
  }

  const usage = mapUsage(extracted.usage);
  const candidate: Record<string, unknown> = {
    model: extracted.model ?? requestedModel,
    answers,
  };
  if (usage !== undefined) candidate.usage = usage;

  const checked = validateUpstreamResult(candidate, input.questions);
  if (!checked.ok || checked.value === undefined) {
    console.error(
      "[evaluate-llm] upstream response failed validation:",
      checked.errors.join("; "),
    );
    throw malformed();
  }

  const payload: LiveEvaluationPayload = {
    source: "live",
    requestedModel,
    response: {
      model: checked.value.model ?? requestedModel,
      answers: checked.value.answers,
      ...(checked.value.usage ? { usage: checked.value.usage } : {}),
    },
    durationMs,
  };
  return payload;
}

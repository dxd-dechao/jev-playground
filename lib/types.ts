/**
 * Request and answer types for the TypeSafe `systemone` contract.
 *
 * Source of truth: the installed `@typesafe-ai/sdk` type declarations
 * (`node_modules/@typesafe-ai/sdk/dist/index.d.mts`), cross-checked against the
 * saved API snapshot at `../references/sources/typesafe-api.md`. These types are
 * shared by the fixture layer, the server adapter, and the browser, so they must
 * not import the SDK: the SDK is server-only.
 *
 * Notes carried over from the snapshot that are easy to get wrong:
 * - A Noul answer is a *probability that the answer is yes* (0..1). It is not
 *   a boolean and not a severity/offensiveness score.
 * - Noul answers carry no `confidence`. Only Choice and Score do.
 * - Score `criteria` is an ordered array of level descriptions; the API wants
 *   at least 2 and accepts at most 10.
 * - Question ids are keys you choose. The snapshot is explicit that the key is
 *   not sent to the model and is not used in inference, so every question must
 *   be self-contained in its own `instructions`/`criteria`.
 * - A Score answer's `score` is an *expected* value and may land between
 *   integer levels, so it must never be validated as an integer.
 * - `confidence` is optional on this side of the boundary. The SDK declares it
 *   required, but a response that omits it must render rather than crash, and
 *   we must not invent a number for it.
 * - `model` belongs on the request, and the server owns it. The browser never
 *   chooses a model or a provider URL.
 */

/** `instructions` and criteria bodies accept a string or structured data. */
export type Instructions = string | Record<string, unknown> | unknown[];

/** The evaluated content. Both presets here use an object State. */
export type State = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  /** Optional descriptions of what yes and no mean. */
  criteria?: {
    true?: Instructions;
    false?: Instructions;
  };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  /** Option -> rubric description. `null` means "no extra detail needed". */
  criteria: Record<string, Instructions | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  /** Ordered level descriptions, lowest level first. */
  criteria: Instructions[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type Questions = Record<string, Question>;

/**
 * The `{ state, questions }` pair the playground displays and validates.
 *
 * `model` is deliberately absent. The browser never names a model: the server
 * resolves it from its own environment and adds it to the upstream payload.
 */
export interface EvaluationRequest {
  state: State;
  questions: Questions;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability the answer is yes, 0..1. No confidence field exists. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  /** The option the model selected. Not re-derived from `probabilities`. */
  choice: string;
  /** Every option mapped to its probability; floats summing to 1. */
  probabilities: Record<string, number>;
  /** Absent only if the upstream response omitted it. Never invented. */
  confidence?: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted value across levels; can land between levels. */
  score: number;
  /** Level index (string key) -> its description, as the API returned it. */
  legend: Record<string, Instructions | null>;
  /** Level index (string key) -> its probability. */
  probabilities: Record<string, number>;
  /** Absent only if the upstream response omitted it. Never invented. */
  confidence?: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Answers = Record<string, Answer>;

/**
 * Reported token counts.
 *
 * The two counters are independently optional, and the union requires at least
 * one of them: a response that reports only `input_tokens` must keep that number
 * and leave the other field absent. Filling the gap with `0` would turn "not
 * reported" into "reported as zero", which reads as a measurement. A genuine
 * zero is a real count and stays zero.
 */
export type Usage =
  | { input_tokens: number; output_tokens?: number }
  | { input_tokens?: number; output_tokens: number };

/**
 * A full response envelope.
 *
 * A fixture fills only `answers` and deliberately leaves `model` and `usage`
 * undefined, so no fabricated telemetry can be rendered as if it were measured.
 * A live response carries the model TypeSafe actually resolved, and `usage` when
 * the response included it.
 */
export interface EvaluationResponse {
  answers: Answers;
  /** The model that performed the evaluation. Unavailable in fixture mode. */
  model?: string;
  /** Token usage. Unavailable in fixture mode, and absent if not returned. */
  usage?: Usage;
}

/** Where a displayed result came from. Never inferred; always carried. */
export type ResultSource = "fixture" | "live";

/* ------------------------------------------------- Server API boundary -- */

/**
 * The body the browser may send to `POST /api/evaluate`.
 *
 * Only these two fields. The questions are resolved on the server from the
 * scenario preset, so the browser cannot smuggle its own questions, model,
 * provider URL, or credentials into an upstream call.
 */
export interface EvaluateRequestBody {
  scenarioId: string;
  state: unknown;
}

/** A successful live evaluation, as returned to the browser. */
export interface LiveEvaluationPayload {
  source: "live";
  /** The model the server asked for. May differ from the resolved model. */
  requestedModel: string;
  response: {
    /** The model TypeSafe reported. Preserved exactly as received. */
    model: string;
    answers: Answers;
    usage?: Usage;
  };
  /** Wall time measured around the upstream call only, in milliseconds. */
  durationMs: number;
}

/**
 * Error codes the browser may receive. Each maps to one HTTP status and one
 * fixed, sanitized message; upstream bodies and headers are never forwarded.
 */
export type EvaluationErrorCode =
  | "not_configured"
  | "invalid_request"
  | "payload_too_large"
  | "upstream_auth"
  | "upstream_rate_limit"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "upstream_malformed"
  | "request_aborted"
  | "internal_error";

export interface EvaluationErrorPayload {
  error: {
    code: EvaluationErrorCode;
    message: string;
  };
}

/** `GET /api/config`. `configured` means a key is present, nothing more. */
export interface ConfigPayload {
  configured: boolean;
}

/**
 * What the browser knows about server configuration.
 *
 * `unknown` and `unavailable` are kept apart from `missing` because they mean
 * different things to a user: one is "not asked yet or still asking", one is
 * "the check itself failed", and only `missing` is "there is no key". In none of
 * the three is Live mode offered, and in all four Fixture mode works.
 */
export type ConfigStatus = "unknown" | "configured" | "missing" | "unavailable";

/** Answer shape narrowing helpers, used by rendering and composition code. */
export function isNoulAnswer(answer: Answer): answer is NoulAnswer {
  return answer.type === "noul";
}

export function isChoiceAnswer(answer: Answer): answer is ChoiceAnswer {
  return answer.type === "choice";
}

export function isScoreAnswer(answer: Answer): answer is ScoreAnswer {
  return answer.type === "score";
}

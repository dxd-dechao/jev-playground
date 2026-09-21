/**
 * Request and answer types for the TypeSafe `systemone` contract.
 *
 * Source of truth: the locally saved API snapshot at
 * `../references/sources/typesafe-api.md` (read-only reference). Nothing in
 * JEV-01 sends a request; these types exist so the fixture layer and a later
 * live-integration task share one contract.
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
 * - `model` belongs to the request. In this playground the server would own it
 *   in a later task; JEV-01 never builds a live request body.
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
 * `model` is deliberately absent: it is the server's in a later task.
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
  /** The highest-probability option. */
  choice: string;
  /** Every option mapped to its probability; floats summing to 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted value across levels; can land between levels. */
  score: number;
  /** Level index (string key) -> its description. */
  legend: Record<string, string>;
  /** Level index (string key) -> its probability. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Answers = Record<string, Answer>;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * A full response envelope. JEV-01 only ever fills this from a hand-written
 * fixture, and deliberately leaves `model` and `usage` undefined so that no
 * fabricated telemetry can be rendered as if it were measured.
 */
export interface EvaluationResponse {
  answers: Answers;
  /** The model that performed the evaluation. Unavailable in fixture mode. */
  model?: string;
  /** Token usage. Unavailable in fixture mode. */
  usage?: Usage;
}

/** Where a displayed result came from. JEV-01 only produces `fixture`. */
export type ResultSource = "fixture";

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

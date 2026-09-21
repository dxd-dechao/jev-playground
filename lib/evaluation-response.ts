/**
 * Runtime validation of an upstream TypeSafe response against the questions we
 * actually submitted.
 *
 * WHY THIS EXISTS
 * ---------------
 * The SDK's TypeScript types describe the contract; they do not enforce it at
 * runtime. Anything rendered as a typed answer must be checked first, because
 * the alternative is a plausible-looking card built from a malformed payload.
 * A response that does not check out is reported as an upstream error, not
 * patched up, and never mixed with fixture values.
 *
 * WHAT IS DELIBERATELY *NOT* DONE HERE
 * ------------------------------------
 * - No value is invented. A missing `confidence` or `usage` stays missing.
 * - `choice` is not re-derived from `probabilities`. The model's selection is
 *   preserved even if it is not the argmax; second-guessing it here would hide
 *   what the service actually returned.
 * - A Score is not forced to an integer. `score` is an expected value and may
 *   legitimately fall between levels.
 * - Probabilities are not renormalized. They only have to sum to 1 within a
 *   rounding tolerance; rewriting them would misreport the response.
 */

import type {
  Answer,
  Answers,
  ChoiceQuestion,
  EvaluationResponse,
  Instructions,
  Question,
  Questions,
  ScoreQuestion,
  Usage,
} from "./types";

/** Probability sums are reported rounded; this is the slack we allow. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;

export interface ResponseValidation {
  ok: boolean;
  /** One message per problem, safe to log: no State content is quoted. */
  errors: string[];
  value?: EvaluationResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A probability must be a real number in 0..1 — not NaN, not Infinity. */
function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function checkProbabilityMap(
  raw: unknown,
  allowedKeys: readonly string[],
  label: string,
  errors: string[],
): Record<string, number> | null {
  if (!isRecord(raw)) {
    errors.push(`${label}: probabilities must be an object`);
    return null;
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    errors.push(`${label}: probabilities must not be empty`);
    return null;
  }

  const probabilities: Record<string, number> = {};
  let sum = 0;
  let valid = true;

  for (const [key, value] of entries) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${label}: probabilities contain unknown key "${key}"`);
      valid = false;
      continue;
    }
    if (!isProbability(value)) {
      errors.push(
        `${label}: probability for "${key}" is not a finite number between 0 and 1`,
      );
      valid = false;
      continue;
    }
    probabilities[key] = value;
    sum += value;
  }

  if (!valid) return null;
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    errors.push(
      `${label}: probabilities sum to ${sum.toFixed(3)}, which is further from 1 ` +
        `than the ${PROBABILITY_SUM_TOLERANCE} rounding tolerance`,
    );
    return null;
  }
  return probabilities;
}

/**
 * Confidence is optional on purpose: if the response omits it we render
 * "Unavailable" rather than substituting a number. Present but nonsensical is a
 * different thing, and is rejected.
 */
function checkOptionalConfidence(
  raw: Record<string, unknown>,
  label: string,
  errors: string[],
): number | undefined {
  if (!("confidence" in raw) || raw.confidence === null || raw.confidence === undefined) {
    return undefined;
  }
  if (!isProbability(raw.confidence)) {
    errors.push(`${label}: confidence is present but is not a number between 0 and 1`);
    return undefined;
  }
  return raw.confidence;
}

function checkNoul(raw: Record<string, unknown>, label: string, errors: string[]) {
  if (!isProbability(raw.noul)) {
    errors.push(
      `${label}: noul must be a finite probability between 0 and 1 ` +
        "(it is the probability of a yes answer, not a boolean)",
    );
    return null;
  }
  if ("confidence" in raw && raw.confidence !== undefined && raw.confidence !== null) {
    errors.push(
      `${label}: a Noul answer must not carry a confidence value`,
    );
    return null;
  }
  return { type: "noul" as const, noul: raw.noul };
}

function checkChoice(
  raw: Record<string, unknown>,
  question: ChoiceQuestion,
  label: string,
  errors: string[],
) {
  const options = Object.keys(question.criteria);
  if (typeof raw.choice !== "string") {
    errors.push(`${label}: choice must be a string`);
    return null;
  }
  if (!options.includes(raw.choice)) {
    errors.push(
      `${label}: selected option "${raw.choice}" is not one of the options we submitted`,
    );
    return null;
  }
  const probabilities = checkProbabilityMap(raw.probabilities, options, label, errors);
  if (probabilities === null) return null;
  if (!(raw.choice in probabilities)) {
    errors.push(`${label}: selected option "${raw.choice}" has no probability`);
    return null;
  }
  const confidence = checkOptionalConfidence(raw, label, errors);
  const answer: Answer = { type: "choice", choice: raw.choice, probabilities };
  if (confidence !== undefined) answer.confidence = confidence;
  return answer;
}

function checkScore(
  raw: Record<string, unknown>,
  question: ScoreQuestion,
  label: string,
  errors: string[],
) {
  const levelKeys = question.criteria.map((_, index) => String(index));

  if (!isRecord(raw.legend)) {
    errors.push(`${label}: legend must be an object keyed by level`);
    return null;
  }
  const legendKeys = Object.keys(raw.legend);
  const missing = levelKeys.filter((key) => !legendKeys.includes(key));
  const unexpected = legendKeys.filter((key) => !levelKeys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    errors.push(
      `${label}: legend levels do not match the ${levelKeys.length} levels we ` +
        `submitted (missing: ${missing.join(", ") || "none"}; ` +
        `unexpected: ${unexpected.join(", ") || "none"})`,
    );
    return null;
  }

  // An expected score may sit between integer levels, so only the range is checked.
  const highest = levelKeys.length - 1;
  if (
    typeof raw.score !== "number" ||
    !Number.isFinite(raw.score) ||
    raw.score < 0 ||
    raw.score > highest
  ) {
    errors.push(
      `${label}: score must be a finite number within the 0–${highest} range of its legend`,
    );
    return null;
  }

  const probabilities = checkProbabilityMap(raw.probabilities, levelKeys, label, errors);
  if (probabilities === null) return null;

  const confidence = checkOptionalConfidence(raw, label, errors);
  const answer: Answer = {
    type: "score",
    score: raw.score,
    legend: raw.legend as Record<string, Instructions | null>,
    probabilities,
  };
  if (confidence !== undefined) answer.confidence = confidence;
  return answer;
}

function checkAnswer(
  raw: unknown,
  question: Question,
  id: string,
  errors: string[],
): Answer | null {
  const label = `answers.${id}`;
  if (!isRecord(raw)) {
    errors.push(`${label}: answer must be an object`);
    return null;
  }
  if (raw.type !== question.type) {
    errors.push(
      `${label}: answer type "${String(raw.type)}" does not match the ` +
        `submitted question type "${question.type}"`,
    );
    return null;
  }
  switch (question.type) {
    case "noul":
      return checkNoul(raw, label, errors);
    case "choice":
      return checkChoice(raw, question, label, errors);
    case "score":
      return checkScore(raw, question, label, errors);
  }
}

/**
 * Token counts, when present, must be nonnegative whole numbers.
 *
 * Each counter is handled on its own. A count that was reported is kept exactly
 * as received; a count that was absent, null, or rejected stays absent, so the
 * field renders as Unavailable rather than as `0`. The two cases are not the
 * same thing and must not look the same: `0` is a measurement.
 *
 * A partial report is still worth keeping — one real number beats discarding it
 * because its neighbour was missing.
 */
function checkUsage(raw: unknown, errors: string[]): Usage | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    errors.push("usage: must be an object when present");
    return undefined;
  }

  const counts: { input_tokens?: number; output_tokens?: number } = {};
  for (const field of ["input_tokens", "output_tokens"] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      !Number.isInteger(value)
    ) {
      errors.push(`usage.${field}: must be a nonnegative whole number`);
      continue;
    }
    counts[field] = value;
  }

  // Written as three positive cases so each returned object carries only the
  // fields that were actually reported.
  const { input_tokens, output_tokens } = counts;
  if (input_tokens !== undefined && output_tokens !== undefined) {
    return { input_tokens, output_tokens };
  }
  if (input_tokens !== undefined) return { input_tokens };
  if (output_tokens !== undefined) return { output_tokens };
  // Nothing usable was reported. Absent beats a fabricated zero.
  return undefined;
}

/**
 * Validate a whole upstream result against the questions we submitted.
 *
 * Answer ids must match the submitted question ids exactly, in both directions:
 * a missing answer is incomplete, and an extra answer means we are looking at a
 * response to a different request.
 */
export function validateUpstreamResult(
  raw: unknown,
  questions: Questions,
): ResponseValidation {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["response: must be a JSON object"] };
  }

  if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
    errors.push("model: the resolved model name is missing");
  }

  if (!isRecord(raw.answers)) {
    return {
      ok: false,
      errors: [...errors, "answers: must be an object keyed by question id"],
    };
  }

  const questionIds = Object.keys(questions);
  const answerIds = Object.keys(raw.answers);
  const missing = questionIds.filter((id) => !answerIds.includes(id));
  const unexpected = answerIds.filter((id) => !questionIds.includes(id));
  if (missing.length > 0) {
    errors.push(`answers: no answer for ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    errors.push(
      `answers: unexpected answer id ${unexpected.join(", ")} — this response ` +
        "does not correspond to the questions we submitted",
    );
  }

  const answers: Answers = {};
  for (const id of questionIds) {
    const question = questions[id];
    if (!question) continue;
    if (!answerIds.includes(id)) continue;
    const answer = checkAnswer(raw.answers[id], question, id, errors);
    if (answer !== null) answers[id] = answer;
  }

  const usage = checkUsage(raw.usage, errors);

  if (errors.length > 0) return { ok: false, errors };

  const response: EvaluationResponse = {
    answers,
    model: raw.model as string,
  };
  if (usage !== undefined) response.usage = usage;
  return { ok: true, errors: [], value: response };
}

/**
 * A deterministic mock evaluator for offline end-to-end checks.
 *
 * Answers are derived from a hash of the request alone, so the same request
 * always gets the same answer and the answer can carry no label information
 * (the evaluator never sees a case ID or a label). The output is arbitrary and
 * says nothing about Jev: every report built from it is marked MOCK DATA.
 */

import type { Answer, EvaluationRequest, Question } from "../../lib/types";
import { hashJson, unitHash } from "./hash";
import type { Evaluator } from "./types";

export const MOCK_MODEL = "mock-deterministic-evaluator";

function spread(options: string[], chosen: string): Record<string, number> {
  const rest = options.length - 1;
  const probabilities: Record<string, number> = {};
  for (const option of options) {
    probabilities[option] = rest === 0 ? 1 : option === chosen ? 0.7 : 0.3 / rest;
  }
  return probabilities;
}

function mockAnswer(question: Question, seed: string): Answer {
  const u = unitHash(seed, "answer");
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: Math.round(u * 100) / 100 };
    case "choice": {
      const options = Object.keys(question.criteria);
      const choice = options[Math.floor(u * options.length)]!;
      return { type: "choice", choice, probabilities: spread(options, choice), confidence: 0.7 };
    }
    case "score": {
      const levels = question.criteria.map((_, index) => String(index));
      const level = levels[Math.floor(u * levels.length)]!;
      const legend: Record<string, null> = {};
      for (const key of levels) legend[key] = null;
      return { type: "score", score: Number(level), legend, probabilities: spread(levels, level), confidence: 0.7 };
    }
  }
}

/** Returns an upstream-shaped `{ model, answers }` with no usage (unmeasured). */
export function createMockEvaluator(): Evaluator {
  return async (request: EvaluationRequest) => {
    const requestSeed = hashJson(request);
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      answers[id] = mockAnswer(question, `${requestSeed}:${id}`);
    }
    return { model: MOCK_MODEL, answers };
  };
}

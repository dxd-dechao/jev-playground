/**
 * Request builders. Each returns exactly `{ state, questions }`.
 *
 * State is assembled field by field from an explicit whitelist of the case's
 * `input`. The case object is never spread, so an ID, slice, group, label,
 * reviewer, note, or proposed outcome cannot reach State even if someone adds
 * it to `input` by mistake. The questions are the presets' own default
 * questions, unchanged.
 */

import { agencyConfigForState } from "../../lib/agency-definitions";
import { getScenario } from "../../lib/scenarios";
import type { EvaluationRequest, Questions } from "../../lib/types";
import { hashJson } from "./hash";
import type { MunicipalInput, SafetyInput, SuiteId } from "./types";

/** The unchanged default questions for a preset. */
export function defaultQuestions(suite: SuiteId): Questions {
  return getScenario(suite).questions;
}

/** Hash of the exact questions submitted; recorded in every run manifest. */
export function questionsHash(questions: Questions): string {
  return hashJson(questions);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function copyTurns<R extends string>(
  value: unknown,
  roles: readonly R[],
  label: string,
): { role: R; message: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((turn, index) => {
    if (typeof turn !== "object" || turn === null) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const { role, message } = turn as { role?: unknown; message?: unknown };
    if (!roles.includes(role as R)) {
      throw new Error(`${label}[${index}].role must be one of ${roles.join(", ")}`);
    }
    // Only role and message are copied: any other key on the turn is dropped.
    return { role: role as R, message: requireString(message, `${label}[${index}].message`) };
  });
}

/** Municipal State: feedback, clarification history, and agency definitions. */
export function buildMunicipalRequest(input: MunicipalInput): EvaluationRequest {
  return {
    state: {
      feedback: requireString(input.feedback, "input.feedback"),
      clarification_history: copyTurns(
        input.clarification_history,
        ["resident", "officer"] as const,
        "input.clarification_history",
      ),
      agency_config: agencyConfigForState(),
    },
    questions: defaultQuestions("municipal"),
  };
}

/** Safety State: student message, conversation history, learning context. */
export function buildSafetyRequest(input: SafetyInput): EvaluationRequest {
  return {
    state: {
      student_message: requireString(input.student_message, "input.student_message"),
      conversation_history: copyTurns(
        input.conversation_history,
        ["student", "assistant"] as const,
        "input.conversation_history",
      ),
      learning_context: requireString(input.learning_context, "input.learning_context"),
    },
    questions: defaultQuestions("safety"),
  };
}

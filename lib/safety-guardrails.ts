/**
 * Application logic for the Student safety guardrails preset.
 *
 * This is ordinary code, not a model judgment. The three questions in the
 * request are independent — the `handling` question cannot read the other two
 * answers — so reconciling them is this module's job. Raw answers are preserved
 * and displayed separately from whatever this function composes.
 *
 * The Noul answer (`targeted_insult`) is carried through as a probability and
 * is deliberately *not* thresholded into an automatic outcome. Choosing a
 * threshold requires evaluation that has not been done.
 */

import type { SafetyHandling, SafetySelfHarmContext } from "./scenarios";
import { SAFETY_HANDLING_OPTIONS, SAFETY_SELF_HARM_OPTIONS } from "./scenarios";
import type { Answers } from "./types";
import { isChoiceAnswer, isNoulAnswer } from "./types";

export type SafetyRecommendation = "allow" | "support" | "redirect" | "review";

export interface SafetyComposition {
  /** The composed application outcome. Not a model answer. */
  recommendation: SafetyRecommendation;
  /** Why the code landed there, in code's own words. */
  reason: string;
  /** True when the two Choice answers disagree in a way that forces review. */
  conflict: boolean;
  /** Raw answers, carried through unchanged. `null` when absent or malformed. */
  selfHarmContext: SafetySelfHarmContext | null;
  handling: SafetyHandling | null;
  /** Probability that the message is a targeted insult. Display only. */
  targetedInsultProbability: number | null;
}

function readSelfHarmContext(answers: Answers): SafetySelfHarmContext | null {
  const answer = answers["self_harm_context"];
  if (!answer || !isChoiceAnswer(answer)) return null;
  return SAFETY_SELF_HARM_OPTIONS.includes(
    answer.choice as SafetySelfHarmContext,
  )
    ? (answer.choice as SafetySelfHarmContext)
    : null;
}

function readHandling(answers: Answers): SafetyHandling | null {
  const answer = answers["handling"];
  if (!answer || !isChoiceAnswer(answer)) return null;
  return SAFETY_HANDLING_OPTIONS.includes(answer.choice as SafetyHandling)
    ? (answer.choice as SafetyHandling)
    : null;
}

function readTargetedInsult(answers: Answers): number | null {
  const answer = answers["targeted_insult"];
  if (!answer || !isNoulAnswer(answer)) return null;
  return answer.noul;
}

/**
 * Precedence, in order:
 *  1. `urgent_support` or `support_needed` → support. A safety disclosure wins
 *     over everything, including a handling answer that says otherwise.
 *  2. Raw `handling: review` → review. The model flagged unresolved ambiguity.
 *  3. `harmful_request` agrees only with `redirect`. Any other handling answer
 *     is a disagreement the code will not resolve → review.
 *  4. `none` / `contextual` permit `allow` or `redirect`, taken from the
 *     independent handling answer. A `support` answer here contradicts the
 *     self-harm classification → review.
 *  5. Anything missing or unrecognised → review.
 */
export function composeSafetyRecommendation(
  answers: Answers,
): SafetyComposition {
  const selfHarmContext = readSelfHarmContext(answers);
  const handling = readHandling(answers);
  const targetedInsultProbability = readTargetedInsult(answers);

  const base = { selfHarmContext, handling, targetedInsultProbability };

  if (selfHarmContext === null || handling === null) {
    return {
      ...base,
      recommendation: "review",
      conflict: false,
      reason:
        "A required answer is missing or was not one of the defined options, " +
        "so code cannot compose an outcome.",
    };
  }

  if (selfHarmContext === "urgent_support") {
    return {
      ...base,
      recommendation: "support",
      conflict: handling !== "support",
      reason:
        handling === "support"
          ? "Immediate danger was reported and the handling answer agrees: support."
          : `Immediate danger was reported, which takes precedence over the handling answer (${handling}): support.`,
    };
  }

  if (selfHarmContext === "support_needed") {
    return {
      ...base,
      recommendation: "support",
      conflict: handling !== "support",
      reason:
        handling === "support"
          ? "A personal safety concern was reported and the handling answer agrees: support."
          : `A personal safety concern was reported, which takes precedence over the handling answer (${handling}): support.`,
    };
  }

  if (handling === "review") {
    return {
      ...base,
      recommendation: "review",
      conflict: false,
      reason:
        "The handling answer reported material ambiguity that context did not resolve.",
    };
  }

  if (selfHarmContext === "harmful_request") {
    if (handling === "redirect") {
      return {
        ...base,
        recommendation: "redirect",
        conflict: false,
        reason:
          "A request for harmful assistance, and the handling answer agrees: redirect.",
      };
    }
    return {
      ...base,
      recommendation: "review",
      conflict: true,
      reason:
        `A request for harmful assistance was classified, but the handling answer said ${handling}. ` +
        "Code does not resolve that disagreement: review.",
    };
  }

  // selfHarmContext is "none" or "contextual" here.
  if (handling === "support") {
    return {
      ...base,
      recommendation: "review",
      conflict: true,
      reason:
        `No current safety concern was classified (${selfHarmContext}), but the handling answer said support. ` +
        "Code does not resolve that disagreement: review.",
    };
  }

  return {
    ...base,
    recommendation: handling,
    conflict: false,
    reason:
      `No current safety concern was classified (${selfHarmContext}); the independent handling answer was ${handling}.`,
  };
}

/** Plain display labels. “Urgent support” must read as support, not as a block. */
export const SAFETY_SELF_HARM_LABELS: Record<SafetySelfHarmContext, string> = {
  none: "No self-harm signal",
  contextual: "Contextual reference",
  support_needed: "Support needed",
  urgent_support: "Urgent support",
  harmful_request: "Harmful request",
};

export const SAFETY_HANDLING_LABELS: Record<SafetyHandling, string> = {
  allow: "Allow",
  support: "Support",
  redirect: "Redirect",
  review: "Review",
};

export const SAFETY_RECOMMENDATION_LABELS: Record<
  SafetyRecommendation,
  string
> = {
  allow: "Allow",
  support: "Support",
  redirect: "Redirect",
  review: "Human review",
};

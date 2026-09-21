/**
 * Types and fixed vocabularies for the JEV-05 student-safety suite.
 *
 * Labels describe what a reviewer expects; they never reach a request. The
 * `category` label is what the reviewed metrics key on; `handling` is the
 * expected *composed* outcome of the existing `composeSafetyRecommendation`.
 */

import type { EvalCase, LabelField, SafetyInput } from "../shared";
import type { SafetyRecommendation } from "../../lib/safety-guardrails";
import type { SafetySelfHarmContext } from "../../lib/scenarios";
import { SAFETY_SELF_HARM_OPTIONS } from "../../lib/scenarios";

export const SAFETY_CATEGORIES = [
  "expected_support",
  "harmful_request",
  "direct_abuse",
  "legitimate_allow",
  "ambiguous_review",
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export const SAFETY_RECOMMENDATIONS: readonly SafetyRecommendation[] = ["allow", "support", "redirect", "review"];
export { SAFETY_SELF_HARM_OPTIONS };

/** The composed handling each category implies. Checked at load time. */
export const CATEGORY_HANDLING: Record<SafetyCategory, SafetyRecommendation> = {
  expected_support: "support",
  harmful_request: "redirect",
  direct_abuse: "redirect",
  legitimate_allow: "allow",
  ambiguous_review: "review",
};

/**
 * Expected self-harm contexts from which the existing composition can reach
 * each expected composed handling (assuming the raw handling answer equals it).
 * Derived from `composeSafetyRecommendation`; a test verifies the table
 * against that function rather than trusting it.
 */
export const REACHABLE_CONTEXTS: Record<SafetyRecommendation, readonly SafetySelfHarmContext[]> = {
  support: ["support_needed", "urgent_support"],
  redirect: ["none", "contextual", "harmful_request"],
  allow: ["none", "contextual"],
  review: ["none", "contextual", "harmful_request"],
};

/** Extra constraint per category on the expected self-harm context. */
export const CATEGORY_CONTEXTS: Record<SafetyCategory, readonly SafetySelfHarmContext[]> = {
  expected_support: ["support_needed", "urgent_support"],
  harmful_request: ["harmful_request"],
  direct_abuse: ["none", "contextual"],
  legitimate_allow: ["none", "contextual"],
  ambiguous_review: ["none", "contextual", "harmful_request"],
};

export type SafetyLabels = {
  self_harm_context?: LabelField<SafetySelfHarmContext>;
  handling?: LabelField<SafetyRecommendation>;
  category?: LabelField<SafetyCategory>;
};

export type SafetyCase = EvalCase<SafetyInput, SafetyLabels>;

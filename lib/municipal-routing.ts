/**
 * Application logic for the Municipal ticket triage preset.
 *
 * The two questions are independent: the disposition question cannot read the
 * primary-agency answer from the same request. This module reconciles the
 * returned pair while preserving both raw answers.
 *
 * Reconciliation rules (from the approved scenario specification):
 *  - `routable` with a named agency → recommend that agency for reviewer
 *    consideration.
 *  - `needs_clarification` → show any plausible agency as *tentative* and say
 *    that information is missing.
 *  - `outside_scope` or `non_actionable` → show no routing recommendation, even
 *    if the parallel agency question selected a named agency.
 *  - `human_review`, or `routable` paired with `Unclear` → a review-required
 *    state, rather than forcing an assignment.
 *
 * `confidence` is carried through for display but is never presented as a
 * measured probability that the agency is correct.
 */

import { AGENCY_OPTIONS, UNCLEAR_AGENCY } from "./agency-definitions";
import type { MunicipalDisposition } from "./scenarios";
import { MUNICIPAL_DISPOSITION_OPTIONS } from "./scenarios";
import type { Answers } from "./types";
import { isChoiceAnswer } from "./types";

export type MunicipalRoutingStatus =
  /** A named agency is recommended for reviewer consideration. */
  | "recommended"
  /** A plausible agency is shown, but material facts are missing. */
  | "tentative"
  /** No routing recommendation is shown at all. */
  | "suppressed"
  /** Responsibility cannot be resolved; a human decides. */
  | "review";

export interface MunicipalComposition {
  status: MunicipalRoutingStatus;
  /** Set only when `status` is "recommended". */
  recommendedAgency: string | null;
  /** Set only when `status` is "tentative". */
  tentativeAgency: string | null;
  /** True when the routing step reported missing material facts. */
  informationMissing: boolean;
  reason: string;
  /** Raw answers, carried through unchanged. */
  primaryAgency: string | null;
  disposition: MunicipalDisposition | null;
}

function readPrimaryAgency(answers: Answers): string | null {
  const answer = answers["primary_agency"];
  if (!answer || !isChoiceAnswer(answer)) return null;
  return AGENCY_OPTIONS.includes(answer.choice) ? answer.choice : null;
}

function readDisposition(answers: Answers): MunicipalDisposition | null {
  const answer = answers["disposition"];
  if (!answer || !isChoiceAnswer(answer)) return null;
  return MUNICIPAL_DISPOSITION_OPTIONS.includes(
    answer.choice as MunicipalDisposition,
  )
    ? (answer.choice as MunicipalDisposition)
    : null;
}

export function composeMunicipalRouting(answers: Answers): MunicipalComposition {
  const primaryAgency = readPrimaryAgency(answers);
  const disposition = readDisposition(answers);

  const base = {
    primaryAgency,
    disposition,
    recommendedAgency: null,
    tentativeAgency: null,
    informationMissing: false,
  };

  if (disposition === null || primaryAgency === null) {
    return {
      ...base,
      status: "review",
      reason:
        "A required answer is missing or was not one of the defined options, " +
        "so code cannot compose a routing outcome.",
    };
  }

  const namedAgency = primaryAgency === UNCLEAR_AGENCY ? null : primaryAgency;

  if (disposition === "outside_scope" || disposition === "non_actionable") {
    return {
      ...base,
      status: "suppressed",
      reason:
        disposition === "outside_scope"
          ? "The routing step said this is clearly outside the configured service scope, so no agency is recommended" +
            (namedAgency
              ? ` — the parallel agency answer (${namedAgency}) is suppressed.`
              : ".")
          : "The routing step said there is nothing to act on, so no agency is recommended" +
            (namedAgency
              ? ` — the parallel agency answer (${namedAgency}) is suppressed.`
              : "."),
    };
  }

  if (disposition === "needs_clarification") {
    return {
      ...base,
      status: "tentative",
      tentativeAgency: namedAgency,
      informationMissing: true,
      reason: namedAgency
        ? `Material facts are missing, so ${namedAgency} is shown as a tentative candidate only.`
        : "Material facts are missing and no agency candidate was named.",
    };
  }

  if (disposition === "human_review") {
    return {
      ...base,
      status: "review",
      reason:
        "The routing step said responsibility is disputed or cannot be " +
        "resolved under the supplied definitions, so no assignment is forced.",
    };
  }

  // disposition === "routable"
  if (namedAgency === null) {
    return {
      ...base,
      status: "review",
      reason:
        "The routing step said there is enough detail to route, but the agency " +
        "answer was Unclear. Code does not force an assignment: review.",
    };
  }

  return {
    ...base,
    status: "recommended",
    recommendedAgency: namedAgency,
    reason: `There is enough detail to route, and ${namedAgency} is the recommended candidate for reviewer consideration.`,
  };
}

export const MUNICIPAL_DISPOSITION_LABELS: Record<
  MunicipalDisposition,
  string
> = {
  routable: "Routable",
  needs_clarification: "Needs clarification",
  outside_scope: "Outside scope",
  non_actionable: "Non-actionable",
  human_review: "Human review",
};

export const MUNICIPAL_STATUS_LABELS: Record<MunicipalRoutingStatus, string> = {
  recommended: "Recommended agency",
  tentative: "Tentative candidate",
  suppressed: "No routing recommendation",
  review: "Review required",
};

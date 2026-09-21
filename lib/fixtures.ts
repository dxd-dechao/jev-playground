/**
 * Fixture responses.
 *
 * WHAT THESE ARE
 * --------------
 * Hand-written, fixed illustrative responses. No model produced them and no
 * request is sent when one is shown. They exist so a reviewer can see the shape
 * of a typed answer, the full probability distribution, and how the application
 * composition code behaves — without an API key.
 *
 * WHAT THESE ARE NOT
 * ------------------
 * They are not measured Jev output and say nothing about how Jev would answer.
 * A fixture does not change meaning when you edit State: it is looked up by
 * exact equality against a known sample State, never derived from the text. No
 * keyword heuristic classifies your input. If the submitted State does not
 * exactly match a sample, a clearly labelled generic placeholder is shown
 * instead.
 *
 * Fixtures carry no `model` and no `usage`, so fabricated telemetry cannot be
 * rendered as if it had been measured.
 */

import type { ScenarioId } from "./scenarios";
import type { Answers, EvaluationResponse, State } from "./types";
import { SCENARIOS } from "./scenarios";

export type FixtureKind = "sample" | "generic";

export interface FixtureResult {
  kind: FixtureKind;
  /** Short name for the fixture, shown next to the badge. */
  label: string;
  /** One sentence a reviewer can read to know what they are looking at. */
  disclaimer: string;
  response: EvaluationResponse;
}

export const FIXTURE_BADGE_TEXT = "Fixture data — no model call";

export const FIXTURE_EXPLANATION =
  "These answers are fixed, hand-written illustrations of the response shape. " +
  "No model was called and nothing left your browser. A fixture does not " +
  "respond to your edits: editing State does not change what these numbers " +
  "mean, and they are not evidence of how Jev would answer.";

/* ------------------------------------------------- Safety preset fixtures -- */

function safetyAnswers(
  selfHarm: { choice: string; probabilities: Record<string, number>; confidence: number },
  insult: number,
  handling: { choice: string; probabilities: Record<string, number>; confidence: number },
): Answers {
  return {
    self_harm_context: { type: "choice", ...selfHarm },
    targeted_insult: { type: "noul", noul: insult },
    handling: { type: "choice", ...handling },
  };
}

const SAFETY_SAMPLE_FIXTURES: Record<string, Answers> = {
  "self-harm-immediate": safetyAnswers(
    {
      choice: "urgent_support",
      probabilities: {
        none: 0.0,
        contextual: 0.005,
        support_needed: 0.06,
        urgent_support: 0.93,
        harmful_request: 0.005,
      },
      confidence: 0.91,
    },
    0.02,
    {
      choice: "support",
      probabilities: { allow: 0.005, support: 0.96, redirect: 0.005, review: 0.03 },
      confidence: 0.94,
    },
  ),
  "self-harm-distress": safetyAnswers(
    {
      choice: "support_needed",
      probabilities: {
        none: 0.005,
        contextual: 0.03,
        support_needed: 0.88,
        urgent_support: 0.08,
        harmful_request: 0.005,
      },
      confidence: 0.84,
    },
    0.02,
    {
      choice: "support",
      probabilities: { allow: 0.015, support: 0.94, redirect: 0.005, review: 0.04 },
      confidence: 0.9,
    },
  ),
  "self-harm-harmful-request": safetyAnswers(
    {
      choice: "harmful_request",
      probabilities: {
        none: 0.005,
        contextual: 0.015,
        support_needed: 0.04,
        urgent_support: 0.04,
        harmful_request: 0.9,
      },
      confidence: 0.86,
    },
    0.01,
    {
      choice: "redirect",
      probabilities: { allow: 0.01, support: 0.09, redirect: 0.86, review: 0.04 },
      confidence: 0.8,
    },
  ),
  "insult-direct-attack": safetyAnswers(
    {
      choice: "none",
      probabilities: {
        none: 0.94,
        contextual: 0.03,
        support_needed: 0.015,
        urgent_support: 0.005,
        harmful_request: 0.01,
      },
      confidence: 0.92,
    },
    0.94,
    {
      choice: "redirect",
      probabilities: { allow: 0.04, support: 0.01, redirect: 0.9, review: 0.05 },
      confidence: 0.86,
    },
  ),
  "allow-reporting-insult": safetyAnswers(
    {
      choice: "none",
      probabilities: {
        none: 0.92,
        contextual: 0.05,
        support_needed: 0.02,
        urgent_support: 0.005,
        harmful_request: 0.005,
      },
      confidence: 0.89,
    },
    0.08,
    {
      choice: "allow",
      probabilities: { allow: 0.88, support: 0.01, redirect: 0.04, review: 0.07 },
      confidence: 0.83,
    },
  ),
  "allow-literature": safetyAnswers(
    {
      choice: "contextual",
      probabilities: {
        none: 0.05,
        contextual: 0.93,
        support_needed: 0.015,
        urgent_support: 0.005,
        harmful_request: 0.0,
      },
      confidence: 0.9,
    },
    0.02,
    {
      choice: "allow",
      probabilities: { allow: 0.94, support: 0.01, redirect: 0.01, review: 0.04 },
      confidence: 0.91,
    },
  ),
  "allow-idiom": safetyAnswers(
    {
      choice: "none",
      probabilities: {
        none: 0.89,
        contextual: 0.09,
        support_needed: 0.015,
        urgent_support: 0.0,
        harmful_request: 0.005,
      },
      confidence: 0.85,
    },
    0.03,
    {
      choice: "allow",
      probabilities: { allow: 0.95, support: 0.01, redirect: 0.01, review: 0.03 },
      confidence: 0.92,
    },
  ),
  "allow-criticism": safetyAnswers(
    {
      choice: "none",
      probabilities: {
        none: 0.96,
        contextual: 0.02,
        support_needed: 0.01,
        urgent_support: 0.005,
        harmful_request: 0.005,
      },
      confidence: 0.94,
    },
    0.09,
    {
      choice: "allow",
      probabilities: { allow: 0.93, support: 0.005, redirect: 0.015, review: 0.05 },
      confidence: 0.9,
    },
  ),
  "allow-recovery": safetyAnswers(
    {
      choice: "contextual",
      probabilities: {
        none: 0.02,
        contextual: 0.9,
        support_needed: 0.07,
        urgent_support: 0.005,
        harmful_request: 0.005,
      },
      confidence: 0.85,
    },
    0.01,
    {
      choice: "allow",
      probabilities: { allow: 0.89, support: 0.07, redirect: 0.005, review: 0.035 },
      confidence: 0.83,
    },
  ),
};

/**
 * The placeholder shown for any safety State that is not one of the samples.
 * It is deliberately flat and lands on review: a placeholder must not look like
 * a verdict on text nobody evaluated.
 */
const SAFETY_GENERIC_FIXTURE: Answers = safetyAnswers(
  {
    choice: "none",
    probabilities: {
      none: 0.25,
      contextual: 0.25,
      support_needed: 0.2,
      urgent_support: 0.15,
      harmful_request: 0.15,
    },
    confidence: 0.12,
  },
  0.5,
  {
    choice: "review",
    probabilities: { allow: 0.2, support: 0.2, redirect: 0.2, review: 0.4 },
    confidence: 0.2,
  },
);

/* ---------------------------------------------- Municipal preset fixtures -- */

function municipalAnswers(
  agency: { choice: string; probabilities: Record<string, number>; confidence: number },
  disposition: { choice: string; probabilities: Record<string, number>; confidence: number },
): Answers {
  return {
    primary_agency: { type: "choice", ...agency },
    disposition: { type: "choice", ...disposition },
  };
}

const MUNICIPAL_SAMPLE_FIXTURES: Record<string, Answers> = {
  "municipal-traffic-light": municipalAnswers(
    {
      choice: "LTA",
      probabilities: {
        HDB: 0.005,
        LTA: 0.94,
        NEA: 0.0,
        PUB: 0.005,
        NParks: 0.0,
        "Town Council": 0.03,
        SPF: 0.015,
        BCA: 0.0,
        URA: 0.0,
        SLA: 0.0,
        Unclear: 0.005,
      },
      confidence: 0.92,
    },
    {
      choice: "routable",
      probabilities: {
        routable: 0.93,
        needs_clarification: 0.05,
        outside_scope: 0.0,
        non_actionable: 0.005,
        human_review: 0.015,
      },
      confidence: 0.9,
    },
  ),
  "municipal-thin-directional": municipalAnswers(
    {
      choice: "Town Council",
      probabilities: {
        HDB: 0.08,
        LTA: 0.005,
        NEA: 0.3,
        PUB: 0.01,
        NParks: 0.02,
        "Town Council": 0.52,
        SPF: 0.0,
        BCA: 0.0,
        URA: 0.0,
        SLA: 0.005,
        Unclear: 0.06,
      },
      confidence: 0.41,
    },
    {
      choice: "needs_clarification",
      probabilities: {
        routable: 0.12,
        needs_clarification: 0.78,
        outside_scope: 0.01,
        non_actionable: 0.03,
        human_review: 0.06,
      },
      confidence: 0.7,
    },
  ),
  "municipal-unrelated": municipalAnswers(
    {
      choice: "Unclear",
      probabilities: {
        HDB: 0.005,
        LTA: 0.0,
        NEA: 0.02,
        PUB: 0.0,
        NParks: 0.005,
        "Town Council": 0.015,
        SPF: 0.0,
        BCA: 0.0,
        URA: 0.0,
        SLA: 0.005,
        Unclear: 0.95,
      },
      confidence: 0.93,
    },
    {
      choice: "outside_scope",
      probabilities: {
        routable: 0.005,
        needs_clarification: 0.03,
        outside_scope: 0.7,
        non_actionable: 0.26,
        human_review: 0.005,
      },
      confidence: 0.62,
    },
  ),
};

const MUNICIPAL_GENERIC_FIXTURE: Answers = municipalAnswers(
  {
    choice: "Unclear",
    probabilities: {
      HDB: 0.1,
      LTA: 0.1,
      NEA: 0.1,
      PUB: 0.08,
      NParks: 0.07,
      "Town Council": 0.12,
      SPF: 0.06,
      BCA: 0.03,
      URA: 0.02,
      SLA: 0.02,
      Unclear: 0.3,
    },
    confidence: 0.18,
  },
  {
    choice: "human_review",
    probabilities: {
      routable: 0.2,
      needs_clarification: 0.2,
      outside_scope: 0.1,
      non_actionable: 0.1,
      human_review: 0.4,
    },
    confidence: 0.25,
  },
);

/* ------------------------------------------------------------- Selection -- */

const SAMPLE_FIXTURES: Record<ScenarioId, Record<string, Answers>> = {
  safety: SAFETY_SAMPLE_FIXTURES,
  municipal: MUNICIPAL_SAMPLE_FIXTURES,
};

const GENERIC_FIXTURES: Record<ScenarioId, Answers> = {
  safety: SAFETY_GENERIC_FIXTURE,
  municipal: MUNICIPAL_GENERIC_FIXTURE,
};

/** Order-insensitive structural equality, used for sample lookup. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (aKeys.some((key, index) => key !== bKeys[index])) return false;
    return aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

/** The sample whose State is structurally identical to `state`, if any. */
export function matchSampleId(
  scenarioId: ScenarioId,
  state: State,
): string | null {
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (!scenario) return null;
  const match = scenario.samples.find((sample) =>
    deepEqual(sample.state, state),
  );
  return match ? match.id : null;
}

/**
 * Look up the fixture to show for a submitted State.
 *
 * Lookup is exact-equality only. Any edit to a sample — even a trailing space —
 * falls through to the generic placeholder, which is the honest answer: there is
 * no fixture for text nobody evaluated.
 */
export function resolveFixture(
  scenarioId: ScenarioId,
  state: State,
): FixtureResult {
  const sampleId = matchSampleId(scenarioId, state);
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId);
  const sample = scenario?.samples.find((entry) => entry.id === sampleId);

  if (sampleId && sample) {
    const answers = SAMPLE_FIXTURES[scenarioId][sampleId];
    if (answers) {
      return {
        kind: "sample",
        label: `Sample fixture — ${sample.label}`,
        disclaimer:
          "A fixed illustrative response written for this sample. It was not " +
          "produced by a model and is not evidence of Jev's behaviour.",
        response: { answers },
      };
    }
  }

  return {
    kind: "generic",
    label: "Generic placeholder fixture",
    disclaimer:
      "This State does not match any sample, so there is no fixture for it. " +
      "The values below are a fixed placeholder: they were not derived from " +
      "your text, and they are not a judgement of it.",
    response: { answers: GENERIC_FIXTURES[scenarioId] },
  };
}

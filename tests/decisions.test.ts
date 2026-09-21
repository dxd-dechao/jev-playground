/**
 * Unit tests for the pure composition functions and the fixture layer.
 *
 * These verify *code behaviour*: given a set of answers, does the application
 * logic reconcile them the way the specification says. They say nothing about
 * whether Jev would produce those answers, and they are not a quality
 * measurement of any kind. The conflicting answer sets below are constructed by
 * hand precisely because no real response is involved.
 */

import { describe, expect, it } from "vitest";
import {
  AGENCY_OPTIONS,
  AGENCY_TAXONOMY_VERSION,
  agencyChoiceCriteria,
} from "@/lib/agency-definitions";
import {
  FIXTURE_BADGE_TEXT,
  matchSampleId,
  resolveFixture,
} from "@/lib/fixtures";
import { composeMunicipalRouting } from "@/lib/municipal-routing";
import { composeSafetyRecommendation } from "@/lib/safety-guardrails";
import {
  MUNICIPAL_DISPOSITION_OPTIONS,
  SAFETY_HANDLING_OPTIONS,
  SAFETY_SELF_HARM_OPTIONS,
  SCENARIOS,
  getScenario,
} from "@/lib/scenarios";
import type { Answers, ChoiceAnswer, NoulAnswer } from "@/lib/types";

/* --------------------------------------------------------- test builders -- */

/** Build a Choice answer that puts `winner` on top of an even remainder. */
function choiceAnswer(
  winner: string,
  options: readonly string[],
  winnerProbability = 0.8,
  confidence = 0.7,
): ChoiceAnswer {
  const others = options.filter((option) => option !== winner);
  const share = (1 - winnerProbability) / others.length;
  const probabilities: Record<string, number> = { [winner]: winnerProbability };
  for (const option of others) probabilities[option] = share;
  return { type: "choice", choice: winner, probabilities, confidence };
}

function noulAnswer(value: number): NoulAnswer {
  return { type: "noul", noul: value };
}

function safetyAnswerSet(
  selfHarm: string,
  handling: string,
  insult = 0.1,
): Answers {
  return {
    self_harm_context: choiceAnswer(selfHarm, SAFETY_SELF_HARM_OPTIONS),
    targeted_insult: noulAnswer(insult),
    handling: choiceAnswer(handling, SAFETY_HANDLING_OPTIONS),
  };
}

function municipalAnswerSet(agency: string, disposition: string): Answers {
  return {
    primary_agency: choiceAnswer(agency, AGENCY_OPTIONS),
    disposition: choiceAnswer(disposition, MUNICIPAL_DISPOSITION_OPTIONS),
  };
}

/* ------------------------------------------------- safety composition ----- */

describe("composeSafetyRecommendation", () => {
  it("gives urgent_support precedence over a contradicting handling answer", () => {
    const composition = composeSafetyRecommendation(
      safetyAnswerSet("urgent_support", "redirect"),
    );
    expect(composition.recommendation).toBe("support");
    expect(composition.conflict).toBe(true);
    // The raw answers survive untouched.
    expect(composition.selfHarmContext).toBe("urgent_support");
    expect(composition.handling).toBe("redirect");
  });

  it("gives urgent_support precedence over a raw handling of review", () => {
    const composition = composeSafetyRecommendation(
      safetyAnswerSet("urgent_support", "review"),
    );
    expect(composition.recommendation).toBe("support");
  });

  it("gives support_needed precedence and agrees without conflict when handling says support", () => {
    const composition = composeSafetyRecommendation(
      safetyAnswerSet("support_needed", "support"),
    );
    expect(composition.recommendation).toBe("support");
    expect(composition.conflict).toBe(false);
  });

  it("escalates a harmful_request paired with allow to review", () => {
    const composition = composeSafetyRecommendation(
      safetyAnswerSet("harmful_request", "allow"),
    );
    expect(composition.recommendation).toBe("review");
    expect(composition.conflict).toBe(true);
  });

  it("redirects when harmful_request and redirect agree", () => {
    const composition = composeSafetyRecommendation(
      safetyAnswerSet("harmful_request", "redirect"),
    );
    expect(composition.recommendation).toBe("redirect");
    expect(composition.conflict).toBe(false);
  });

  it("routes a raw handling of review to review", () => {
    const composition = composeSafetyRecommendation(
      safetyAnswerSet("none", "review"),
    );
    expect(composition.recommendation).toBe("review");
    expect(composition.conflict).toBe(false);
  });

  it("treats a support answer with no safety classification as a conflict", () => {
    for (const context of ["none", "contextual"] as const) {
      const composition = composeSafetyRecommendation(
        safetyAnswerSet(context, "support"),
      );
      expect(composition.recommendation).toBe("review");
      expect(composition.conflict).toBe(true);
    }
  });

  it("follows the independent handling answer for none and contextual", () => {
    expect(
      composeSafetyRecommendation(safetyAnswerSet("contextual", "allow"))
        .recommendation,
    ).toBe("allow");
    expect(
      composeSafetyRecommendation(safetyAnswerSet("none", "redirect"))
        .recommendation,
    ).toBe("redirect");
  });

  it("never lets the Noul probability override the composed outcome", () => {
    // Identical Choice answers, opposite extremes of the Noul probability.
    const low = composeSafetyRecommendation(safetyAnswerSet("none", "allow", 0.01));
    const high = composeSafetyRecommendation(safetyAnswerSet("none", "allow", 0.99));
    expect(low.recommendation).toBe("allow");
    expect(high.recommendation).toBe("allow");
    // The probability is carried through for display, not consumed.
    expect(low.targetedInsultProbability).toBe(0.01);
    expect(high.targetedInsultProbability).toBe(0.99);
  });

  it("reviews when a required answer is missing or off-menu", () => {
    expect(
      composeSafetyRecommendation({
        targeted_insult: noulAnswer(0.5),
      }).recommendation,
    ).toBe("review");

    expect(
      composeSafetyRecommendation({
        self_harm_context: {
          type: "choice",
          choice: "not_a_defined_option",
          probabilities: { not_a_defined_option: 1 },
          confidence: 0.9,
        },
        targeted_insult: noulAnswer(0.5),
        handling: choiceAnswer("allow", SAFETY_HANDLING_OPTIONS),
      }).recommendation,
    ).toBe("review");
  });
});

/* ---------------------------------------------- municipal composition ----- */

describe("composeMunicipalRouting", () => {
  it("recommends the named agency when the feedback is routable", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("LTA", "routable"),
    );
    expect(composition.status).toBe("recommended");
    expect(composition.recommendedAgency).toBe("LTA");
    expect(composition.tentativeAgency).toBeNull();
  });

  it("suppresses a named agency when the disposition is outside_scope", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("NEA", "outside_scope"),
    );
    expect(composition.status).toBe("suppressed");
    expect(composition.recommendedAgency).toBeNull();
    expect(composition.tentativeAgency).toBeNull();
    // The raw answer is still preserved for display.
    expect(composition.primaryAgency).toBe("NEA");
  });

  it("suppresses a named agency when the disposition is non_actionable", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("Town Council", "non_actionable"),
    );
    expect(composition.status).toBe("suppressed");
    expect(composition.recommendedAgency).toBeNull();
  });

  it("shows a tentative agency when facts are missing", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("Town Council", "needs_clarification"),
    );
    expect(composition.status).toBe("tentative");
    expect(composition.tentativeAgency).toBe("Town Council");
    expect(composition.recommendedAgency).toBeNull();
    expect(composition.informationMissing).toBe(true);
  });

  it("keeps a tentative status with no candidate when facts are missing and the agency is Unclear", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("Unclear", "needs_clarification"),
    );
    expect(composition.status).toBe("tentative");
    expect(composition.tentativeAgency).toBeNull();
    expect(composition.informationMissing).toBe(true);
  });

  it("requires review when routable is paired with Unclear", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("Unclear", "routable"),
    );
    expect(composition.status).toBe("review");
    expect(composition.recommendedAgency).toBeNull();
    expect(composition.tentativeAgency).toBeNull();
  });

  it("requires review when the disposition is human_review, without forcing an assignment", () => {
    const composition = composeMunicipalRouting(
      municipalAnswerSet("HDB", "human_review"),
    );
    expect(composition.status).toBe("review");
    expect(composition.recommendedAgency).toBeNull();
    expect(composition.primaryAgency).toBe("HDB");
  });

  it("reviews when a required answer is missing or off-menu", () => {
    expect(composeMunicipalRouting({}).status).toBe("review");
    expect(
      composeMunicipalRouting({
        primary_agency: choiceAnswer("MOT", ["MOT", "LTA"]),
        disposition: choiceAnswer("routable", MUNICIPAL_DISPOSITION_OPTIONS),
      }).status,
    ).toBe("review");
  });
});

/* --------------------------------------------------- agency definitions --- */

describe("agency definitions", () => {
  it("offers eleven Choice options, the ten agencies plus Unclear", () => {
    expect(AGENCY_OPTIONS).toHaveLength(11);
    expect(AGENCY_OPTIONS).toContain("Unclear");
    expect(new Set(AGENCY_OPTIONS).size).toBe(11);
  });

  it("gives every option its own responsibility definition", () => {
    const criteria = agencyChoiceCriteria();
    expect(Object.keys(criteria).sort()).toEqual([...AGENCY_OPTIONS].sort());
    for (const description of Object.values(criteria)) {
      expect(description.trim().length).toBeGreaterThan(10);
    }
  });

  it("is versioned so a change to the prototype taxonomy is visible", () => {
    expect(AGENCY_TAXONOMY_VERSION).toMatch(/^prototype-\d{4}-\d{2}-\d{2}$/);
  });
});

/* ------------------------------------------------------------- fixtures --- */

describe("fixtures", () => {
  it("has a sample-specific fixture for all twelve samples", () => {
    let count = 0;
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        const fixture = resolveFixture(scenario.id, sample.state);
        expect(fixture.kind, `${scenario.id}/${sample.id}`).toBe("sample");
        expect(fixture.label).toContain(sample.label);
        count += 1;
      }
    }
    expect(count).toBe(12);
  });

  it("falls back to an explicitly labelled generic fixture for edited State", () => {
    const fixture = resolveFixture("safety", {
      student_message: "Something nobody wrote a fixture for.",
      conversation_history: [],
      learning_context: "Student learning assistant.",
    });
    expect(fixture.kind).toBe("generic");
    expect(fixture.label.toLowerCase()).toContain("placeholder");
    expect(fixture.disclaimer).toContain("not a judgement");
  });

  it("matches a sample only on exact State equality, never on wording", () => {
    const sample = getScenario("safety").samples[0]!;
    expect(matchSampleId("safety", sample.state)).toBe(sample.id);

    const nudged = {
      ...(sample.state as Record<string, unknown>),
      learning_context: "Student learning assistant. ",
    };
    expect(matchSampleId("safety", nudged)).toBeNull();
  });

  it("carries no model and no usage, so no fixture number can pose as telemetry", () => {
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        const { response } = resolveFixture(scenario.id, sample.state);
        expect(response.model).toBeUndefined();
        expect(response.usage).toBeUndefined();
      }
    }
  });

  it("keeps every distribution complete, summing to 1, with choice as the argmax", () => {
    for (const scenario of SCENARIOS) {
      const cases = [
        ...scenario.samples.map((sample) => sample.state),
        // Also exercise the generic fallback for this scenario.
        { unmatched: true },
      ];
      for (const state of cases) {
        const { response } = resolveFixture(scenario.id, state);
        for (const id of scenario.questionOrder) {
          const answer = response.answers[id];
          expect(answer, `${scenario.id}/${id}`).toBeDefined();
          if (!answer || answer.type !== "choice") continue;

          const question = scenario.questions[id];
          if (question?.type === "choice") {
            // Every defined option appears in the distribution.
            expect(Object.keys(answer.probabilities).sort()).toEqual(
              Object.keys(question.criteria).sort(),
            );
          }
          const total = Object.values(answer.probabilities).reduce(
            (sum, value) => sum + value,
            0,
          );
          expect(total).toBeCloseTo(1, 6);

          const argmax = Object.entries(answer.probabilities).reduce(
            (best, entry) => (entry[1] > best[1] ? entry : best),
          );
          expect(answer.choice).toBe(argmax[0]);
          expect(answer.confidence).toBeGreaterThanOrEqual(0);
          expect(answer.confidence).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("keeps every Noul answer a probability in 0..1 with no confidence field", () => {
    const { response } = resolveFixture(
      "safety",
      getScenario("safety").samples[3]!.state,
    );
    const answer = response.answers["targeted_insult"];
    expect(answer?.type).toBe("noul");
    if (answer?.type === "noul") {
      expect(answer.noul).toBeGreaterThanOrEqual(0);
      expect(answer.noul).toBeLessThanOrEqual(1);
      expect("confidence" in answer).toBe(false);
    }
  });

  it("states plainly in its badge that no model was called", () => {
    expect(FIXTURE_BADGE_TEXT).toContain("no model call");
  });
});

/* ------------------------------------------------- sample-level outcomes -- */

describe("sample fixtures compose to the proposed expected outcomes", () => {
  const expectedSafety: Record<string, string> = {
    "self-harm-immediate": "support",
    "self-harm-distress": "support",
    "self-harm-harmful-request": "redirect",
    "insult-direct-attack": "redirect",
    "allow-reporting-insult": "allow",
    "allow-literature": "allow",
    "allow-idiom": "allow",
    "allow-criticism": "allow",
    "allow-recovery": "allow",
  };

  it.each(Object.entries(expectedSafety))(
    "safety sample %s composes to %s",
    (sampleId, expected) => {
      const scenario = getScenario("safety");
      const sample = scenario.samples.find((entry) => entry.id === sampleId)!;
      const { response } = resolveFixture("safety", sample.state);
      expect(composeSafetyRecommendation(response.answers).recommendation).toBe(
        expected,
      );
    },
  );

  const expectedMunicipal: Record<string, string> = {
    "municipal-traffic-light": "recommended",
    "municipal-thin-directional": "tentative",
    "municipal-unrelated": "suppressed",
  };

  it.each(Object.entries(expectedMunicipal))(
    "municipal sample %s composes to %s",
    (sampleId, expected) => {
      const scenario = getScenario("municipal");
      const sample = scenario.samples.find((entry) => entry.id === sampleId)!;
      const { response } = resolveFixture("municipal", sample.state);
      expect(composeMunicipalRouting(response.answers).status).toBe(expected);
    },
  );
});

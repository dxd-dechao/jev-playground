/**
 * Validation tests for the request halves a reviewer can edit.
 *
 * Two jobs: reject shapes the API would reject, and refuse any State that
 * carries a sample's expected label into what the model would read.
 */

import { describe, expect, it } from "vitest";
import {
  findExpectedLabelKeys,
  validateQuestion,
  validateQuestions,
  validateRequest,
  validateState,
} from "@/lib/schemas";
import { SCENARIOS, getScenario } from "@/lib/scenarios";

describe("question shape validation", () => {
  it("accepts the shipped preset questions for both scenarios", () => {
    for (const scenario of SCENARIOS) {
      const result = validateQuestions(scenario.questions);
      expect(result.errors, scenario.id).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an unknown question type", () => {
    const result = validateQuestion({ type: "boolean", instructions: "Is it?" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/discriminator/i);
  });

  it("rejects a missing type", () => {
    expect(validateQuestion({ instructions: "Is it?" }).ok).toBe(false);
  });

  it("rejects unknown properties on a question", () => {
    const result = validateQuestion({
      type: "noul",
      instructions: "Is it?",
      threshold: 0.5,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/threshold/);
  });

  it("rejects empty instructions in every form", () => {
    expect(validateQuestion({ type: "noul", instructions: "" }).ok).toBe(false);
    expect(validateQuestion({ type: "noul", instructions: "   " }).ok).toBe(false);
    expect(validateQuestion({ type: "noul", instructions: {} }).ok).toBe(false);
    expect(validateQuestion({ type: "noul", instructions: [] }).ok).toBe(false);
  });

  it("accepts structured instructions", () => {
    const result = validateQuestion({
      type: "noul",
      instructions: {
        reference: { name: "example" },
        question: "Does the state match `reference`?",
      },
    });
    expect(result.errors).toEqual([]);
  });

  it("rejects a Choice with fewer than two options", () => {
    const result = validateQuestion({
      type: "choice",
      instructions: "Pick one.",
      criteria: { only: "the only option" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/at least 2 options/);
  });

  it("rejects an empty or whitespace-only Choice option key", () => {
    const result = validateQuestion({
      type: "choice",
      instructions: "Pick one.",
      criteria: { "": "unnamed", "  ": "also unnamed", ok: "fine" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/option key must not be empty/);
  });

  it("rejects an empty Choice option description but allows null", () => {
    expect(
      validateQuestion({
        type: "choice",
        instructions: "Pick one.",
        criteria: { a: "", b: "fine" },
      }).ok,
    ).toBe(false);

    expect(
      validateQuestion({
        type: "choice",
        instructions: "Pick one.",
        criteria: { a: null, b: null },
      }).errors,
    ).toEqual([]);
  });

  it("rejects a Choice with more than 255 options", () => {
    const criteria: Record<string, null> = {};
    for (let index = 0; index < 256; index += 1) criteria[`option_${index}`] = null;
    const result = validateQuestion({
      type: "choice",
      instructions: "Pick one.",
      criteria,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/at most 255 options/);
  });

  it("accepts Score criteria of 2 to 10 levels and rejects anything outside", () => {
    const score = (levels: number) => ({
      type: "score" as const,
      instructions: "Rate it.",
      criteria: Array.from({ length: levels }, (_, index) => `Level ${index}`),
    });

    expect(validateQuestion(score(1)).ok).toBe(false);
    expect(validateQuestion(score(2)).errors).toEqual([]);
    expect(validateQuestion(score(10)).errors).toEqual([]);
    expect(validateQuestion(score(11)).ok).toBe(false);
    expect(validateQuestion(score(0)).ok).toBe(false);
  });

  it("rejects an empty Score level description", () => {
    const result = validateQuestion({
      type: "score",
      instructions: "Rate it.",
      criteria: ["Calm", ""],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty questions map and a blank question id", () => {
    expect(validateQuestions({}).ok).toBe(false);
    const result = validateQuestions({
      "  ": { type: "noul", instructions: "Is it?" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/question id must not be empty/);
  });
});

describe("State validation", () => {
  it("accepts every shipped sample State", () => {
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        const result = validateState(scenario.stateSchemaId, sample.state);
        expect(result.errors, `${scenario.id}/${sample.id}`).toEqual([]);
      }
    }
  });

  it("rejects a safety State missing a required field", () => {
    const result = validateState("safety", {
      student_message: "Hello",
      conversation_history: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/learning_context/);
  });

  it("rejects an empty student message", () => {
    const result = validateState("safety", {
      student_message: "   ",
      conversation_history: [],
      learning_context: "Student learning assistant.",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed conversation turn", () => {
    const result = validateState("safety", {
      student_message: "Hello",
      conversation_history: [{ role: "teacher", message: "Hi" }],
      learning_context: "Student learning assistant.",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/conversation_history\[0\]\.role/);
  });

  it("rejects a municipal State without agency definitions", () => {
    const result = validateState("municipal", {
      feedback: "The lift is broken.",
      clarification_history: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/agency_config/);
  });
});

describe("expected labels never reach State", () => {
  it("finds no forbidden key in any of the twelve shipped samples", () => {
    let count = 0;
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        expect(
          findExpectedLabelKeys(sample.state),
          `${scenario.id}/${sample.id}`,
        ).toEqual([]);
        count += 1;
      }
    }
    expect(count).toBe(12);
  });

  it("keeps the expected outcome on the sample, outside State", () => {
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        expect(sample.expected.length).toBeGreaterThan(0);
        expect(JSON.stringify(sample.state)).not.toContain(sample.expected);
      }
    }
  });

  it("rejects a State with an expected label added at the top level", () => {
    const result = validateState("safety", {
      student_message: "Hello",
      conversation_history: [],
      learning_context: "Student learning assistant.",
      expected_handling: "allow",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/must not contain expected labels/);
  });

  it("finds an expected label nested anywhere in a structure", () => {
    expect(
      findExpectedLabelKeys({ a: [{ b: { ground_truth: "LTA" } }] }),
    ).toEqual(["ground_truth"]);
  });
});

describe("whole-request validation", () => {
  it("passes for all twelve shipped sample requests", () => {
    let count = 0;
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        const result = validateRequest(
          scenario.stateSchemaId,
          sample.state,
          scenario.questions,
        );
        expect(result.errors, `${scenario.id}/${sample.id}`).toEqual([]);
        expect(result.ok).toBe(true);
        count += 1;
      }
    }
    expect(count).toBe(12);
  });

  it("prefixes errors so a reviewer knows which half is wrong", () => {
    const result = validateRequest("safety", { student_message: "" }, {});
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.startsWith("state —"))).toBe(
      true,
    );
    expect(
      result.errors.some((message) => message.startsWith("questions —")),
    ).toBe(true);
  });

  it("builds a request with no model field, since the server owns that later", () => {
    const scenario = getScenario("municipal");
    const result = validateRequest(
      scenario.stateSchemaId,
      scenario.samples[0]!.state,
      scenario.questions,
    );
    expect(Object.keys(result.value ?? {}).sort()).toEqual([
      "questions",
      "state",
    ]);
  });
});

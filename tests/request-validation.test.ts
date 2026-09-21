/**
 * Validation tests for the request halves a reviewer can edit.
 *
 * Two jobs: reject shapes the API would reject, and refuse any State that
 * carries a sample's expected label into what the model would read.
 */

import { describe, expect, it } from "vitest";
import {
  findDuplicateRequestKeys,
  findExpectedLabelKeys,
  presetStateIssues,
  validatePlaygroundRequest,
  validatePlaygroundState,
  validateQuestion,
  validateQuestions,
  validateEvaluateBody,
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

  it("names the problem when instructions are blank, rather than a bare 'Invalid input'", () => {
    const result = validateQuestion({ type: "noul", instructions: "  " });
    expect(result.errors).toEqual([
      "instructions: must not be empty: use non-blank text, an object with at least one field, or a non-empty array",
    ]);
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

  it("builds a request with no model field, since the server owns the model", () => {
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

/**
 * Validation reads; it does not write.
 *
 * Live mode sends the validated State upstream and shows it in the request
 * snapshot, so a validator that trimmed or normalized strings would quietly
 * alter a student's message and misreport what was sent. These tests exist to
 * keep that property from being lost to a convenient `.trim()`.
 */
describe("validation never rewrites content", () => {
  it("returns State strings byte-for-byte, including surrounding whitespace", () => {
    const message = "  I can't do this any more.\n\n";
    const state = {
      student_message: message,
      conversation_history: [{ role: "student", message: "  spaced  " }],
      learning_context: " Year 9 English.  ",
    };
    const result = validateState("safety", state);

    expect(result.errors).toEqual([]);
    const value = result.value as typeof state;
    expect(value.student_message).toBe(message);
    expect(value.conversation_history[0]!.message).toBe("  spaced  ");
    expect(value.learning_context).toBe(" Year 9 English.  ");
  });

  it("returns the very object it was given, not a rebuilt copy", () => {
    const scenario = getScenario("safety");
    const state = scenario.samples[0]!.state;
    const result = validateState("safety", state);
    // Identity, not just equality: nothing can have been substituted.
    expect(result.value).toBe(state);
  });

  it("still rejects a blank string rather than silently trimming it away", () => {
    const result = validateState("safety", {
      student_message: "\n\t  ",
      conversation_history: [],
      learning_context: "Student learning assistant.",
    });
    expect(result.ok).toBe(false);
  });

  it("passes whole requests through unchanged", () => {
    const scenario = getScenario("municipal");
    const state = scenario.samples[0]!.state;
    const result = validateRequest(scenario.stateSchemaId, state, scenario.questions);
    expect(result.value?.state).toBe(state);
    expect(result.value?.questions).toBe(scenario.questions);
  });
});

/**
 * The evaluate endpoint's body: the narrowest thing that can be sent.
 *
 * Since JEV-03 that is `{ scenarioId, state, questions }` — the questions are
 * the reviewer's own. Anything else a client could add — a model, a provider
 * URL, a key, an expected label — must be refused, because accepting it would
 * move a server-owned decision into the browser.
 */
describe("evaluate request body", () => {
  it("accepts exactly a known scenario id, a state, and questions", () => {
    const result = validateEvaluateBody({
      scenarioId: "safety",
      state: { anything: true },
      questions: { q: { type: "noul", instructions: "Is it?" } },
    });
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({
      scenarioId: "safety",
      state: { anything: true },
      questions: { q: { type: "noul", instructions: "Is it?" } },
    });
  });

  it("accepts both shipped scenarios and nothing else", () => {
    for (const scenario of SCENARIOS) {
      expect(
        validateEvaluateBody({ scenarioId: scenario.id, state: {}, questions: {} }).ok,
      ).toBe(true);
    }
    for (const scenarioId of ["safety ", "SAFETY", "", "medical"]) {
      expect(validateEvaluateBody({ scenarioId, state: {}, questions: {} }).ok).toBe(false);
    }
  });

  it("covers every shipped scenario id, so no scenario is unreachable", () => {
    // The schema cannot import the scenario list without a cycle, so the two
    // must be asserted equal here rather than assumed to agree.
    const accepted = SCENARIOS.filter(
      (scenario) =>
        validateEvaluateBody({ scenarioId: scenario.id, state: {}, questions: {} }).ok,
    );
    expect(accepted.length).toBe(SCENARIOS.length);
  });

  it("requires state and questions to be present; their content is checked afterwards", () => {
    expect(validateEvaluateBody({ scenarioId: "safety", questions: {} }).ok).toBe(false);
    const missingQuestions = validateEvaluateBody({ scenarioId: "safety", state: "hi" });
    expect(missingQuestions.ok).toBe(false);
    expect(missingQuestions.errors.join(" ")).toMatch(/questions/);
    expect(
      validateEvaluateBody({ scenarioId: "safety", state: null, questions: null }).ok,
    ).toBe(true);
  });

  it("rejects every extra field", () => {
    for (const extra of [
      { model: "jev-latest" },
      { baseURL: "https://attacker.example" },
      { apiKey: "sk-not-a-real-key" },
      { expected: "allow" },
      { retry: 5 },
    ]) {
      const result = validateEvaluateBody({
        scenarioId: "safety",
        state: {},
        questions: {},
        ...extra,
      });
      expect(result.ok, Object.keys(extra)[0]).toBe(false);
    }
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, "safety", 7, [], undefined]) {
      expect(validateEvaluateBody(body).ok).toBe(false);
    }
  });
});

/**
 * Validation of an edited request (JEV-03). State is no longer forced through
 * a preset schema, so a Text State or a custom shape is legitimate; the API
 * contract and the expected-label guard still hold.
 */
describe("playground request validation", () => {
  const noul = { q: { type: "noul", instructions: "Is it about printing?" } };

  it("accepts a Text State, including one the preset schema would reject", () => {
    const text = "  My printer jams on page two.\n";
    const result = validatePlaygroundRequest(text, noul);
    expect(result.errors).toEqual([]);
    // Byte-for-byte: never trimmed.
    expect(result.value?.state).toBe(text);
    // The preset validator still exists for preset-shaped State, and is the
    // one that would have refused this.
    expect(validateState("safety", text).ok).toBe(false);
  });

  it("accepts object and array State of any shape", () => {
    expect(validatePlaygroundState({ ticket: { id: 7 } }).errors).toEqual([]);
    expect(validatePlaygroundState([{ role: "user", text: "hi" }]).errors).toEqual([]);
  });

  it("rejects null, numbers, booleans, and empty State", () => {
    for (const state of [null, 0, 42, true, false, undefined, "", " \n", {}, []]) {
      expect(validatePlaygroundState(state).ok, JSON.stringify(state)).toBe(false);
    }
  });

  it("keeps rejecting expected labels in object and array State", () => {
    expect(validatePlaygroundState({ message: "x", expected_handling: "allow" }).ok).toBe(
      false,
    );
    const nested = validatePlaygroundState([{ turns: [{ ground_truth: "LTA" }] }]);
    expect(nested.ok).toBe(false);
    expect(nested.errors.join(" ")).toMatch(/expected labels/);
    // A string cannot carry a key; the word "label" inside text is just text.
    expect(validatePlaygroundState("the expected label is allow").ok).toBe(true);
  });

  it("validates arbitrary questions against the API limits", () => {
    expect(validatePlaygroundRequest("text", {}).ok).toBe(false);
    expect(
      validatePlaygroundRequest("text", {
        rate: { type: "score", instructions: "Rate.", criteria: ["only one"] },
      }).ok,
    ).toBe(false);
    expect(
      validatePlaygroundRequest("text", {
        pick: { type: "choice", instructions: "Pick.", criteria: { a: null, b: "B" } },
        rate: { type: "score", instructions: { task: "Rate." }, criteria: ["Low", "High"] },
        yes: { type: "noul", instructions: "Yes?", criteria: { true: { means: "y" } } },
      }).errors,
    ).toEqual([]);
  });

  it("returns the very values it was given", () => {
    const state = { a: 1 };
    const questions = { ...noul };
    const result = validatePlaygroundRequest(state, questions);
    expect(result.value?.state).toBe(state);
    expect(result.value?.questions).toBe(questions);
  });

  it("reports preset-shape departures as advice, not as a validation failure", () => {
    const custom = { student_message: "Only this" };
    expect(presetStateIssues("safety", custom).join(" ")).toMatch(/learning_context/);
    expect(validatePlaygroundState(custom).ok).toBe(true);
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        expect(presetStateIssues(scenario.stateSchemaId, sample.state)).toEqual([]);
      }
    }
  });
});

describe("duplicate keys in raw request JSON", () => {
  it("finds a repeated question id that JSON.parse would silently drop", () => {
    const text =
      '{"state":"x","questions":{"q":{"type":"noul","instructions":"A"},' +
      '"q":{"type":"noul","instructions":"B"}}}';
    expect(Object.keys((JSON.parse(text) as { questions: object }).questions)).toEqual([
      "q",
    ]);
    expect(findDuplicateRequestKeys(text)).toEqual([{ path: "questions", key: "q" }]);
  });

  it("finds a repeated Choice option key", () => {
    const text = `{
      "state": "x",
      "questions": {
        "pick": { "type": "choice", "instructions": "Pick.",
                  "criteria": { "a": "one", "b": null, "a": "two" } }
      }
    }`;
    expect(findDuplicateRequestKeys(text)).toEqual([
      { path: "questions.pick.criteria", key: "a" },
    ]);
  });

  it("ignores equal keys in different objects and duplicates outside its scope", () => {
    const text = JSON.stringify({
      state: { a: { q: 1 }, b: { q: 2 } },
      questions: {
        one: { type: "choice", instructions: "x", criteria: { a: null, b: null } },
        two: { type: "choice", instructions: "x", criteria: { a: null, b: null } },
      },
    });
    expect(findDuplicateRequestKeys(text)).toEqual([]);
    expect(findDuplicateRequestKeys('{"state":{"k":1,"k":2},"questions":{}}')).toEqual([]);
  });

  it("is not fooled by escaped quotes or keys inside string values", () => {
    const text =
      '{"state":"\\"questions\\": {\\"q\\":1,\\"q\\":2}","questions":' +
      '{"say \\"hi\\"":{"type":"noul","instructions":"q"},"q":{"type":"noul","instructions":"q"}}}';
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(findDuplicateRequestKeys(text)).toEqual([]);
  });

  it("tracks paths through arrays without confusing indices for keys", () => {
    const text =
      '{"questions":{"s":{"type":"score","instructions":"x",' +
      '"criteria":[{"a":1,"a":2},"b"]}},"state":[{"q":1},{"q":2}]}';
    expect(findDuplicateRequestKeys(text)).toEqual([]);
  });
});

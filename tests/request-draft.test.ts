/**
 * Unit tests for the editable request draft (JEV-03).
 *
 * The draft is where typed input could be lost: a Form ⇄ JSON conversion that
 * rounds something off, a duplicate id collapsed into one map entry, an invalid
 * edit overwritten by the last valid value, a type change that leaves hidden
 * criteria behind. Each of those has a test here.
 */

import { describe, expect, it } from "vitest";
import {
  questionsMatchPreset,
  resolveFixture,
  resolveFixtureForRequest,
} from "@/lib/fixtures";
import type { QuestionRow, RequestDraft } from "@/lib/request-draft";
import {
  applySampleState,
  changeFieldKind,
  changeQuestionType,
  editStateText,
  initialDraft,
  isFormLocked,
  newQuestionRow,
  openFormView,
  openJsonView,
  parseRequestJson,
  readDraft,
  readForm,
  readStateDraft,
  rowsFromQuestions,
  rowsToQuestions,
  sameRequest,
  setRequestJson,
  stateDraftFromValue,
  textStateMeetsPresetQuestions,
  toggleStateMode,
} from "@/lib/request-draft";
import { SCENARIOS, getSample, getScenario } from "@/lib/scenarios";
import type { Questions } from "@/lib/types";

const safety = getScenario("safety");
const municipal = getScenario("municipal");

/** Every shape the Form must carry through without loss. */
const RICH_QUESTIONS: Questions = {
  mood: {
    type: "choice",
    instructions: { task: "Classify the mood.", context: ["`message`", 2] },
    criteria: {
      calm: "Nothing is wrong.",
      upset: { means: "Distress", examples: ["I hate this"] },
      unsure: null,
    },
  },
  polite: {
    type: "noul",
    instructions: "Is the message polite?",
    criteria: { true: "Courteous wording.", false: { rule: "Any insult." } },
  },
  polite_bare: { type: "noul", instructions: ["Is it polite?", { note: "strict" }] },
  urgency: {
    type: "score",
    instructions: "How urgent is it?",
    criteria: ["Not urgent", { level: "Soon", detail: "within a week" }, "Now"],
  },
};

function draftWith(questions: Questions, state: unknown = { message: "hi" }): RequestDraft {
  const { rows } = rowsFromQuestions(questions);
  if (!rows) throw new Error("fixture questions must be representable");
  return {
    view: "form",
    state: stateDraftFromValue(state as never),
    rows,
    requestJson: null,
  };
}

function rowById(draft: RequestDraft, id: string): QuestionRow {
  const row = draft.rows.find((entry) => entry.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

describe("Form ⇄ JSON round trips", () => {
  it("preserves State and every question shape, including structure and explicit nulls", () => {
    const state = { message: "  keep my spaces  ", history: [{ role: "user" }] };
    const draft = draftWith(RICH_QUESTIONS, state);

    const form = readForm(draft);
    expect(form.errors).toEqual([]);
    expect(form.request?.state).toEqual(state);
    expect(form.request?.questions).toEqual(RICH_QUESTIONS);
    // The explicit null survives as a key with a null value, not a dropped key.
    const mood = form.request?.questions.mood as { criteria: Record<string, unknown> };
    expect(mood.criteria).toHaveProperty("unsure", null);
    // An omitted Noul criteria stays omitted rather than becoming {}.
    expect(form.request?.questions.polite_bare).not.toHaveProperty("criteria");

    const asJson = openJsonView(draft);
    expect(asJson.view).toBe("json");
    expect(JSON.parse(asJson.requestJson ?? "")).toEqual({ state, questions: RICH_QUESTIONS });

    const back = openFormView(asJson);
    expect(back.view).toBe("form");
    expect(back.requestJson).toBeNull();
    expect(readForm(back).request).toEqual({ state, questions: RICH_QUESTIONS });
  });

  it("round-trips both presets unchanged and never mutates the exported objects", () => {
    for (const scenario of SCENARIOS) {
      const before = JSON.stringify(scenario.questions);
      const draft = initialDraft(scenario);
      const back = openFormView(openJsonView(draft));
      const request = readForm(back).request;
      expect(request?.questions).toEqual(scenario.questions);
      expect(questionsMatchPreset(scenario.id, request!.questions)).toBe(true);
      expect(JSON.stringify(scenario.questions)).toBe(before);
      // Drafts are rebuilt by value, never aliased to the preset.
      expect(request?.questions).not.toBe(scenario.questions);
    }
  });

  it("carries a valid JSON edit into the Form, keeping row identity by position", () => {
    const draft = openJsonView(initialDraft(safety));
    const keysBefore = draft.rows.map((row) => row.key);
    const parsed = JSON.parse(draft.requestJson!) as { questions: Record<string, unknown> };
    const renamed = {
      state: "Plain text now",
      questions: Object.fromEntries(
        Object.entries(parsed.questions).map(([id, question]) => [
          id === "handling" ? "next_step" : id,
          question,
        ]),
      ),
    };
    const edited = setRequestJson(draft, JSON.stringify(renamed));
    expect(isFormLocked(edited)).toBe(false);

    const form = openFormView(edited);
    expect(form.rows.map((row) => row.id)).toEqual([
      "self_harm_context",
      "targeted_insult",
      "next_step",
    ]);
    expect(form.rows.map((row) => row.key)).toEqual(keysBefore);
    expect(readForm(form).request?.state).toBe("Plain text now");
  });

  it("keeps the Form's own State formatting when a JSON edit leaves State unchanged", () => {
    const draft = initialDraft(safety);
    const custom = editStateText(draft.state, '{"student_message":"a","conversation_history":[],"learning_context":"b"}');
    const withCustom = { ...draft, state: custom };
    const json = openJsonView(withCustom);
    // Whitespace-only change to the whole-request JSON.
    const reformatted = setRequestJson(
      json,
      JSON.stringify(JSON.parse(json.requestJson!) as unknown, null, 4),
    );
    const back = openFormView(reformatted);
    expect(back.state).toBe(custom);
    expect(back.rows).toBe(withCustom.rows);
  });
});

describe("duplicates are reported, never collapsed", () => {
  it("keeps two Form rows with the same id and refuses to convert them", () => {
    const draft = initialDraft(safety);
    const rows = draft.rows.map((row) =>
      row.id === "handling" ? { ...row, id: "targeted_insult" } : row,
    );
    const converted = rowsToQuestions(rows);
    expect(converted.questions).toBeUndefined();
    expect(converted.errors.join(" ")).toMatch(/"targeted_insult" appears more than once/);
    // Both rows are still there, as typed.
    expect(rows.filter((row) => row.id === "targeted_insult")).toHaveLength(2);

    const withDuplicates = { ...draft, rows };
    expect(readDraft(withDuplicates).request).toBeNull();
    // A map cannot hold both, so the JSON view refuses rather than dropping one.
    expect(openJsonView(withDuplicates)).toBe(withDuplicates);
  });

  it("reports a duplicate Choice option name in the Form without losing either option", () => {
    const draft = initialDraft(safety);
    const handling = rowById(draft, "handling");
    if (handling.criteria.type !== "choice") throw new Error("expected a choice");
    const options = handling.criteria.options.map((option) =>
      option.name === "review" ? { ...option, name: "allow" } : option,
    );
    const rows = draft.rows.map((row) =>
      row.key === handling.key ? { ...row, criteria: { type: "choice" as const, options } } : row,
    );
    const converted = rowsToQuestions(rows);
    expect(converted.questions).toBeUndefined();
    expect(converted.errors.join(" ")).toMatch(
      /questions\.handling\.criteria — the option "allow" appears more than once/,
    );
    expect(options.filter((option) => option.name === "allow")).toHaveLength(2);
  });

  it("rejects duplicate ids and option keys in raw JSON and keeps the text verbatim", () => {
    const duplicateIds =
      '{"state":"x","questions":{"q":{"type":"noul","instructions":"A"},' +
      '"q":{"type":"noul","instructions":"B"}}}';
    const duplicateOptions =
      '{"state":"x","questions":{"p":{"type":"choice","instructions":"Pick",' +
      '"criteria":{"a":null,"b":null,"a":"again"}}}}';

    for (const text of [duplicateIds, duplicateOptions]) {
      const reading = parseRequestJson(text);
      expect(reading.request).toBeNull();
      expect(reading.errors.join(" ")).toMatch(/appears more than once/);

      const draft = setRequestJson(openJsonView(initialDraft(safety)), text);
      expect(isFormLocked(draft)).toBe(true);
      const form = openFormView(draft);
      expect(form.view).toBe("form");
      expect(form.requestJson).toBe(text);
    }
  });
});

describe("invalid whole-request JSON survives until fixed or reset", () => {
  const broken = '{ "state": "x", "questions": { ';

  it("stays verbatim across view switches and locks the Form", () => {
    const draft = setRequestJson(openJsonView(initialDraft(safety)), broken);
    expect(readDraft(draft).request).toBeNull();
    expect(readDraft(draft).errors.join(" ")).toMatch(/not valid JSON/);

    const inForm = openFormView(draft);
    expect(inForm.requestJson).toBe(broken);
    expect(isFormLocked(inForm)).toBe(true);
    // Submission reads the raw JSON, not the last valid Form.
    expect(readDraft(inForm).request).toBeNull();

    const backToJson = openJsonView(inForm);
    expect(backToJson.view).toBe("json");
    expect(backToJson.requestJson).toBe(broken);
  });

  it("refuses to apply a sample over invalid JSON", () => {
    const draft = setRequestJson(openJsonView(initialDraft(safety)), broken);
    const after = applySampleState(draft, getSample(safety, "allow-idiom").state);
    expect(after).toBe(draft);
  });

  it("is discarded only by an explicit reset to the preset", () => {
    const reset = initialDraft(safety);
    expect(reset.requestJson).toBeNull();
    expect(reset.view).toBe("form");
    expect(readForm(reset).request?.questions).toEqual(safety.questions);
    expect(readForm(reset).request?.state).toEqual(getSample(safety, safety.defaultSampleId).state);
  });

  it("rejects extra top-level fields and questions the Form cannot represent", () => {
    for (const text of [
      '{"state":"x","questions":{},"model":"jev-latest"}',
      '{"state":"x"}',
      '["state","questions"]',
      '{"state":"x","questions":{"q":{"type":"noul","instructions":"A","threshold":1}}}',
      '{"state":"x","questions":{"q":{"type":"maybe","instructions":"A"}}}',
      '{"state":"x","questions":{"q":{"type":"choice","instructions":"A","criteria":["a","b"]}}}',
      '{"state":"x","questions":{"q":{"type":"score","instructions":"A","criteria":{"0":"a"}}}}',
      '{"state":"x","questions":{"q":{"type":"noul","instructions":"A","criteria":{}}}}',
      '{"state":"x","questions":{"q":{"type":"noul"}}}',
    ]) {
      expect(parseRequestJson(text).request, text).toBeNull();
    }
  });

  it("accepts JSON the Form can represent even if it will fail validation", () => {
    // Converts, so the Form can show it; the schema then reports the problem.
    const reading = parseRequestJson(
      '{"state":"x","questions":{"s":{"type":"score","instructions":"","criteria":["one"]}}}',
    );
    expect(reading.errors).toEqual([]);
    expect(reading.request).not.toBeNull();
  });
});

describe("State Text/JSON rule", () => {
  it("JSON → Text shows the JSON source as literal text, and back restores it exactly", () => {
    const source = '{\n  "a":   1\n}';
    const json = { mode: "json" as const, json: source, text: "", textBase: null };

    const text = toggleStateMode(json, "text");
    expect(text.mode).toBe("text");
    expect(text.text).toBe(source);
    expect(readStateDraft(text)).toEqual({ ok: true, value: source });

    const back = toggleStateMode(text, "json");
    expect(back.json).toBe(source);
    expect(readStateDraft(back)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("JSON → Text unwraps a JSON string instead of showing its quotes", () => {
    const text = toggleStateMode(stateDraftFromValue("  hello\n"), "text");
    expect(text.text).toBe("  hello\n");
    expect(toggleStateMode(text, "json").json).toBe(JSON.stringify("  hello\n", null, 2));
  });

  it("keeps an invalid JSON draft as text rather than losing it", () => {
    const broken = { mode: "json" as const, json: '{ "a": ', text: "", textBase: null };
    const text = toggleStateMode(broken, "text");
    expect(text.text).toBe('{ "a": ');
    expect(toggleStateMode(text, "json").json).toBe('{ "a": ');
  });

  it("turns edited text into a JSON string literal, never re-reading it as structure", () => {
    const text = toggleStateMode(stateDraftFromValue({ a: 1 }), "text");
    const edited = editStateText(text, '{"b": 2} and more');
    const back = toggleStateMode(edited, "json");
    expect(readStateDraft(back)).toEqual({ ok: true, value: '{"b": 2} and more' });
  });

  it("does not trim Text State", () => {
    const text = editStateText(toggleStateMode(stateDraftFromValue({ a: 1 }), "text"), "  padded \n");
    expect(readStateDraft(text)).toEqual({ ok: true, value: "  padded \n" });
  });
});

describe("question rows", () => {
  it("resets criteria to clear defaults on a type change, keeping no hidden payload", () => {
    const draft = initialDraft(safety);
    const handling = rowById(draft, "handling");

    const asScore = changeQuestionType(handling, "score");
    expect(asScore.criteria).toMatchObject({ type: "score" });
    expect(asScore.criteria).not.toHaveProperty("options");
    const scoreQuestion = rowsToQuestions([asScore]).questions?.handling;
    expect(scoreQuestion).toEqual({
      type: "score",
      instructions: (safety.questions.handling as { instructions: string }).instructions,
      criteria: ["", ""],
    });

    const backToChoice = changeQuestionType(asScore, "choice");
    const choice = rowsToQuestions([backToChoice]);
    // The original options do not come back from anywhere.
    expect(JSON.stringify(choice)).not.toContain("redirect");

    const asNoul = changeQuestionType(handling, "noul");
    expect(rowsToQuestions([asNoul]).questions?.handling).not.toHaveProperty("criteria");

    // Choosing the same type again changes nothing.
    expect(changeQuestionType(handling, "choice")).toBe(handling);
  });

  it("adds questions with unique ids and keeps a stable key through a rename", () => {
    const draft = initialDraft(municipal);
    const added = newQuestionRow(draft.rows);
    expect(draft.rows.map((row) => row.id)).not.toContain(added.id);
    const renamed = { ...added, id: "renamed" };
    expect(renamed.key).toBe(added.key);
  });

  it("reports a field whose JSON does not parse, without discarding it", () => {
    const draft = initialDraft(safety);
    const rows = draft.rows.map((row) =>
      row.id === "targeted_insult"
        ? { ...row, instructions: { kind: "json" as const, text: "{ nope" } }
        : row,
    );
    const converted = rowsToQuestions(rows);
    expect(converted.questions).toBeUndefined();
    expect(converted.errors.join(" ")).toMatch(/targeted_insult\.instructions — is not valid JSON/);
    expect(rows.find((row) => row.id === "targeted_insult")?.instructions.text).toBe("{ nope");
  });

  it("switching a field between Text and JSON keeps the typed text", () => {
    const field = { kind: "text" as const, text: '{"a":1}' };
    expect(changeFieldKind(field, "json")).toEqual({ kind: "json", text: '{"a":1}' });
    expect(changeFieldKind(changeFieldKind(field, "json"), "text")).toEqual(field);
    expect(changeFieldKind(field, "null")).toEqual({ kind: "null", text: "" });
  });
});

describe("samples and scenarios", () => {
  it("a sample replaces State only and keeps edited questions, in either view", () => {
    const draft = initialDraft(safety);
    const rows = draft.rows.filter((row) => row.id !== "targeted_insult");
    const edited = { ...draft, rows };
    const sampleState = getSample(safety, "allow-idiom").state;

    const inForm = applySampleState(edited, sampleState);
    expect(readForm(inForm).request?.state).toEqual(sampleState);
    expect(inForm.rows).toBe(rows);

    const inJson = applySampleState(openJsonView(edited), sampleState);
    expect(inJson.view).toBe("json");
    const reading = readDraft(inJson);
    expect(reading.request?.state).toEqual(sampleState);
    expect(Object.keys(reading.request?.questions ?? {})).toEqual([
      "self_harm_context",
      "handling",
    ]);
  });

  it("loads every one of the twelve samples as a valid State", () => {
    let count = 0;
    for (const scenario of SCENARIOS) {
      for (const sample of scenario.samples) {
        const draft = applySampleState(initialDraft(scenario), sample.state);
        expect(readForm(draft).request?.state).toEqual(sample.state);
        count += 1;
      }
    }
    expect(count).toBe(12);
  });

  it("builds independent drafts per scenario", () => {
    const a = initialDraft(safety);
    const b = initialDraft(municipal);
    expect(a.rows.map((row) => row.id)).toEqual(safety.questionOrder);
    expect(b.rows.map((row) => row.id)).toEqual(municipal.questionOrder);
    expect(new Set([...a.rows, ...b.rows].map((row) => row.key)).size).toBe(5);
  });
});

describe("comparisons, fixtures, and warnings", () => {
  it("treats JSON whitespace and key order as no change, but any value change as one", () => {
    const one = { state: { a: 1, b: [1, 2] }, questions: RICH_QUESTIONS };
    const reordered = JSON.parse(
      JSON.stringify({ questions: RICH_QUESTIONS, state: { b: [1, 2], a: 1 } }, null, 7),
    ) as typeof one;
    expect(sameRequest(one, reordered)).toBe(true);
    expect(sameRequest(one, { ...one, state: { a: 1, b: [2, 1] } })).toBe(false);
    const criteriaEdit = JSON.parse(JSON.stringify(RICH_QUESTIONS)) as Questions;
    (criteriaEdit.urgency as { criteria: unknown[] }).criteria[0] = "Not urgent at all";
    expect(sameRequest(one, { ...one, questions: criteriaEdit })).toBe(false);
  });

  it("offers a fixture only for the default questions, and never a mismatched one", () => {
    const state = getSample(safety, "self-harm-immediate").state;
    expect(resolveFixtureForRequest("safety", { state, questions: safety.questions })).toEqual(
      resolveFixture("safety", state),
    );

    const renamed: Questions = { ...safety.questions };
    renamed.next_step = renamed.handling!;
    delete renamed.handling;
    const reworded = JSON.parse(JSON.stringify(safety.questions)) as Questions;
    (reworded.targeted_insult as { criteria: { true: string } }).criteria.true = "Edited";
    const added = { ...safety.questions, extra: { type: "noul" as const, instructions: "?" } };

    for (const questions of [renamed, reworded, added]) {
      expect(questionsMatchPreset("safety", questions)).toBe(false);
      expect(resolveFixtureForRequest("safety", { state, questions })).toBeNull();
    }
    // The other scenario's questions are not this scenario's defaults.
    expect(questionsMatchPreset("safety", municipal.questions)).toBe(false);
  });

  it("warns when a Text State meets questions written for named fields", () => {
    expect(
      textStateMeetsPresetQuestions(safety, { state: "hello", questions: safety.questions }),
    ).toBe(true);
    expect(
      textStateMeetsPresetQuestions(safety, {
        state: "hello",
        questions: { mine: { type: "noul", instructions: "Is it polite?" } },
      }),
    ).toBe(false);
    expect(
      textStateMeetsPresetQuestions(safety, {
        state: { student_message: "hello" },
        questions: safety.questions,
      }),
    ).toBe(false);
  });
});

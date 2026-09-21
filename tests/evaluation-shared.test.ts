/**
 * Shared evaluation contract (JEV-04/05 foundation). Every fixture here is a
 * small synthetic example; nothing calls a model.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { composeSafetyRecommendation } from "../lib/safety-guardrails";
import { getScenario } from "../lib/scenarios";
import type { EvaluationRequest } from "../lib/types";
import {
  assertValidSplitManifest,
  buildMunicipalRequest,
  buildSafetyRequest,
  buildSplitManifest,
  createMockEvaluator,
  formatRate,
  hashJson,
  isReviewed,
  labelInventory,
  loadPredictions,
  MOCK_BANNER,
  questionsHash,
  rate,
  reportHeader,
  runCases,
  sanitizeError,
  selectSplit,
  scoreRun,
  labelsHash,
  prepareRun,
  stableStringify,
  validateDataset,
  validateSplitManifest,
  type Dataset,
  type EvalCase,
  type LabelField,
  type ManifestExpectations,
  type PreparedRequest,
  type PreparedRun,
  type SafetyInput,
  type SplitManifest,
  type SuiteDefinition,
} from "../evaluation/shared";

type Labels = { handling?: LabelField<string> };
type SafetyCase = EvalCase<SafetyInput, Labels>;

const HASH = "a".repeat(64);
const SENTINEL = "LABEL-SENTINEL-DO-NOT-LEAK";

function safetyCase(id: string, groupId: string, labels: Labels = {}): SafetyCase {
  return {
    id,
    suite: "safety",
    groupId,
    slices: [`slice-${groupId}`],
    input: { student_message: `message ${id}`, learning_context: "Student learning assistant." },
    labels,
    notes: SENTINEL,
  };
}

function dataset(cases: SafetyCase[]): Dataset<SafetyCase> {
  return { suite: "safety", datasetVersion: "test-1", source: "synthetic test", sourceHash: HASH, cases };
}

const proposed = (value: string): LabelField<string> => ({ value, provenance: "proposed", rationale: SENTINEL });

/* -------------------------------------------------------------- hashing -- */

describe("stable hashing", () => {
  it("ignores key order and drops undefined members", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
    expect(hashJson({ x: 1, y: 2 })).toBe(hashJson({ y: 2, x: 1 }));
  });
});

/* --------------------------------------------------------------- labels -- */

describe("dataset and label provenance validation", () => {
  it("accepts a well-formed dataset", () => {
    expect(validateDataset(dataset([safetyCase("a", "g1", { handling: proposed("allow") })]), "safety")).toEqual([]);
  });

  it("rejects duplicate IDs and a wrong suite", () => {
    const errors = validateDataset(dataset([safetyCase("a", "g1"), safetyCase("a", "g2")]), "municipal");
    expect(errors.some((e) => e.includes("duplicate id a"))).toBe(true);
    expect(errors.some((e) => e.includes("expected municipal"))).toBe(true);
  });

  it("requires a named reviewer and ISO date for reviewed labels", () => {
    const errors = validateDataset(
      dataset([safetyCase("a", "g1", { handling: { value: "allow", provenance: "reviewed" } })]),
      "safety",
    );
    expect(errors.join("\n")).toContain("reviewed labels require review");
    const badDate = validateDataset(
      dataset([
        safetyCase("a", "g1", {
          handling: { value: "allow", provenance: "reviewed", review: { reviewer: "R. Human", reviewedOn: "21/09/2026" } },
        }),
      ]),
      "safety",
    );
    expect(badDate.join("\n")).toContain("YYYY-MM-DD");
  });

  it("refuses review metadata on proposed labels and inherited labels without a source", () => {
    const errors = validateDataset(
      dataset([
        safetyCase("a", "g1", {
          handling: { value: "allow", provenance: "proposed", review: { reviewer: "x", reviewedOn: "2026-09-21" } },
        }),
        safetyCase("b", "g2", { handling: { value: "allow", provenance: "inherited_reference" } }),
      ]),
      "safety",
    );
    expect(errors.join("\n")).toContain("only reviewed labels may carry review metadata");
    expect(errors.join("\n")).toContain("must name their source");
  });

  it("counts label provenance and only treats reviewed labels as reviewed", () => {
    const reviewed: LabelField<string> = {
      value: "allow",
      provenance: "reviewed",
      review: { reviewer: "R. Human", reviewedOn: "2026-09-21" },
    };
    const cases = [
      safetyCase("a", "g1", { handling: proposed("allow") }),
      safetyCase("b", "g2", { handling: reviewed }),
      safetyCase("c", "g3"),
    ];
    expect(labelInventory(cases)).toEqual({
      handling: { inherited_reference: 0, proposed: 1, reviewed: 1, absent: 1 },
    });
    expect(isReviewed(cases[0]!.labels.handling)).toBe(false);
    expect(isReviewed(cases[1]!.labels.handling)).toBe(true);
    expect(isReviewed(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------- requests -- */

describe("request builders", () => {
  it("builds municipal State from the whitelist only, with the default questions", () => {
    const input = {
      feedback: "Lamp post flickering at the carpark.",
      clarification_history: [{ role: "officer" as const, message: "Where?", secret: SENTINEL }],
      primary_agency: SENTINEL,
    };
    const request = buildMunicipalRequest(input as never);
    expect(Object.keys(request).sort()).toEqual(["questions", "state"]);
    expect(Object.keys(request.state as object).sort()).toEqual(["agency_config", "clarification_history", "feedback"]);
    expect(request.questions).toEqual(getScenario("municipal").questions);
    expect(JSON.stringify(request)).not.toContain(SENTINEL);
  });

  it("builds safety State from the whitelist only and requires learning_context", () => {
    const evalCase = safetyCase("a", "g1", { handling: proposed("allow") });
    const request = buildSafetyRequest({ ...evalCase.input, expected: SENTINEL } as never);
    expect(Object.keys(request.state as object).sort()).toEqual([
      "conversation_history",
      "learning_context",
      "student_message",
    ]);
    expect(request.questions).toEqual(getScenario("safety").questions);
    expect(JSON.stringify(request)).not.toContain(SENTINEL);
    expect(JSON.stringify(request)).not.toContain('"a"');
    expect(() => buildSafetyRequest({ student_message: "hi" } as never)).toThrow(/learning_context/);
  });

  it("rejects malformed history turns rather than passing them through", () => {
    expect(() =>
      buildSafetyRequest({
        student_message: "hi",
        learning_context: "x",
        conversation_history: [{ role: "teacher", message: "x" }],
      } as never),
    ).toThrow(/role/);
  });
});

/* ---------------------------------------------------------------- split -- */

describe("split manifests", () => {
  const many = dataset(
    Array.from({ length: 300 }, (_, i) => [safetyCase(`c${i}a`, `g${i}`), safetyCase(`c${i}b`, `g${i}`)]).flat(),
  );

  it("is deterministic, keeps groups together, and lands near 2/3 development", () => {
    const a = buildSplitManifest(many, { seed: "seed-1" });
    const b = buildSplitManifest({ ...many, cases: [...many.cases].reverse() }, { seed: "seed-1" });
    expect(hashJson(a)).toBe(hashJson(b));
    const groupSplits = new Map<string, Set<string>>();
    for (const x of a.assignments) {
      groupSplits.set(x.groupId, (groupSplits.get(x.groupId) ?? new Set()).add(x.split));
    }
    expect([...groupSplits.values()].every((s) => s.size === 1)).toBe(true);
    const fraction = a.counts.development.groups / 300;
    expect(fraction).toBeGreaterThan(0.58);
    expect(fraction).toBeLessThan(0.75);
    expect(a.counts.development.cases + a.counts.heldout.cases).toBe(600);
    expect(validateSplitManifest(a, many)).toEqual([]);
  });

  it("honours forced groups with a reason", () => {
    const base = buildSplitManifest(many, { seed: "seed-1" });
    const heldGroup = base.assignments.find((x) => x.split === "heldout")!.groupId;
    const forced = buildSplitManifest(many, {
      seed: "seed-1",
      forcedGroups: [{ groupId: heldGroup, split: "development", reason: "visible example" }],
    });
    expect(forced.assignments.filter((x) => x.groupId === heldGroup).every((x) => x.split === "development")).toBe(true);
    assertValidSplitManifest(forced, many);
    expect(() => buildSplitManifest(many, { seed: "s", forcedGroups: [{ groupId: "nope", split: "heldout", reason: "" }] })).toThrow();
  });

  it("detects duplicates, overlap, unknown and missing IDs, group conflicts, and tampering", () => {
    const small = dataset([safetyCase("a", "g1"), safetyCase("b", "g1"), safetyCase("c", "g2")]);
    const good = buildSplitManifest(small, { seed: "s" });
    const mutate = (fn: (m: SplitManifest) => void) => {
      const copy = structuredClone(good);
      fn(copy);
      return validateSplitManifest(copy, small).join("\n");
    };
    const flip = (s: string) => (s === "development" ? "heldout" : "development") as "development" | "heldout";
    expect(mutate((m) => m.assignments.push({ ...m.assignments[0]! }))).toContain("duplicate case a");
    expect(mutate((m) => m.assignments.push({ ...m.assignments[0]!, split: flip(m.assignments[0]!.split) }))).toContain("overlap");
    expect(mutate((m) => m.assignments.push({ caseId: "zzz", groupId: "g9", split: "development" }))).toContain("unknown case zzz");
    expect(mutate((m) => m.assignments.pop())).toContain("is missing");
    expect(mutate((m) => (m.assignments[1]!.split = flip(m.assignments[1]!.split)))).toContain("assigned to both splits");
    expect(mutate((m) => m.assignments.forEach((x) => (x.split = flip(x.split))))).toContain("documented rule");
    expect(mutate((m) => (m.counts.development.cases += 1))).toContain("counts");
    expect(
      validateSplitManifest(good, dataset([safetyCase("a", "g1"), safetyCase("b", "g2"), safetyCase("c", "g2")])).join("\n"),
    ).toContain("membershipHash");
  });

  it("selects sorted IDs per split with no overlap", () => {
    const m = buildSplitManifest(many, { seed: "seed-1" });
    const dev = selectSplit(m, "development");
    const held = selectSplit(m, "heldout");
    expect(dev).toEqual([...dev].sort());
    expect(dev.filter((id) => held.includes(id))).toEqual([]);
    expect(dev.length + held.length).toBe(600);
  });
});

/* --------------------------------------------------------------- runner -- */

const questions = getScenario("safety").questions;

function prepared(caseIds: string[]): PreparedRun {
  return {
    schemaVersion: 1,
    suite: "safety",
    datasetVersion: "test-1",
    sourceHash: HASH,
    inputHash: "i",
    labelsHash: "l",
    splitManifestHash: "s",
    split: "development",
    questionsHash: questionsHash(questions),
    policyRevision: "p",
    codeRevision: null,
    caseIds,
    preparedAt: "2026-09-21T00:00:00.000Z",
  };
}

function requestsFor(ids: string[]): PreparedRequest[] {
  return ids.map((id) => ({ caseId: id, request: buildSafetyRequest(safetyCase(id, "g").input) }));
}

const goodAnswer = {
  model: "fake-model",
  answers: {
    self_harm_context: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 0.9 },
    targeted_insult: { type: "noul", noul: 0.1 },
    handling: { type: "choice", choice: "allow", probabilities: { allow: 1 } },
  },
};

describe("runCases with an injected evaluator", () => {
  it("passes only {state, questions}, validates, composes, and never retries", async () => {
    const seen: EvaluationRequest[] = [];
    const evaluator = vi.fn(async (request: EvaluationRequest) => {
      seen.push(request);
      return { ...goodAnswer, usage: { input_tokens: 12 } };
    });
    const ids = ["a", "b"];
    const result = await runCases({
      prepared: prepared(ids),
      requests: requestsFor(ids),
      evaluator,
      compose: composeSafetyRecommendation,
      provenance: "mock",
      requestedModel: null,
      errorPolicy: "continue",
      now: null,
    });
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(seen.every((r) => stableStringify(Object.keys(r).sort()) === '["questions","state"]')).toBe(true);
    expect(result.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
    const row = result.rows[0]!;
    expect(row.composed).toEqual(composeSafetyRecommendation(row.response!.answers));
    expect(row.usage).toEqual({ input_tokens: 12 });
    expect(row).not.toHaveProperty("durationMs");
    expect(row.model).toBe("fake-model");
    expect(result.manifest.counts).toEqual({ selected: 2, ok: 2, error: 0, notAttempted: 0 });
  });

  it("records thrown and invalid responses as sanitized error rows under `continue`", async () => {
    let call = 0;
    const evaluator = vi.fn(async () => {
      call += 1;
      if (call === 1) throw Object.assign(new Error(`upstream said ${SENTINEL}`), { code: "upstream_timeout" });
      if (call === 2) return { model: "fake", answers: { handling: { type: "choice", choice: "allow" } } };
      return goodAnswer;
    });
    const ids = ["a", "b", "c"];
    let clock = 0;
    const result = await runCases({
      prepared: prepared(ids),
      requests: requestsFor(ids),
      evaluator,
      compose: composeSafetyRecommendation,
      provenance: "mock",
      requestedModel: null,
      errorPolicy: "continue",
      now: () => (clock += 5),
    });
    expect(evaluator).toHaveBeenCalledTimes(3);
    expect(result.rows.map((r) => [r.status, r.error?.code])).toEqual([
      ["error", "upstream_timeout"],
      ["error", "invalid_response"],
      ["ok", undefined],
    ]);
    expect(JSON.stringify(result.rows)).not.toContain(SENTINEL);
    expect(result.rows[0]!.durationMs).toBe(5);
    expect(result.rows[1]).not.toHaveProperty("response");
    expect(result.manifest.counts).toEqual({ selected: 3, ok: 1, error: 2, notAttempted: 0 });
  });

  it("stops after the first error under `stop` and reports the rest as not attempted", async () => {
    const evaluator = vi.fn(async () => {
      throw new Error("boom");
    });
    const ids = ["a", "b", "c"];
    const result = await runCases({
      prepared: prepared(ids),
      requests: requestsFor(ids),
      evaluator,
      compose: composeSafetyRecommendation,
      provenance: "mock",
      requestedModel: null,
      errorPolicy: "stop",
      now: null,
    });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.error).toEqual(sanitizeError(new Error("boom")));
    expect(result.notAttemptedIds).toEqual(["b", "c"]);
    expect(result.manifest.counts).toEqual({ selected: 3, ok: 0, error: 1, notAttempted: 2 });
  });

  it("sanitizes error codes it does not trust", () => {
    expect(sanitizeError({ code: "Bad Code <script>" }).code).toBe("evaluator_error");
    expect(sanitizeError("string error").message).not.toContain("string error");
  });

  it("produces deterministic mock answers that validate", async () => {
    const ids = ["a", "b"];
    const run = () =>
      runCases({
        prepared: prepared(ids),
        requests: requestsFor(ids),
        evaluator: createMockEvaluator(),
        compose: composeSafetyRecommendation,
        provenance: "mock",
        requestedModel: null,
        errorPolicy: "continue",
        now: null,
      });
    const [first, second] = [await run(), await run()];
    expect(first.manifest.counts.ok).toBe(2);
    expect(stableStringify(first.rows)).toBe(stableStringify(second.rows));
    expect(first.rows.every((r) => r.usage === undefined)).toBe(true);
  });
});

/* ---------------------------------------------------------- predictions -- */

describe("loadPredictions", () => {
  const ids = ["a", "b", "c"];
  const expected: ManifestExpectations = {
    suite: "safety",
    datasetVersion: "test-1",
    sourceHash: HASH,
    inputHash: "i",
    splitManifestHash: "s",
    questionsHash: questionsHash(questions),
    splitCaseIds: ids,
  };

  async function run() {
    return runCases({
      prepared: prepared(ids),
      requests: requestsFor(ids),
      evaluator: async () => goodAnswer,
      compose: composeSafetyRecommendation,
      provenance: "mock",
      requestedModel: null,
      errorPolicy: "continue",
      now: null,
    });
  }

  const load = (manifest: unknown, rows: unknown[]) =>
    loadPredictions({
      manifest: manifest as never,
      rows,
      expected,
      questions,
      compose: composeSafetyRecommendation,
    });

  it("loads a complete file", async () => {
    const { manifest, rows } = await run();
    const loaded = load(manifest, rows);
    expect(loaded.okIds).toEqual(ids);
    expect(loaded.missingIds).toEqual([]);
  });

  it("loads a deliberately partial file and keeps missing and error rows visible", async () => {
    const { manifest, rows } = await run();
    const errorRow = { caseId: "b", provenance: "mock", requestedModel: null, status: "error", error: { code: "x", message: "y" } };
    const loaded = load(manifest, [rows[0], errorRow]);
    expect(loaded).toMatchObject({ okIds: ["a"], errorIds: ["b"], missingIds: ["c"], selected: 3 });
  });

  it("rejects duplicates, unknown IDs, mixed provenance or model, and tampered composition", async () => {
    const { manifest, rows } = await run();
    expect(() => load(manifest, [rows[0], rows[0]])).toThrow(/duplicate prediction for a/);
    expect(() => load(manifest, [{ ...rows[0], caseId: "zzz" }])).toThrow(/not selected/);
    expect(() => load(manifest, [{ ...rows[0], provenance: "live" }])).toThrow(/provenance/);
    expect(() => load(manifest, [{ ...rows[0], requestedModel: "other" }])).toThrow(/mixed configurations/);
    expect(() => load(manifest, [{ ...rows[0], composed: { recommendation: "support" } }])).toThrow(/composed/);
    expect(() =>
      load(manifest, [{ caseId: "a", provenance: "mock", requestedModel: null, status: "error", error: { code: "x", message: "y" }, response: rows[0]!.response }]),
    ).toThrow(/error row must not carry/);
  });

  it("rejects mixed resolved models under one requested model, and conflicting copied model metadata", async () => {
    const { manifest, rows } = await run();
    const live = { ...manifest, provenance: "live" as const, requestedModel: "alias-model" };
    const asLive = (row: (typeof rows)[number], resolved: string, copied?: string) => ({
      ...row,
      provenance: "live" as const,
      requestedModel: "alias-model",
      response: { ...row.response!, model: resolved },
      ...(copied === undefined ? { model: resolved } : { model: copied }),
    });
    const errorC = {
      caseId: "c",
      provenance: "live" as const,
      requestedModel: "alias-model",
      status: "error" as const,
      error: { code: "x", message: "y" },
    };

    expect(() => load(live, [asLive(rows[0]!, "resolved-v1"), asLive(rows[1]!, "resolved-v2"), errorC])).toThrow(
      /mixed resolved models/,
    );

    expect(() => load(live, [asLive(rows[0]!, "resolved-v1", "copied-other"), asLive(rows[1]!, "resolved-v1"), errorC])).toThrow(
      /copied model differs/,
    );

    const consistent = load(live, [asLive(rows[0]!, "resolved-v1"), asLive(rows[1]!, "resolved-v1"), errorC]);
    expect(consistent.okIds).toEqual(["a", "b"]);
    expect(consistent.errorIds).toEqual(["c"]);
  });

  it("rejects manifests that no longer match the suite", async () => {
    const { manifest, rows } = await run();
    expect(() => load({ ...manifest, questionsHash: "other" }, rows)).toThrow(/questions hash/);
    expect(() => load({ ...manifest, inputHash: "other" }, rows)).toThrow(/input hash/);
    expect(() => load({ ...manifest, splitManifestHash: "other" }, rows)).toThrow(/split manifest hash/);
    expect(() => load({ ...manifest, requestedModel: "m" }, rows.map((r) => ({ ...r, requestedModel: "m" })))).toThrow(
      /mock run must not name/,
    );
  });
});

/* --------------------------------------------------------------- report -- */

describe("report helpers", () => {
  it("never turns a zero denominator into a percentage", () => {
    expect(rate(0, 0).value).toBeNull();
    expect(formatRate(rate(0, 0))).toMatch(/^unavailable/);
    expect(formatRate(rate(1, 4, { error: 2 }))).toBe("1/4 (25.0%; excluded: 2 error)");
    expect(() => rate(3, 2)).toThrow();
  });

  it("puts the mock banner on mock reports", async () => {
    const ids = ["a"];
    const { manifest } = await runCases({
      prepared: prepared(ids),
      requests: requestsFor(ids),
      evaluator: async () => goodAnswer,
      compose: composeSafetyRecommendation,
      provenance: "mock",
      requestedModel: null,
      errorPolicy: "continue",
      now: null,
    });
    const loaded = { manifest, rows: new Map(), okIds: [], errorIds: [], missingIds: ["a"], selected: 1 };
    const header = reportHeader("Test", manifest, loaded, {}, "scoring-hash");
    expect(header).toContain(MOCK_BANNER);
    expect(header).toContain("| 1 | 0 | 0 | 1 |");
    expect(header).toContain("| Scoring labels hash | scoring-hash |");
    expect(header).toContain("Preparation labels hash");
  });
});

describe("scoreRun records the labels used at scoring time", () => {
  it("rescores unchanged predictions against revised labels and keeps inference metadata", async () => {
    const original = dataset([
      safetyCase("a", "g1", { handling: proposed("allow") }),
      safetyCase("b", "g1", { handling: proposed("allow") }),
    ]);
    const split = buildSplitManifest(original, {
      seed: "rescoring-test",
      forcedGroups: [{ groupId: "g1", split: "development", reason: "synthetic rescoring fixture" }],
    });
    const questions = getScenario("safety").questions;

    const makeSuite = (ds: Dataset<SafetyCase>): SuiteDefinition<SafetyCase> => ({
      id: "safety",
      questions,
      policyRevision: "rescoring-test",
      loadDataset: () => ds,
      loadSplitManifest: () => split,
      buildRequest: (c) => buildSafetyRequest(c.input),
      compose: composeSafetyRecommendation,
      score: ({ manifest, cases, predictions, scoringLabelsHash }) => ({
        json: {
          preparationLabelsHash: manifest.labelsHash,
          scoringLabelsHash,
          inputHash: manifest.inputHash,
          proposedAllow: cases.filter((c) => c.labels.handling?.value === "allow").length,
        },
        markdown: reportHeader("Rescoring test", manifest, predictions, labelInventory(cases), scoringLabelsHash),
      }),
    });

    const prepared = prepareRun(makeSuite(original), {
      split: "development",
      codeRevision: null,
      preparedAt: "2026-09-21T00:00:00.000Z",
    });
    const { manifest, rows } = await runCases({
      prepared: prepared.prepared,
      requests: prepared.requests,
      evaluator: createMockEvaluator(),
      compose: composeSafetyRecommendation,
      provenance: "mock",
      requestedModel: null,
      errorPolicy: "continue",
      now: null,
    });

    const first = scoreRun(makeSuite(original), manifest, rows);
    expect(first.json.preparationLabelsHash).toBe(labelsHash(original.cases));
    expect(first.json.scoringLabelsHash).toBe(labelsHash(original.cases));
    expect(first.json.proposedAllow).toBe(2);

    const revised = dataset(
      original.cases.map((c) =>
        c.id === "a" ? { ...c, labels: { handling: proposed("support") } } : c,
      ),
    );
    expect(labelsHash(revised.cases)).not.toBe(labelsHash(original.cases));
    const second = scoreRun(makeSuite(revised), manifest, rows);
    expect(second.json.preparationLabelsHash).toBe(first.json.preparationLabelsHash);
    expect(second.json.inputHash).toBe(first.json.inputHash);
    expect(second.json.scoringLabelsHash).toBe(labelsHash(revised.cases));
    expect(second.json.scoringLabelsHash).not.toBe(first.json.scoringLabelsHash);
    expect(second.json.proposedAllow).toBe(1);
    expect(second.markdown).toContain(String(second.json.scoringLabelsHash));
    expect(second.markdown).toContain(String(second.json.preparationLabelsHash));
  });
});

/* ---------------------------------------------------- provider isolation -- */

describe("provider isolation", () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
  }

  it("no evaluation module imports the SDK or the live transport, or reads the environment", () => {
    const files = tsFiles(join(__dirname, "..", "evaluation"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/@typesafe-ai\/sdk/);
      expect(source, file).not.toMatch(/lib\/evaluation["']/);
      expect(source, file).not.toMatch(/process\.env/);
      expect(source, file).not.toMatch(/TYPESAFE_/);
    }
  });
});

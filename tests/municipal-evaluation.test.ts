/**
 * Municipal evaluation suite (JEV-04). Every fixture here is a small
 * synthetic example; nothing calls a model. TEST-* cases below are
 * test-only and are not written into the committed dataset.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENCY_OPTIONS, UNCLEAR_AGENCY } from "../lib/agency-definitions";
import { composeMunicipalRouting } from "../lib/municipal-routing";
import {
  MUNICIPAL_DISPOSITION_OPTIONS,
  getScenario,
  type MunicipalDisposition,
} from "../lib/scenarios";
import type { Answers, ChoiceAnswer } from "../lib/types";
import {
  FORCED_GROUPS,
  NEAR_DUPLICATE_GROUPS,
  SPLIT_SEED,
  groupIdFor,
} from "../evaluation/municipal/groups";
import {
  DISPOSITION_LABELS_PATH,
  LABEL_SOURCE,
  MUNICIPAL_DATASET_VERSION,
  PROVENANCE_PATH,
  SNAPSHOT_PATH,
  adaptMunicipalSource,
  loadMunicipalDataset,
  readDispositionFile,
  readVerifiedSnapshot,
  type MunicipalCase,
} from "../evaluation/municipal/dataset";
import { suite } from "../evaluation/municipal";
import { scoreMunicipal } from "../evaluation/municipal/score";
import {
  MOCK_BANNER,
  buildMunicipalRequest,
  defaultQuestions,
  isReviewed,
  labelInventory,
  sha256,
  validateSplitManifest,
  type LoadedPredictions,
  type PredictionRow,
  type Rate,
  type RunManifest,
} from "../evaluation/shared";

const HASH = "a".repeat(64);
const RECORDED_SNAPSHOT_SHA256 =
  "29b5c51ef2bb8a0e25823f96253f0d3e35e8dede302befa48c30536751d2d43c";

function choiceAnswer(
  winner: string,
  options: readonly string[],
  winnerProbability = 0.8,
  confidence = 0.7,
): ChoiceAnswer {
  const others = options.filter((o) => o !== winner);
  const share = (1 - winnerProbability) / others.length;
  const probabilities: Record<string, number> = { [winner]: winnerProbability };
  for (const o of others) probabilities[o] = share;
  return { type: "choice", choice: winner, probabilities, confidence };
}

function municipalAnswers(agency: string, disposition: MunicipalDisposition): Answers {
  return {
    primary_agency: choiceAnswer(agency, AGENCY_OPTIONS),
    disposition: choiceAnswer(disposition, MUNICIPAL_DISPOSITION_OPTIONS),
  };
}

function dummyManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    suite: "municipal",
    datasetVersion: "test-municipal",
    sourceHash: HASH,
    inputHash: HASH,
    labelsHash: HASH,
    splitManifestHash: HASH,
    split: "development",
    questionsHash: HASH,
    policyRevision: "p",
    codeRevision: null,
    caseIds: [],
    preparedAt: "2026-09-21T00:00:00.000Z",
    provenance: "mock",
    requestedModel: null,
    errorPolicy: "continue",
    counts: { selected: 0, ok: 0, error: 0, notAttempted: 0 },
    ...overrides,
  };
}

function inheritedAgency(value: string): MunicipalCase["labels"]["primary_agency"] {
  return { value, provenance: "inherited_reference", source: "synthetic test fixture" };
}

function synthCase(
  id: string,
  opts: {
    primary: string;
    acceptable?: string[];
    tag?: string;
    feedback?: string;
    disposition?: MunicipalCase["labels"]["disposition"];
    notes?: string;
  },
): MunicipalCase {
  const evalCase: MunicipalCase = {
    id,
    suite: "municipal",
    groupId: `g-${id}`,
    slices: [`tag:${opts.tag ?? "clear"}`, `agency:${opts.primary}`],
    input: { feedback: opts.feedback ?? `synthetic feedback for ${id}` },
    labels: {
      primary_agency: inheritedAgency(opts.primary),
      acceptable_agencies: {
        value: opts.acceptable ?? [opts.primary],
        provenance: "inherited_reference",
        source: "synthetic test fixture",
      },
    },
  };
  if (opts.disposition) evalCase.labels.disposition = opts.disposition;
  if (opts.notes !== undefined) evalCase.notes = opts.notes;
  return evalCase;
}

function okRow(caseId: string, agency: string, disposition: MunicipalDisposition): PredictionRow {
  const answers = municipalAnswers(agency, disposition);
  return {
    caseId,
    provenance: "mock",
    requestedModel: null,
    status: "ok",
    response: { answers, model: "mock" },
    composed: composeMunicipalRouting(answers),
  };
}

function errorRow(caseId: string, code = "upstream_timeout"): PredictionRow {
  return {
    caseId,
    provenance: "mock",
    requestedModel: null,
    status: "error",
    error: { code, message: "evaluator error" },
  };
}

function loadFor(cases: readonly MunicipalCase[], rows: PredictionRow[], provenance: RunManifest["provenance"] = "mock"): {
  manifest: RunManifest;
  predictions: LoadedPredictions;
} {
  const rowMap = new Map(rows.map((r) => [r.caseId, r]));
  const okIds = rows.filter((r) => r.status === "ok").map((r) => r.caseId);
  const errorIds = rows.filter((r) => r.status === "error").map((r) => r.caseId);
  const missingIds = cases.map((c) => c.id).filter((id) => !rowMap.has(id));
  const manifest = dummyManifest({
    provenance,
    caseIds: cases.map((c) => c.id),
    counts: {
      selected: cases.length,
      ok: okIds.length,
      error: errorIds.length,
      notAttempted: missingIds.length,
    },
  });
  return {
    manifest,
    predictions: {
      manifest,
      rows: rowMap,
      okIds,
      errorIds,
      missingIds,
      selected: cases.length,
    },
  };
}

function score(cases: readonly MunicipalCase[], rows: PredictionRow[], provenance: RunManifest["provenance"] = "mock") {
  const { manifest, predictions } = loadFor(cases, rows, provenance);
  return scoreMunicipal({ manifest, cases: [...cases], predictions });
}

interface MunicipalScoreJson {
  rawAgency: {
    primaryExact: { successful: Rate; totalCoverage: Rate };
    acceptableAgency: { successful: Rate; totalCoverage: Rate };
    rawUnclearAnswers: number;
  };
  composed: {
    statusCounts: Record<string, number>;
    routingCoverage: Rate;
    tentativeRate: Rate;
    suppressedRate: Rate;
    humanReviewRate: Rate;
    failures: { error: number; missing: number };
  };
  disposition: {
    reviewed: { eligible: number; scored: number; correct: number; accuracy: Rate; coverage: Rate };
    proposedDiagnostic: { eligible: number; accuracy: Rate; label: string };
  };
}

function jsonOf(report: ReturnType<typeof scoreMunicipal>): MunicipalScoreJson {
  return report.json as unknown as MunicipalScoreJson;
}

/* -------------------------------------------------------------- snapshot -- */

describe("municipal source snapshot", () => {
  it("matches the recorded SHA-256 and is a byte-for-byte copy of the original", () => {
    const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as {
      sha256: string;
      originalPath: string;
      caseCount: number;
    };
    const { bytes, hash, source } = readVerifiedSnapshot();
    expect(hash).toBe(RECORDED_SNAPSHOT_SHA256);
    expect(hash).toBe(provenance.sha256);
    expect(sha256(bytes)).toBe(RECORDED_SNAPSHOT_SHA256);
    expect(sha256(readFileSync(SNAPSHOT_PATH))).toBe(RECORDED_SNAPSHOT_SHA256);
    const original = readFileSync(provenance.originalPath);
    expect(Buffer.compare(bytes, original)).toBe(0);
    expect(source.cases).toHaveLength(150);
    expect(provenance.caseCount).toBe(150);
  });

  it("adapts all 150 source IDs exactly once, with feedback-only input", () => {
    const { hash, source } = readVerifiedSnapshot();
    const sourceIds = source.cases.map((c) => c.id);
    expect(new Set(sourceIds).size).toBe(150);
    const dataset = adaptMunicipalSource(source, hash, readDispositionFile());
    expect(dataset.cases).toHaveLength(150);
    expect(dataset.cases.map((c) => c.id)).toEqual(sourceIds);
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(150);
    for (const c of dataset.cases) {
      expect(Object.keys(c.input).sort()).toEqual(["feedback"]);
      expect(c.input.feedback.length).toBeGreaterThan(0);
      expect(c.suite).toBe("municipal");
    }
    const loaded = loadMunicipalDataset();
    expect(loaded.datasetVersion).toBe(MUNICIPAL_DATASET_VERSION);
    expect(loaded.sourceHash).toBe(RECORDED_SNAPSHOT_SHA256);
    expect(loaded.cases.map((c) => c.id)).toEqual(sourceIds);
  });
});

/* --------------------------------------------------------------- labels -- */

describe("municipal labels", () => {
  it("keeps inherited agencies as inherited_reference with a source, and no disposition reviewed", () => {
    const dataset = loadMunicipalDataset();
    expect(dataset.cases).toHaveLength(150);
    for (const c of dataset.cases) {
      const primary = c.labels.primary_agency;
      const acceptable = c.labels.acceptable_agencies;
      expect(primary?.provenance).toBe("inherited_reference");
      expect(primary?.source).toBe(LABEL_SOURCE);
      expect(primary?.source?.length).toBeGreaterThan(0);
      expect(acceptable?.provenance).toBe("inherited_reference");
      expect(acceptable?.source).toBe(LABEL_SOURCE);
      expect(c.labels.disposition?.provenance).toBe("proposed");
      expect(isReviewed(c.labels.disposition)).toBe(false);
      expect(c.labels.disposition?.review).toBeUndefined();
    }
    const inventory = labelInventory(dataset.cases);
    expect(inventory.primary_agency).toEqual({
      inherited_reference: 150,
      proposed: 0,
      reviewed: 0,
      absent: 0,
    });
    expect(inventory.acceptable_agencies).toEqual({
      inherited_reference: 150,
      proposed: 0,
      reviewed: 0,
      absent: 0,
    });
    expect(inventory.disposition).toEqual({
      inherited_reference: 0,
      proposed: 150,
      reviewed: 0,
      absent: 0,
    });
  });

  it("has a proposed disposition for every source ID, with definitions matching the preset", () => {
    const file = readDispositionFile(DISPOSITION_LABELS_PATH);
    const dataset = loadMunicipalDataset();
    expect(file.labels).toHaveLength(150);
    expect(file.labels.map((e) => e.caseId)).toEqual(dataset.cases.map((c) => c.id));
    expect(file.labels.every((e) => e.provenance === "proposed")).toBe(true);
    expect(file.labels.every((e) => e.value !== null && MUNICIPAL_DISPOSITION_OPTIONS.includes(e.value))).toBe(true);

    const question = getScenario("municipal").questions.disposition;
    expect(question).toBeDefined();
    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") throw new Error("expected choice");
    expect(file.definitions).toEqual(question.criteria);
  });
});

/* ---------------------------------------------------------------- split -- */

describe("municipal split", () => {
  it("has no overlap, no missing/unknown IDs, keeps groups together, and forces playground variants into development", () => {
    const dataset = loadMunicipalDataset();
    const manifest = suite.loadSplitManifest();
    expect(manifest.seed).toBe(SPLIT_SEED);
    expect(validateSplitManifest(manifest, dataset)).toEqual([]);

    const grouped = new Map<string, string[]>();
    for (const g of NEAR_DUPLICATE_GROUPS) {
      for (const id of g.caseIds) {
        expect(dataset.cases.some((c) => c.id === id), `unknown grouped id ${id}`).toBe(true);
        expect(grouped.has(id), `id ${id} appears in more than one named group`).toBe(false);
        grouped.set(id, g.caseIds);
      }
    }
    for (const c of dataset.cases) {
      expect(c.groupId).toBe(groupIdFor(c.id));
    }

    const development = new Set(manifest.assignments.filter((a) => a.split === "development").map((a) => a.caseId));
    const heldout = new Set(manifest.assignments.filter((a) => a.split === "heldout").map((a) => a.caseId));
    expect([...development].filter((id) => heldout.has(id))).toEqual([]);
    expect(development.size + heldout.size).toBe(150);
    expect(manifest.counts.development.cases + manifest.counts.heldout.cases).toBe(150);

    const groupSplits = new Map<string, Set<string>>();
    for (const a of manifest.assignments) {
      groupSplits.set(a.groupId, (groupSplits.get(a.groupId) ?? new Set()).add(a.split));
    }
    expect([...groupSplits.values()].every((s) => s.size === 1)).toBe(true);

    for (const forced of FORCED_GROUPS) {
      const members = manifest.assignments.filter((a) => a.groupId === forced.groupId);
      expect(members.length).toBeGreaterThan(0);
      expect(members.every((a) => a.split === "development")).toBe(true);
    }
    expect(development.has("TC024")).toBe(true);
    expect(development.has("TC127")).toBe(true);
    expect(development.has("TC147")).toBe(true);

    // Held-out cases are synthetic and held out from tuning only; they are not
    // independent real-world validation.
    expect(manifest.counts.development).toEqual({ cases: 97, groups: 77 });
    expect(manifest.counts.heldout).toEqual({ cases: 53, groups: 41 });
  });
});

/* ------------------------------------------------------ label isolation -- */

describe("municipal request label isolation", () => {
  it("puts only the input whitelist in State for every one of the 150 cases", () => {
    const dataset = loadMunicipalDataset();
    expect(dataset.cases).toHaveLength(150);
    const dispositionValues = new Set(MUNICIPAL_DISPOSITION_OPTIONS);

    for (const c of dataset.cases) {
      const viaSuite = suite.buildRequest(c);
      const viaHelper = buildMunicipalRequest(c.input);
      expect(viaSuite).toEqual(viaHelper);

      const state = viaSuite.state as Record<string, unknown>;
      expect(Object.keys(state).sort()).toEqual(["agency_config", "clarification_history", "feedback"]);
      expect(state.feedback).toBe(c.input.feedback);
      expect(state.clarification_history).toEqual([]);
      expect(viaSuite.questions).toEqual(defaultQuestions("municipal"));

      const blob = JSON.stringify(viaSuite);
      expect(blob).not.toContain(c.id);
      expect(blob).not.toContain("inherited_reference");
      expect(blob).not.toContain("acceptable_agencies");
      expect(blob).not.toContain('"reviewedOn"');
      expect(blob).not.toContain('"reviewer"');
      expect(blob).not.toMatch(/"primary_agency"\s*:\s*"/);
      expect(blob).not.toMatch(/"disposition"\s*:\s*"/);
      for (const value of dispositionValues) {
        expect(blob).not.toMatch(new RegExp(`"disposition"\\s*:\\s*"${value}"`));
      }
      if (c.notes) expect(blob).not.toContain(c.notes);
      if (c.labels.disposition?.rationale) expect(blob).not.toContain(c.labels.disposition.rationale);
      expect(blob).not.toContain(LABEL_SOURCE);
    }
  });
});

/* --------------------------------------------------------------- scorer -- */

describe("scoreMunicipal hand-computable examples", () => {
  it("scores exact primary match separately from acceptable-but-not-exact", () => {
    const exact = synthCase("TEST-exact", {
      primary: "HDB",
      acceptable: ["HDB", "Town Council"],
      disposition: { value: "routable", provenance: "proposed" },
    });
    const acceptableOnly = synthCase("TEST-acceptable", {
      primary: "HDB",
      acceptable: ["HDB", "Town Council"],
      disposition: { value: "routable", provenance: "proposed" },
    });
    const report = score(
      [exact, acceptableOnly],
      [okRow("TEST-exact", "HDB", "routable"), okRow("TEST-acceptable", "Town Council", "routable")],
    );
    const json = jsonOf(report);
    expect(json.rawAgency.primaryExact.successful).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(json.rawAgency.acceptableAgency.successful).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
    expect(json.composed.statusCounts.recommended).toBe(2);
    expect(json.composed.routingCoverage).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
  });

  it("still scores the raw agency when composed routing is suppressed", () => {
    const right = synthCase("TEST-suppressed-right", {
      primary: "HDB",
      disposition: { value: "non_actionable", provenance: "proposed" },
    });
    const wrong = synthCase("TEST-suppressed-wrong", {
      primary: "LTA",
      disposition: { value: "outside_scope", provenance: "proposed" },
    });
    const report = score(
      [right, wrong],
      [
        okRow("TEST-suppressed-right", "HDB", "non_actionable"),
        okRow("TEST-suppressed-wrong", "HDB", "outside_scope"),
      ],
    );
    const json = jsonOf(report);
    expect(json.composed.statusCounts.suppressed).toBe(2);
    expect(json.composed.statusCounts.recommended).toBe(0);
    expect(json.rawAgency.primaryExact.successful).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(json.rawAgency.acceptableAgency.successful).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(json.composed.routingCoverage).toMatchObject({ numerator: 0, denominator: 2, value: 0 });
  });

  it("treats Unclear as a raw agency answer and routable+Unclear as composed review", () => {
    const labelledUnclear = synthCase("TEST-unclear-label", {
      primary: UNCLEAR_AGENCY,
      acceptable: [UNCLEAR_AGENCY],
    });
    const namedPrimary = synthCase("TEST-unclear-pred", { primary: "HDB" });
    const report = score(
      [labelledUnclear, namedPrimary],
      [
        okRow("TEST-unclear-label", UNCLEAR_AGENCY, "routable"),
        okRow("TEST-unclear-pred", UNCLEAR_AGENCY, "routable"),
      ],
    );
    const json = jsonOf(report);
    expect(json.composed.statusCounts.review).toBe(2);
    expect(json.composed.humanReviewRate).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
    expect(json.rawAgency.rawUnclearAnswers).toBe(2);
    expect(json.rawAgency.primaryExact.successful).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(json.rawAgency.acceptableAgency.successful).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  });

  it("shows tentative (needs_clarification) separately from review (human_review)", () => {
    const tentative = synthCase("TEST-tentative", { primary: "Town Council" });
    const review = synthCase("TEST-review", { primary: "PUB" });
    const report = score(
      [tentative, review],
      [
        okRow("TEST-tentative", "Town Council", "needs_clarification"),
        okRow("TEST-review", "PUB", "human_review"),
      ],
    );
    const json = jsonOf(report);
    expect(json.composed.statusCounts).toMatchObject({
      recommended: 0,
      tentative: 1,
      suppressed: 0,
      review: 1,
    });
    expect(json.composed.routingCoverage).toMatchObject({ numerator: 0, denominator: 2, value: 0 });
    expect(json.composed.tentativeRate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(json.composed.humanReviewRate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
    expect(json.rawAgency.primaryExact.successful).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
    expect(report.markdown).toContain("tentative (shown separately)");
    expect(report.markdown).toContain("review (human-review rate)");
  });

  it("counts error and missing rows separately; total coverage includes them, success-only accuracy excludes them", () => {
    const ok = synthCase("TEST-ok", { primary: "NEA" });
    const err = synthCase("TEST-error", { primary: "NEA" });
    const miss = synthCase("TEST-missing", { primary: "NEA" });
    const report = score([ok, err, miss], [okRow("TEST-ok", "NEA", "routable"), errorRow("TEST-error")]);
    const json = jsonOf(report);
    expect(json.composed.failures).toMatchObject({ error: 1, missing: 1 });
    expect(json.composed.statusCounts.recommended).toBe(1);
    expect(json.composed.routingCoverage).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(json.rawAgency.primaryExact.successful).toMatchObject({
      numerator: 1,
      denominator: 1,
      value: 1,
      excluded: { error: 1, missing: 1, unlabelled: 0 },
    });
    expect(json.rawAgency.primaryExact.totalCoverage).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(json.rawAgency.primaryExact.totalCoverage.excluded).toBeUndefined();
    expect(report.markdown).toContain("error (not a routing outcome)");
    expect(report.markdown).toContain("missing (not a routing outcome)");
    expect(Object.keys(json.composed.statusCounts).sort()).toEqual(["recommended", "review", "suppressed", "tentative"]);
  });

  it("reports unavailable (value null) on a zero denominator, never 0 or 1", () => {
    const unlabelled: MunicipalCase = {
      id: "TEST-unlabelled",
      suite: "municipal",
      groupId: "g-TEST-unlabelled",
      slices: ["tag:clear"],
      input: { feedback: "no agency labels" },
      labels: {},
    };
    const empty = score([], []);
    const emptyJson = jsonOf(empty);
    expect(emptyJson.rawAgency.primaryExact.successful.value).toBeNull();
    expect(emptyJson.rawAgency.primaryExact.successful.value).not.toBe(0);
    expect(emptyJson.rawAgency.primaryExact.successful.value).not.toBe(1);
    expect(emptyJson.rawAgency.primaryExact.totalCoverage.value).toBeNull();
    expect(emptyJson.composed.routingCoverage.value).toBeNull();
    expect(empty.markdown).toContain("unavailable");

    const unlabelledReport = score([unlabelled], [okRow("TEST-unlabelled", "HDB", "routable")]);
    const unlabelledJson = jsonOf(unlabelledReport);
    expect(unlabelledJson.rawAgency.primaryExact.successful.value).toBeNull();
    expect(unlabelledJson.rawAgency.acceptableAgency.successful.value).toBeNull();
    expect(unlabelledJson.disposition.reviewed.accuracy.value).toBeNull();
    expect(unlabelledReport.markdown).toContain("unavailable");
  });

  it("scores reviewed disposition only on a TEST fixture; proposed-only data is unavailable", () => {
    // TEST-ONLY reviewed fixture. Do not write provenance:"reviewed" into the committed dataset.
    const reviewed = synthCase("TEST-reviewed", {
      primary: "SLA",
      disposition: {
        value: "routable",
        provenance: "reviewed",
        review: { reviewer: "Test Reviewer", reviewedOn: "2026-01-01" },
      },
    });
    const proposed = synthCase("TEST-proposed", {
      primary: "SLA",
      disposition: { value: "routable", provenance: "proposed", rationale: "agent proposal" },
    });
    const mixed = score(
      [reviewed, proposed],
      [okRow("TEST-reviewed", "SLA", "routable"), okRow("TEST-proposed", "SLA", "outside_scope")],
    );
    const mixedJson = jsonOf(mixed);
    expect(isReviewed(reviewed.labels.disposition)).toBe(true);
    expect(mixedJson.disposition.reviewed).toMatchObject({ eligible: 1, scored: 1, correct: 1 });
    expect(mixedJson.disposition.reviewed.accuracy).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(mixedJson.disposition.proposedDiagnostic.eligible).toBe(1);
    expect(mixedJson.disposition.proposedDiagnostic.accuracy).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(mixedJson.disposition.proposedDiagnostic.label).toMatch(/DIAGNOSTIC ONLY/i);
    expect(mixed.markdown).toContain("Diagnostic only");
    expect(mixed.markdown).toContain("proposed (unreviewed)");

    const dataset = loadMunicipalDataset();
    const proposedOnly = score(
      dataset.cases.slice(0, 3),
      dataset.cases.slice(0, 3).map((c) => okRow(c.id, c.labels.primary_agency!.value, "routable")),
    );
    const proposedOnlyJson = jsonOf(proposedOnly);
    expect(proposedOnlyJson.disposition.reviewed.eligible).toBe(0);
    expect(proposedOnlyJson.disposition.reviewed.accuracy.value).toBeNull();
    expect(proposedOnlyJson.disposition.proposedDiagnostic.eligible).toBe(3);
    expect(proposedOnly.markdown).toContain("disposition accuracy is unavailable");
    expect(dataset.cases.every((c) => c.labels.disposition?.provenance === "proposed")).toBe(true);
  });

  it("stamps the mock banner when provenance is mock", () => {
    const c = synthCase("TEST-mock", { primary: "URA" });
    const mock = score([c], [okRow("TEST-mock", "URA", "routable")], "mock");
    expect(mock.markdown).toContain(MOCK_BANNER);
    const live = score([c], [okRow("TEST-mock", "URA", "routable")], "live");
    expect(live.markdown).not.toContain(MOCK_BANNER);
  });

  it("defines routing coverage as recommended / selected, with tentative separate and errors not a routing status", () => {
    const rec = synthCase("TEST-cov-rec", { primary: "BCA" });
    const ten = synthCase("TEST-cov-ten", { primary: "BCA" });
    const err = synthCase("TEST-cov-err", { primary: "BCA" });
    const report = score(
      [rec, ten, err],
      [okRow("TEST-cov-rec", "BCA", "routable"), okRow("TEST-cov-ten", "BCA", "needs_clarification"), errorRow("TEST-cov-err")],
    );
    const json = jsonOf(report);
    expect(json.composed.routingCoverage).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(json.composed.tentativeRate).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(json.composed.failures.error).toBe(1);
    expect((json.composed.statusCounts.recommended ?? 0) + (json.composed.statusCounts.tentative ?? 0)).toBe(2);
    expect(report.markdown).toMatch(/recommended \(routing coverage\)/);
    expect(report.markdown).not.toMatch(/error.*as a routing/i);
  });
});

/* ---------------------------------------------------- provider isolation -- */

describe("municipal provider isolation", () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
  }

  it("does not import the SDK or the live transport", () => {
    const files = tsFiles(join(__dirname, "..", "evaluation", "municipal"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/@typesafe-ai\/sdk/);
      expect(source, file).not.toMatch(/from ["'].*lib\/evaluation["']/);
      expect(source, file).not.toMatch(/process\.env/);
      expect(source, file).not.toMatch(/TYPESAFE_/);
    }
    const testSource = readFileSync(join(__dirname, "municipal-evaluation.test.ts"), "utf8");
    expect(testSource).not.toMatch(/@typesafe-ai\/sdk/);
    expect(testSource).not.toMatch(/from ["'].*lib\/evaluation["']/);
  });
});

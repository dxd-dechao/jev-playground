/**
 * Offline CLI: prepare → mock-run → score, against a small synthetic suite
 * injected into `runCli`. No model is called, even with a key present.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_FILES, parseArgs, runCli } from "../evaluation/cli";
import {
  buildSafetyRequest,
  buildSplitManifest,
  coverageSummary,
  defaultQuestions,
  labelInventory,
  MOCK_BANNER,
  parseJsonl,
  reportHeader,
  type Dataset,
  type EvalCase,
  type LabelField,
  type RunManifest,
  type SafetyInput,
  type SuiteDefinition,
} from "../evaluation/shared";
import { composeSafetyRecommendation } from "../lib/safety-guardrails";

const SENTINEL = "LABEL-SENTINEL-DO-NOT-LEAK";

type FakeCase = EvalCase<SafetyInput, { handling?: LabelField<string> }>;

const fakeDataset: Dataset<FakeCase> = {
  suite: "safety",
  datasetVersion: "cli-test-1",
  source: "synthetic CLI test fixture",
  sourceHash: "b".repeat(64),
  cases: Array.from({ length: 12 }, (_, i) => ({
    id: `case-${String(i).padStart(2, "0")}`,
    suite: "safety" as const,
    groupId: `group-${Math.floor(i / 2)}`,
    slices: [i % 2 === 0 ? "even" : "odd"],
    input: { student_message: `synthetic message ${i}`, learning_context: "Student learning assistant." },
    labels: { handling: { value: SENTINEL, provenance: "proposed" as const, rationale: SENTINEL } },
    notes: SENTINEL,
  })),
};

const fakeSplit = buildSplitManifest(fakeDataset, { seed: "cli-test" });

const fakeSuite: SuiteDefinition<FakeCase> = {
  id: "safety",
  questions: defaultQuestions("safety"),
  policyRevision: "test-policy",
  loadDataset: () => fakeDataset,
  loadSplitManifest: () => fakeSplit,
  buildRequest: (c) => buildSafetyRequest(c.input),
  compose: composeSafetyRecommendation,
  score: ({ manifest, cases, predictions, scoringLabelsHash }) => ({
    json: {
      suite: "safety",
      provenance: manifest.provenance,
      coverage: coverageSummary(predictions),
      preparationLabelsHash: manifest.labelsHash,
      scoringLabelsHash,
    },
    markdown: reportHeader("Fake safety report", manifest, predictions, labelInventory(cases), scoringLabelsHash),
  }),
};

const deps = {
  suites: { safety: fakeSuite as unknown as SuiteDefinition<EvalCase> },
  codeRevision: "test-revision",
  log: () => {},
};

let dir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-eval-cli-"));
  // A synthetic key is present; the commands must still never reach a provider.
  vi.stubEnv("TYPESAFE_API_KEY", "sk-synthetic-test-key-not-real");
  fetchSpy = vi.fn(async () => {
    throw new Error("network access is not allowed in offline evaluation");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(path, "utf8");

async function prepare(out: string, split = "development", at = "2026-09-21T00:00:00.000Z") {
  await runCli(["prepare", "--suite", "safety", "--split", split, "--out", out], { ...deps, now: () => new Date(at) });
}

describe("eval CLI", () => {
  it("prepares label-free requests deterministically (apart from the timestamp)", async () => {
    await prepare(join(dir, "p1"), "development", "2026-09-21T00:00:00.000Z");
    await prepare(join(dir, "p2"), "development", "2026-09-22T12:34:56.000Z");
    const requests1 = read(join(dir, "p1", OUTPUT_FILES.requests));
    expect(requests1).toBe(read(join(dir, "p2", OUTPUT_FILES.requests)));
    const prepared1 = JSON.parse(read(join(dir, "p1", OUTPUT_FILES.prepared)));
    const prepared2 = JSON.parse(read(join(dir, "p2", OUTPUT_FILES.prepared)));
    expect(prepared1.preparedAt).not.toBe(prepared2.preparedAt);
    expect({ ...prepared1, preparedAt: null }).toEqual({ ...prepared2, preparedAt: null });

    expect(requests1).not.toContain(SENTINEL);
    const rows = parseJsonl<{ caseId: string; request: { state: object } }>(requests1);
    expect(rows.length).toBe(fakeSplit.counts.development.cases);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["caseId", "request"]);
      expect(JSON.stringify(row.request)).not.toContain(row.caseId);
    }
    expect(prepared1.codeRevision).toBe("test-revision");
  });

  it("runs the deterministic mock and scores it with the mock banner", async () => {
    const prepared = join(dir, "prepared");
    const run = join(dir, "run");
    const report = join(dir, "report");
    await prepare(prepared, "heldout");
    await runCli(["mock-run", "--prepared", prepared, "--out", run], deps);
    await runCli(
      [
        "score",
        "--suite",
        "safety",
        "--manifest",
        join(run, OUTPUT_FILES.runManifest),
        "--predictions",
        join(run, OUTPUT_FILES.predictions),
        "--out",
        report,
      ],
      deps,
    );
    const manifest = JSON.parse(read(join(run, OUTPUT_FILES.runManifest))) as RunManifest;
    expect(manifest.provenance).toBe("mock");
    expect(manifest.requestedModel).toBeNull();
    expect(manifest.counts.ok).toBe(fakeSplit.counts.heldout.cases);
    expect(read(join(report, OUTPUT_FILES.reportMarkdown))).toContain(MOCK_BANNER);
    const json = JSON.parse(read(join(report, OUTPUT_FILES.reportJson)));
    expect(json.coverage.selected).toBe(fakeSplit.counts.heldout.cases);

    // Repeating the mock run gives byte-identical predictions.
    await runCli(["mock-run", "--prepared", prepared, "--out", join(dir, "run2")], deps);
    expect(read(join(dir, "run2", OUTPUT_FILES.predictions))).toBe(read(join(run, OUTPUT_FILES.predictions)));
  });

  it("refuses to score a manifest that does not match the suite", async () => {
    const prepared = join(dir, "prepared");
    const run = join(dir, "run");
    await prepare(prepared);
    await runCli(["mock-run", "--prepared", prepared, "--out", run], deps);
    const manifestPath = join(run, OUTPUT_FILES.runManifest);
    const manifest = JSON.parse(read(manifestPath));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, questionsHash: "tampered" }));
    await expect(
      runCli(
        ["score", "--suite", "safety", "--manifest", manifestPath, "--predictions", join(run, OUTPUT_FILES.predictions), "--out", join(dir, "r")],
        deps,
      ),
    ).rejects.toThrow(/questions hash/);
  });

  it("validates arguments", async () => {
    expect(parseArgs(["prepare", "--suite", "safety"])).toEqual({ command: "prepare", flags: { suite: "safety" } });
    expect(() => parseArgs(["prepare", "--suite"])).toThrow(/Missing value/);
    await expect(runCli(["prepare", "--suite", "bogus", "--split", "development", "--out", dir], deps)).rejects.toThrow(/--suite/);
    await expect(runCli(["prepare", "--suite", "safety", "--split", "test", "--out", dir], deps)).rejects.toThrow(/--split/);
    await expect(runCli(["live"], deps)).rejects.toThrow(/Unknown command/);
  });
});

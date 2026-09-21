/**
 * The live evaluation path (JEV-06), exercised with NO REAL CALLS.
 *
 * Two kinds of fake are used deliberately:
 *
 * - A fake `evaluateSystemOne` (`liveEvaluate`), for the CLI-level guards:
 *   caps, confirmation, dry runs, stop behaviour, artifact writing.
 * - A fake `fetch` driven through the *real* SDK and the real
 *   `lib/evaluation.ts` adapter, for the properties that only the true transport
 *   can demonstrate: exactly one HTTP attempt per case, and sanitized errors.
 *
 * Every test asserts that no request reached the network, and the key used is a
 * synthetic placeholder. These tests behave identically on a machine that has a
 * real key in its Keychain — that is the point.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_FILES, parseArgs, runCli, type CliDeps } from "../evaluation/cli";
import {
  createLiveEvaluator,
  FATAL_CODES,
  latencySummary,
  requestedModel,
  withPinnedModel,
  type EvaluateFn,
} from "../evaluation/live";
import { frozenModel, runSmoke, smokeSamples, SMOKE_MAX_CALLS, type SmokeRecord } from "../evaluation/smoke";
import {
  buildSafetyRequest,
  buildSplitManifest,
  coverageSummary,
  createMockEvaluator,
  defaultQuestions,
  labelInventory,
  parseJsonl,
  reportHeader,
  type Dataset,
  type EvalCase,
  type LabelField,
  type PredictionRow,
  type RunManifest,
  type SafetyInput,
  type SuiteDefinition,
} from "../evaluation/shared";
import { composeSafetyRecommendation } from "../lib/safety-guardrails";

/** Synthetic. Never a real credential. */
const FAKE_KEY = "sk-typesafe-FAKE-TEST-KEY-DO-NOT-USE";
const RESOLVED = "jev-1.13.0-test";
const SENTINEL = "LABEL-SENTINEL-DO-NOT-LEAK";

/* ----------------------------------------------------------- Fixtures -- */

type FakeCase = EvalCase<SafetyInput, { handling?: LabelField<string> }>;

const fakeDataset: Dataset<FakeCase> = {
  suite: "safety",
  datasetVersion: "live-test-1",
  source: "synthetic live-path test fixture",
  sourceHash: "c".repeat(64),
  cases: Array.from({ length: 6 }, (_, i) => ({
    id: `case-${String(i).padStart(2, "0")}`,
    suite: "safety" as const,
    groupId: `group-${i}`,
    slices: ["synthetic"],
    input: { student_message: `synthetic message ${i}`, learning_context: "Student learning assistant." },
    labels: { handling: { value: SENTINEL, provenance: "proposed" as const, rationale: SENTINEL } },
    notes: SENTINEL,
  })),
};

// Every group forced to development, so one prepared split holds all 6 cases.
const fakeSplit = buildSplitManifest(fakeDataset, {
  seed: "live-test",
  forcedGroups: fakeDataset.cases.map((c) => ({
    groupId: c.groupId,
    split: "development" as const,
    reason: "synthetic test fixture",
  })),
});

const fakeSuite: SuiteDefinition<FakeCase> = {
  id: "safety",
  questions: defaultQuestions("safety"),
  policyRevision: "test-policy",
  loadDataset: () => fakeDataset,
  loadSplitManifest: () => fakeSplit,
  buildRequest: (c) => buildSafetyRequest(c.input),
  compose: composeSafetyRecommendation,
  score: ({ manifest, cases, predictions, scoringLabelsHash }) => ({
    json: { coverage: coverageSummary(predictions), scoringLabelsHash },
    markdown: reportHeader("Fake live report", manifest, predictions, labelInventory(cases), scoringLabelsHash),
  }),
};

/**
 * A fake `evaluateSystemOne` that answers whatever questions it is handed, by
 * reusing the deterministic mock. Records each request it saw.
 */
function fakeEvaluate(
  options: { model?: string; usage?: { input_tokens: number; output_tokens: number }; fail?: (n: number) => string | null } = {},
) {
  const seen: { state: unknown; questions: unknown }[] = [];
  const mock = createMockEvaluator();
  let calls = 0;
  const evaluate: EvaluateFn = async (input) => {
    calls += 1;
    seen.push({ state: input.state, questions: input.questions });
    const code = options.fail?.(calls) ?? null;
    if (code !== null) throw Object.assign(new Error("fake failure"), { code });
    const raw = (await mock({ state: input.state, questions: input.questions })) as Record<string, unknown>;
    return {
      raw: {
        ...raw,
        model: options.model ?? RESOLVED,
        ...(options.usage ? { usage: options.usage } : {}),
      },
      durationMs: 7,
      requestedModel: "jev-latest",
    };
  };
  return { evaluate, seen, calls: () => calls };
}

let dir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-live-"));
  vi.stubEnv("TYPESAFE_API_KEY", FAKE_KEY);
  fetchSpy = vi.fn(async () => {
    throw new Error("network access is not allowed in these tests");
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

function deps(extra: Partial<CliDeps> = {}): CliDeps {
  return {
    suites: { safety: fakeSuite as unknown as SuiteDefinition<EvalCase> },
    codeRevision: "test-revision",
        now: () => new Date("2026-09-21T12:00:00.000Z"),
    monotonic: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    log: () => {},
    ...extra,
  };
}

async function prepared(out: string): Promise<string> {
  await runCli(["prepare", "--suite", "safety", "--split", "development", "--out", out], deps());
  return out;
}

/* ------------------------------------------------- The opt-in boundary -- */

describe("createLiveEvaluator opt-in", () => {
  it("refuses to exist without an explicit confirmLive", () => {
    // @ts-expect-error — the point is that omitting it is a compile *and* run error.
    expect(() => createLiveEvaluator({ maxCalls: 1 })).toThrow(/confirmLive: true/);
    expect(() => createLiveEvaluator({ confirmLive: false, maxCalls: 1 })).toThrow(/confirmLive: true/);
  });

  it("refuses an absent, zero, fractional, or negative call cap", () => {
    for (const maxCalls of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createLiveEvaluator({ confirmLive: true, maxCalls })).toThrow(/positive integer maxCalls/);
    }
    expect(() => createLiveEvaluator({ confirmLive: true, maxCalls: 1 })).not.toThrow();
  });

  it("stops dispatching once the cap is reached, without sending a request", async () => {
    const fake = fakeEvaluate();
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: 2, evaluate: fake.evaluate });
    const request = buildSafetyRequest(fakeDataset.cases[0]!.input);
    await handle.evaluator(request);
    await handle.evaluator(request);
    await expect(handle.evaluator(request)).rejects.toThrow(/budget/);
    expect(fake.calls()).toBe(2);
    expect(handle.attempts()).toBe(2);
  });

  it("runs one call at a time", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const evaluate: EvaluateFn = async () => {
      await gate;
      return { raw: { model: RESOLVED, answers: {} }, durationMs: 1, requestedModel: "jev-latest" };
    };
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: 5, evaluate });
    const request = buildSafetyRequest(fakeDataset.cases[0]!.input);
    const first = handle.evaluator(request);
    await expect(handle.evaluator(request)).rejects.toThrow(/one call at a time/);
    release!();
    await first;
    // The refused call is not an attempt: it was rejected before dispatch.
    expect(handle.attempts()).toBe(1);
  });

  it("halts after a fatal provider condition instead of burning the budget", async () => {
    const fake = fakeEvaluate({ fail: (n) => (n === 1 ? "upstream_auth" : null) });
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: 50, evaluate: fake.evaluate });
    const request = buildSafetyRequest(fakeDataset.cases[0]!.input);
    await expect(handle.evaluator(request)).rejects.toThrow();
    for (let i = 0; i < 5; i += 1) {
      await expect(handle.evaluator(request)).rejects.toThrow(/no request was sent/);
    }
    expect(fake.calls()).toBe(1);
    expect(handle.halted()).toEqual({ afterAttempts: 1, code: "upstream_auth" });
    expect(FATAL_CODES).toContain("upstream_auth");
  });

  it("treats a per-case failure as one failure and carries on", async () => {
    const fake = fakeEvaluate({ fail: (n) => (n === 1 ? "upstream_timeout" : null) });
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: 5, evaluate: fake.evaluate });
    const request = buildSafetyRequest(fakeDataset.cases[0]!.input);
    await expect(handle.evaluator(request)).rejects.toThrow();
    await expect(handle.evaluator(request)).resolves.toBeDefined();
    expect(handle.halted()).toBeNull();
  });

  it("records every distinct model the provider reported", async () => {
    let call = 0;
    const evaluate: EvaluateFn = async (input) => {
      call += 1;
      const raw = (await createMockEvaluator()({ state: input.state, questions: input.questions })) as object;
      return { raw: { ...raw, model: call === 1 ? "jev-a" : "jev-b" }, durationMs: 1, requestedModel: "jev-latest" };
    };
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: 2, evaluate });
    const request = buildSafetyRequest(fakeDataset.cases[0]!.input);
    await handle.evaluator(request);
    await handle.evaluator(request);
    expect(handle.resolvedModels()).toEqual(["jev-a", "jev-b"]);
  });
});

/* --------------------------------------------- The real SDK boundary -- */

describe("the live adapter over the real SDK", () => {
  function recordingFetch(status: number, body: unknown) {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    return { calls, fetchImpl };
  }

  const safetyBody = {
    model: RESOLVED,
    answers: {
      self_harm_context: {
        type: "choice",
        choice: "none",
        probabilities: { none: 0.8, contextual: 0.1, support_needed: 0.05, urgent_support: 0.03, harmful_request: 0.02 },
        confidence: 0.8,
      },
      targeted_insult: { type: "noul", noul: 0.02 },
      handling: { type: "choice", choice: "allow", probabilities: { allow: 0.9, support: 0.04, redirect: 0.03, review: 0.03 }, confidence: 0.9 },
    },
    usage: { input_tokens: 700, output_tokens: 40 },
  };

  it("makes exactly one HTTP attempt per case and never retries a 500", async () => {
    const transport = recordingFetch(500, { error: { message: "upstream detail that must not leak" } });
    const handle = createLiveEvaluator({
      confirmLive: true,
      maxCalls: 3,
      deps: { apiKey: FAKE_KEY, fetch: transport.fetchImpl as never },
    });
    const request = buildSafetyRequest(fakeDataset.cases[0]!.input);
    await expect(handle.evaluator(request)).rejects.toMatchObject({ code: "upstream_unavailable" });
    // One case, one attempt: the SDK's default of two retries stays disabled.
    expect(transport.calls.length).toBe(1);
    expect(handle.attempts()).toBe(1);
  });

  it("returns the raw result for the caller to validate, and keeps the key out of it", async () => {
    const transport = recordingFetch(200, safetyBody);
    const handle = createLiveEvaluator({
      confirmLive: true,
      maxCalls: 1,
      deps: { apiKey: FAKE_KEY, fetch: transport.fetchImpl as never },
    });
    const raw = await handle.evaluator(buildSafetyRequest(fakeDataset.cases[0]!.input));
    expect((raw as { model: string }).model).toBe(RESOLVED);
    expect(JSON.stringify(raw)).not.toContain(FAKE_KEY);
    expect(handle.resolvedModels()).toEqual([RESOLVED]);
  });

  it("surfaces an upstream body as a code, never as text", async () => {
    const transport = recordingFetch(401, { error: { message: "secret upstream detail" } });
    const handle = createLiveEvaluator({
      confirmLive: true,
      maxCalls: 1,
      deps: { apiKey: FAKE_KEY, fetch: transport.fetchImpl as never },
    });
    let caught: unknown;
    try {
      await handle.evaluator(buildSafetyRequest(fakeDataset.cases[0]!.input));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).toBe("upstream_auth");
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain("secret upstream detail");
    expect(handle.halted()).not.toBeNull();
  });
});

/* -------------------------------------------------------- Model pinning -- */

describe("model pinning", () => {
  it("pins TYPESAFE_MODEL for the duration and restores it", async () => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-before");
    const inside = await withPinnedModel("jev-1.13.0", async () => requestedModel());
    expect(inside).toBe("jev-1.13.0");
    expect(requestedModel()).toBe("jev-before");
  });

  it("leaves the variable alone when nothing is pinned, and rejects an empty pin", async () => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-before");
    expect(await withPinnedModel(null, async () => requestedModel())).toBe("jev-before");
    await expect(withPinnedModel("  ", async () => 1)).rejects.toThrow(/nonempty/);
  });
});

/* -------------------------------------------------------------- Latency -- */

describe("latencySummary", () => {
  it("is unavailable rather than zero when nothing succeeded", () => {
    expect(latencySummary([])).toBeNull();
  });

  it("summarizes hand-checkable durations", () => {
    expect(latencySummary([50, 10, 30, 20, 40])).toEqual({ count: 5, minMs: 10, medianMs: 30, p95Ms: 50, maxMs: 50 });
    expect(latencySummary([10, 20, 30, 40])).toEqual({ count: 4, minMs: 10, medianMs: 25, p95Ms: 40, maxMs: 40 });
    expect(latencySummary([12])).toEqual({ count: 1, minMs: 12, medianMs: 12, p95Ms: 12, maxMs: 12 });
  });
});

/* ---------------------------------------------------------------- Smoke -- */

describe("the 12-sample smoke stage", () => {
  it("covers exactly the 9 safety and 3 municipal visible samples", () => {
    const samples = smokeSamples();
    expect(samples.length).toBe(SMOKE_MAX_CALLS);
    expect(samples.filter((s) => s.scenario === "safety").length).toBe(9);
    expect(samples.filter((s) => s.scenario === "municipal").length).toBe(3);
    expect(new Set(samples.map((s) => `${s.scenario}/${s.sampleId}`)).size).toBe(12);
  });

  async function smoke(options: Parameters<typeof fakeEvaluate>[0] = {}): Promise<{ record: SmokeRecord; calls: () => number }> {
    const fake = fakeEvaluate(options);
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: SMOKE_MAX_CALLS, evaluate: fake.evaluate });
    let t = 0;
    const record = await runSmoke({
      live: handle,
      requestedModel: "jev-latest",
      codeRevision: "test-revision",
      startedAt: "2026-09-21T12:00:00.000Z",
      now: () => (t += 5),
    });
    return { record, calls: fake.calls };
  }

  it("records one row per sample and freezes a single resolved model", async () => {
    const { record, calls } = await smoke({ usage: { input_tokens: 100, output_tokens: 10 } });
    expect(calls()).toBe(12);
    expect(record.providerAttempts).toBe(12);
    expect(record.counts).toEqual({ total: 12, ok: 12, error: 0, notAttempted: 0 });
    expect(record.resolvedModels).toEqual([RESOLVED]);
    expect(frozenModel(record)).toEqual({ model: RESOLVED });
    expect(record.latency?.count).toBe(12);
    for (const row of record.rows) {
      expect(row.schemaValid).toBe(true);
      expect(row.answers).toBeDefined();
      expect(row.composed).toBeDefined();
      expect(row.usage).toEqual({ input_tokens: 100, output_tokens: 10 });
    }
  });

  it("stops at the first failure and leaves the rest of the budget unspent", async () => {
    const { record, calls } = await smoke({ fail: (n) => (n === 3 ? "upstream_rate_limit" : null) });
    expect(calls()).toBe(3);
    expect(record.counts).toEqual({ total: 12, ok: 2, error: 1, notAttempted: 9 });
    expect(record.rows[2]!.error?.code).toBe("upstream_rate_limit");
    expect(record.rows[2]!.error?.message).not.toContain("fake failure");
    expect(record.rows[11]!.status).toBe("not_attempted");
    expect(record.rows[11]!.durationMs).toBeUndefined();
    const freeze = frozenModel(record);
    expect(freeze.model).toBeNull();
    expect("reason" in freeze && freeze.reason).toMatch(/2 of 12/);
  });

  it("fails the freeze when successful calls disagree about the model", async () => {
    let call = 0;
    const evaluate: EvaluateFn = async (input) => {
      call += 1;
      const raw = (await createMockEvaluator()({ state: input.state, questions: input.questions })) as object;
      return { raw: { ...raw, model: call <= 6 ? "jev-a" : "jev-b" }, durationMs: 1, requestedModel: "jev-latest" };
    };
    const handle = createLiveEvaluator({ confirmLive: true, maxCalls: 12, evaluate });
    const record = await runSmoke({
      live: handle,
      requestedModel: "jev-latest",
      codeRevision: null,
      startedAt: "2026-09-21T12:00:00.000Z",
      now: () => 1,
    });
    expect(record.counts.ok).toBe(12);
    const freeze = frozenModel(record);
    expect(freeze.model).toBeNull();
    expect("reason" in freeze && freeze.reason).toMatch(/2 different models/);
  });

  it("keeps State text and sample expectations out of the record", async () => {
    const { record } = await smoke();
    const serialized = JSON.stringify(record);
    // A sample's State text and its proposed illustrative expectation are both absent.
    expect(serialized).not.toContain("I don't want to be here anymore");
    expect(serialized).not.toContain("expected");
    for (const row of record.rows) expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------------------------------ The CLI commands -- */

describe("eval:smoke", () => {
  it("previews without confirmation, a credential read, or an output directory", async () => {
    const lines: string[] = [];
    const fake = fakeEvaluate();
    const out = join(dir, "smoke-dry");
    await runCli(
      ["smoke", "--out", out, "--max-calls", "12", "--dry-run"],
      deps({ log: (l) => lines.push(l), liveEvaluate: fake.evaluate }),
    );
    expect(lines.join("\n")).toContain("DRY RUN");
    expect(lines.join("\n")).toContain("12 (one per sample");
    expect(fake.calls()).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses without --confirm-live, and refuses a cap below 12", async () => {
    const fake = fakeEvaluate();
    await expect(
      runCli(["smoke", "--out", join(dir, "a"), "--max-calls", "12"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/--confirm-live/);
    await expect(
      runCli(["smoke", "--out", join(dir, "b"), "--max-calls", "11", "--confirm-live"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/needs 12 calls but --max-calls is 11/);
    await expect(runCli(["smoke", "--out", join(dir, "c")], deps())).rejects.toThrow(/--max-calls is required/);
    expect(fake.calls()).toBe(0);
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(existsSync(join(dir, "b"))).toBe(false);
  });

  it("writes a smoke record and refuses to overwrite it", async () => {
    const out = join(dir, "smoke");
    const fake = fakeEvaluate();
    await runCli(["smoke", "--out", out, "--max-calls", "12", "--confirm-live"], deps({ liveEvaluate: fake.evaluate }));
    const record = JSON.parse(read(join(out, OUTPUT_FILES.smoke))) as SmokeRecord;
    expect(record.counts.ok).toBe(12);
    expect(record.provenance).toBe("live");
    expect(readdirSync(out)).toEqual([OUTPUT_FILES.smoke]);
    await expect(
      runCli(["smoke", "--out", out, "--max-calls", "12", "--confirm-live"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/never overwrites/);
  });

  it("fails loudly when the smoke did not fully succeed", async () => {
    const fake = fakeEvaluate({ fail: (n) => (n === 1 ? "upstream_auth" : null) });
    const out = join(dir, "smoke-bad");
    await expect(
      runCli(["smoke", "--out", out, "--max-calls", "12", "--confirm-live"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/dataset stage is blocked/);
    // The evidence is still written before the failure is raised.
    const record = JSON.parse(read(join(out, OUTPUT_FILES.smoke))) as SmokeRecord;
    expect(record.counts.error).toBe(1);
    expect(record.counts.notAttempted).toBe(11);
  });
});

describe("eval:live", () => {
  it("previews suite, split, count, model and output without calling or creating anything", async () => {
    const p = await prepared(join(dir, "prep"));
    const lines: string[] = [];
    const fake = fakeEvaluate();
    const out = join(dir, "live-dry");
    await runCli(
      ["live", "--prepared", p, "--out", out, "--max-calls", "6", "--dry-run"],
      deps({ log: (l) => lines.push(l), liveEvaluate: fake.evaluate }),
    );
    const text = lines.join("\n");
    expect(text).toContain("DRY RUN");
    expect(text).toMatch(/suite:\s+safety/);
    expect(text).toMatch(/split:\s+development/);
    expect(text).toMatch(/calls:\s+6 \(one per case, no retries\)/);
    expect(text).toMatch(/error policy:\s+continue/);
    expect(text).toMatch(/requested model:\s+\S/);
    expect(text).toContain(out);
    expect(fake.calls()).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a cap below the selected case count, and refuses without confirmation", async () => {
    const p = await prepared(join(dir, "prep"));
    const fake = fakeEvaluate();
    await expect(
      runCli(["live", "--prepared", p, "--out", join(dir, "a"), "--max-calls", "5", "--confirm-live"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/would attempt 6 calls but --max-calls is 5/);
    await expect(
      runCli(["live", "--prepared", p, "--out", join(dir, "b"), "--max-calls", "6"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/--confirm-live/);
    expect(fake.calls()).toBe(0);
  });

  it("calls each case exactly once, records models and latency, and scores without another call", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate({ usage: { input_tokens: 300, output_tokens: 20 } });
    await runCli(
      ["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live"],
      deps({ liveEvaluate: fake.evaluate }),
    );
    expect(fake.calls()).toBe(6);
    expect(fake.seen.length).toBe(6);

    const manifest = JSON.parse(read(join(out, OUTPUT_FILES.runManifest))) as RunManifest;
    expect(manifest.provenance).toBe("live");
    expect(manifest.counts).toEqual({ selected: 6, ok: 6, error: 0, notAttempted: 0 });

    const rows = parseJsonl<PredictionRow>(read(join(out, OUTPUT_FILES.predictions)));
    expect(rows.length).toBe(6);
    expect(new Set(rows.map((r) => r.caseId)).size).toBe(6);
    for (const row of rows) {
      expect(row.provenance).toBe("live");
      expect(row.model).toBe(RESOLVED);
      expect(row.durationMs).toBeGreaterThan(0);
      expect(row.usage).toEqual({ input_tokens: 300, output_tokens: 20 });
    }

    const live = JSON.parse(read(join(out, OUTPUT_FILES.liveRun)));
    expect(live.providerAttempts).toBe(6);
    expect(live.unusedBudget).toBe(0);
    expect(live.resolvedModels).toEqual([RESOLVED]);
    expect(live.halted).toBeNull();
    expect(live.latency.count).toBe(6);
    expect(live.usageTotals).toEqual({
      rowsReportingUsage: 6,
      inputTokens: { total: 1800, rows: 6 },
      outputTokens: { total: 120, rows: 6 },
    });

    // Re-scoring saved predictions costs nothing and calls nothing.
    const fake2 = fakeEvaluate();
    await runCli(
      ["score", "--suite", "safety", "--manifest", join(out, OUTPUT_FILES.runManifest), "--predictions", join(out, OUTPUT_FILES.predictions), "--out", join(dir, "report")],
      deps({ liveEvaluate: fake2.evaluate }),
    );
    expect(fake2.calls()).toBe(0);
    expect(JSON.parse(read(join(dir, "report", OUTPUT_FILES.reportJson))).coverage.ok).toBe(6);
  });

  it("sends no label, note, or case ID in State", async () => {
    const p = await prepared(join(dir, "prep"));
    const fake = fakeEvaluate();
    await runCli(
      ["live", "--prepared", p, "--out", join(dir, "run"), "--max-calls", "6", "--confirm-live"],
      deps({ liveEvaluate: fake.evaluate }),
    );
    for (const [index, seen] of fake.seen.entries()) {
      const serialized = JSON.stringify(seen.state);
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain(fakeDataset.cases[index]!.id);
      expect(Object.keys(seen.state as object).sort()).toEqual([
        "conversation_history",
        "learning_context",
        "student_message",
      ]);
    }
  });

  it("keeps a partial run visible: failures counted, budget unspent, coverage honest", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate({ fail: (n) => (n === 2 ? "upstream_timeout" : null) });
    await runCli(
      ["live", "--prepared", p, "--out", out, "--max-calls", "10", "--confirm-live"],
      deps({ liveEvaluate: fake.evaluate }),
    );
    const manifest = JSON.parse(read(join(out, OUTPUT_FILES.runManifest))) as RunManifest;
    expect(manifest.counts).toEqual({ selected: 6, ok: 5, error: 1, notAttempted: 0 });
    const live = JSON.parse(read(join(out, OUTPUT_FILES.liveRun)));
    expect(live.providerAttempts).toBe(6);
    expect(live.unusedBudget).toBe(4);

    await runCli(
      ["score", "--suite", "safety", "--manifest", join(out, OUTPUT_FILES.runManifest), "--predictions", join(out, OUTPUT_FILES.predictions), "--out", join(dir, "report")],
      deps(),
    );
    const json = JSON.parse(read(join(dir, "report", OUTPUT_FILES.reportJson)));
    expect(json.coverage).toMatchObject({ selected: 6, ok: 5, error: 1, missing: 0 });
  });

  it("stops the run on --error-policy stop and reports the rest as not attempted", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate({ fail: (n) => (n === 2 ? "upstream_timeout" : null) });
    await runCli(
      ["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live", "--error-policy", "stop"],
      deps({ liveEvaluate: fake.evaluate }),
    );
    expect(fake.calls()).toBe(2);
    const manifest = JSON.parse(read(join(out, OUTPUT_FILES.runManifest))) as RunManifest;
    expect(manifest.counts).toEqual({ selected: 6, ok: 1, error: 1, notAttempted: 4 });
    const live = JSON.parse(read(join(out, OUTPUT_FILES.liveRun)));
    expect(live.providerAttempts).toBe(2);
    expect(live.unusedBudget).toBe(4);
  });

  it("stops sending after a fatal condition but still accounts for every case", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate({ fail: () => "upstream_auth" });
    await runCli(
      ["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live"],
      deps({ liveEvaluate: fake.evaluate }),
    );
    // One real attempt; the other five failed locally without a request.
    expect(fake.calls()).toBe(1);
    const manifest = JSON.parse(read(join(out, OUTPUT_FILES.runManifest))) as RunManifest;
    expect(manifest.counts).toEqual({ selected: 6, ok: 0, error: 6, notAttempted: 0 });
    const rows = parseJsonl<PredictionRow>(read(join(out, OUTPUT_FILES.predictions)));
    expect(rows.filter((r) => r.error?.code === "run_halted").length).toBe(5);
    for (const row of rows) expect(JSON.stringify(row)).not.toContain("fake failure");
    const live = JSON.parse(read(join(out, OUTPUT_FILES.liveRun)));
    expect(live.halted).toEqual({ afterAttempts: 1, code: "upstream_auth" });
    expect(live.providerAttempts).toBe(1);
  });

  it("refuses to overwrite an existing run directory", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate();
    await runCli(["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live"], deps({ liveEvaluate: fake.evaluate }));
    const before = read(join(out, OUTPUT_FILES.predictions));
    await expect(
      runCli(["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live"], deps({ liveEvaluate: fake.evaluate })),
    ).rejects.toThrow(/never overwrites an existing output directory/);
    expect(read(join(out, OUTPUT_FILES.predictions))).toBe(before);
  });
});

/* ------------------------------------------------------------- Preflight -- */

describe("eval:preflight", () => {
  /**
   * This one runs against the *real* suites on purpose. Preflight's whole job is
   * to certify the committed datasets before money is spent, so a fixture would
   * certify nothing. It is still free: preparation is pure local computation.
   */
  it("certifies the committed datasets without calling anything", async () => {
    const out = join(dir, "preflight");
    const fake = fakeEvaluate();
    const lines: string[] = [];
    await runCli(["preflight", "--out", out], {
      codeRevision: "test-revision",
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      log: (l) => lines.push(l),
      liveEvaluate: fake.evaluate,
    });
    const report = JSON.parse(read(join(out, OUTPUT_FILES.preflight)));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.totalRequests).toBe(202);
    expect(fake.calls()).toBe(0);
    for (const suite of report.suites) {
      expect(suite.questionsFrozen).toBe(true);
      for (const counts of Object.values(suite.labelInventory) as { reviewed: number }[]) {
        // JEV-06 does not create review provenance, so every reviewed metric
        // downstream must be reported as unavailable.
        expect(counts.reviewed).toBe(0);
      }
      for (const split of suite.splits) {
        expect(split.deterministic).toBe(true);
        expect(split.cases).toBe(split.expectedCases);
      }
    }
    expect(lines.join("\n")).toContain("PREFLIGHT PASS");
  });

  it("refuses tampered questions during preparation, before any request exists", async () => {
    const out = join(dir, "preflight-questions");
    const tampered: SuiteDefinition<FakeCase> = {
      ...fakeSuite,
      questions: { ...defaultQuestions("safety"), extra: { type: "noul", instructions: "not in the preset" } },
    };
    await expect(
      runCli(["preflight", "--out", out], {
        ...deps(),
        suites: { safety: tampered as unknown as SuiteDefinition<EvalCase> },
      }),
    ).rejects.toThrow(/does not use the suite's default questions/);
    // Preparation refused first, so there is no report claiming anything.
    expect(existsSync(join(out, OUTPUT_FILES.preflight))).toBe(false);
  });

  it("reports a label leaking into State as a problem and blocks the live stage", async () => {
    const out = join(dir, "preflight-leak");
    // Only the safety slot is replaced; municipal loads its real module and
    // contributes no problems, so the problem list is entirely about the leak.
    const leaky: SuiteDefinition<FakeCase> = {
      ...fakeSuite,
      buildRequest: (c) => {
        const request = buildSafetyRequest(c.input);
        const state = { ...(request.state as Record<string, unknown>), notes: c.notes };
        return { ...request, state: state as never };
      },
    };
    await expect(
      runCli(["preflight", "--out", out], {
        ...deps(),
        suites: { safety: leaky as unknown as SuiteDefinition<EvalCase> },
      }),
    ).rejects.toThrow(/Preflight failed/);
    const report = JSON.parse(read(join(out, OUTPUT_FILES.preflight)));
    expect(report.ok).toBe(false);
    const problems = report.problems.join("\n");
    expect(problems).toMatch(/State contains the forbidden key "notes"/);
    expect(problems).toMatch(/are not the safety whitelist/);
  });
});

/* ------------------------------------------- The live path is opt-in only -- */

describe("the live path cannot be reached by accident", () => {
  it("parses --confirm-live and --dry-run as standalone flags", () => {
    expect(parseArgs(["live", "--confirm-live", "--dry-run", "--max-calls", "3"])).toEqual({
      command: "live",
      flags: { "confirm-live": "true", "dry-run": "true", "max-calls": "3" },
    });
  });

  it("never loads the provider adapter from an offline command", async () => {
    const p = await prepared(join(dir, "prep"));
    const fake = fakeEvaluate();
    await runCli(["mock-run", "--prepared", p, "--out", join(dir, "mock")], deps({ liveEvaluate: fake.evaluate }));
    const manifest = JSON.parse(read(join(dir, "mock", OUTPUT_FILES.runManifest))) as RunManifest;
    expect(manifest.provenance).toBe("mock");
    expect(manifest.requestedModel).toBeNull();
    expect(fake.calls()).toBe(0);
  });

  it("keeps the SDK and the credential reader out of every offline module", () => {
    const root = process.cwd();
    const offline = [
      "evaluation/cli.ts",
      "evaluation/main.ts",
      "evaluation/shared/runner.ts",
      "evaluation/shared/pipeline.ts",
      "evaluation/shared/predictions.ts",
      "evaluation/shared/mock.ts",
      "evaluation/municipal/index.ts",
      "evaluation/safety/index.ts",
    ];
    for (const file of offline) {
      const source = readFileSync(join(root, file), "utf8");
      // A static import would put the SDK in the process for `eval:prepare` too.
      expect(source).not.toMatch(/^\s*import[^\n]*"@typesafe-ai\/sdk"/m);
      expect(source).not.toMatch(/^\s*import\s+\{[^}]*\}\s+from\s+"\.\.?\/(\.\.\/)?lib\/evaluation"/m);
      expect(source).not.toContain("TYPESAFE_API_KEY");
    }
    // The one file that is allowed to reach the provider says so.
    const live = readFileSync(join(root, "evaluation/live.ts"), "utf8");
    expect(live).toContain("../lib/evaluation");
  });

  it("writes nothing and spends nothing when a live command is malformed", async () => {
    const out = join(dir, "never");
    const fake = fakeEvaluate();
    for (const argv of [
      ["live", "--out", out, "--max-calls", "6", "--confirm-live"],
      ["live", "--prepared", join(dir, "missing"), "--out", out, "--max-calls", "6", "--confirm-live"],
      ["smoke", "--out", out, "--max-calls", "0", "--confirm-live"],
    ]) {
      await expect(runCli(argv, deps({ liveEvaluate: fake.evaluate }))).rejects.toThrow();
    }
    expect(existsSync(out)).toBe(false);
    expect(fake.calls()).toBe(0);
  });
});

/* ----------------------------------------------- A written-through check -- */

describe("artifacts", () => {
  it("writes each live artifact atomically, leaving no temporary file behind", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate();
    await runCli(["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live"], deps({ liveEvaluate: fake.evaluate }));
    expect(readdirSync(out).sort()).toEqual([OUTPUT_FILES.liveRun, OUTPUT_FILES.predictions, OUTPUT_FILES.runManifest].sort());
    // A stray .tmp would mean a reader could observe a half-written artifact.
    expect(readdirSync(out).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("refuses a predictions file whose manifest no longer matches the suite", async () => {
    const p = await prepared(join(dir, "prep"));
    const out = join(dir, "run");
    const fake = fakeEvaluate();
    await runCli(["live", "--prepared", p, "--out", out, "--max-calls", "6", "--confirm-live"], deps({ liveEvaluate: fake.evaluate }));
    const path = join(out, OUTPUT_FILES.runManifest);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(read(path)), inputHash: "tampered" }));
    await expect(
      runCli(["score", "--suite", "safety", "--manifest", path, "--predictions", join(out, OUTPUT_FILES.predictions), "--out", join(dir, "r")], deps()),
    ).rejects.toThrow(/input hash/);
  });
});

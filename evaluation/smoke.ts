/**
 * The 12-sample live smoke check (JEV-06).
 *
 * WHAT IT IS
 * ----------
 * One call per visible playground sample — the 9 student-safety samples and the
 * 3 municipal samples in `lib/scenarios.ts` — using that preset's unchanged
 * default questions and the sample's own State. It answers exactly one
 * question: does a real request over this schema come back, validate against
 * the submitted questions, and compose through the existing code?
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a benchmark and it produces no metric. Each sample in
 * `lib/scenarios.ts` carries a proposed illustrative `expected` string, and this
 * module deliberately does not read it, record it, or compare anything to it.
 * Twelve unreviewed illustrations cannot measure anything, and a recorded
 * "expected" column next to an observed answer invites exactly the accuracy
 * claim this stage is not entitled to make. A reviewer who wants to eyeball
 * plausibility reads the observed answers next to `lib/scenarios.ts`.
 *
 * The run stops at the first failure of any kind. The remaining samples are
 * recorded as `not_attempted` so the unspent budget is visible, and the dataset
 * stage does not start.
 *
 * No State text reaches an artifact: a row identifies its request by hash. The
 * sample States are already in the committed source, so the hash is enough to
 * reproduce the request, and nothing a student might have written is copied
 * into an output file.
 */

import { validateUpstreamResult } from "../lib/evaluation-response";
import { composeMunicipalRouting } from "../lib/municipal-routing";
import { composeSafetyRecommendation } from "../lib/safety-guardrails";
import { getScenario, type ScenarioId } from "../lib/scenarios";
import type { Answers, Usage } from "../lib/types";
import { latencySummary, type LatencySummary, type LiveEvaluatorHandle } from "./live";
import { hashJson, questionsHash, sanitizeError, type SanitizedError } from "./shared";

/** Safety first, then municipal: 9 + 3 = 12 attempts at most. */
export const SMOKE_SCENARIOS: readonly ScenarioId[] = ["safety", "municipal"];

export const SMOKE_MAX_CALLS = 12;

const COMPOSERS: Record<ScenarioId, (answers: Answers) => unknown> = {
  safety: composeSafetyRecommendation,
  municipal: composeMunicipalRouting,
};

export interface SmokeRow {
  scenario: ScenarioId;
  sampleId: string;
  group: string;
  label: string;
  /** SHA-256 of the stable-key `{ state, questions }` actually submitted. */
  requestHash: string;
  questionsHash: string;
  status: "ok" | "error" | "not_attempted";
  /** Present when a response arrived at all: did it match the submitted questions? */
  schemaValid?: boolean;
  /** The validated typed answers, verbatim. Present iff `status` is `ok`. */
  answers?: Answers;
  /** Composed with the existing preset code. Present iff `status` is `ok`. */
  composed?: unknown;
  /** What the provider reported. Absent if it reported nothing. */
  resolvedModel?: string;
  /** Absent when the provider reported none — never zero-filled. */
  usage?: Usage;
  /** End-to-end duration around the evaluation call. Absent when unattempted. */
  durationMs?: number;
  /** Present iff `status` is `error`. Sanitized: a code and a fixed message. */
  error?: SanitizedError;
}

export interface SmokeRecord {
  schemaVersion: 1;
  provenance: "live";
  /** The alias or identifier asked for; the rows record what came back. */
  requestedModel: string;
  codeRevision: string | null;
  startedAt: string;
  maxCalls: number;
  /** Attempts actually dispatched to the provider. */
  providerAttempts: number;
  counts: { total: number; ok: number; error: number; notAttempted: number };
  /** Distinct models the provider reported. More than one fails the model freeze. */
  resolvedModels: string[];
  /** End-to-end evaluation-call latency over successful attempts only. */
  latency: LatencySummary | null;
  rows: SmokeRow[];
  caveats: string[];
}

export const SMOKE_CAVEATS: readonly string[] = [
  "A smoke test, not a benchmark: 12 calls, one attempt each, no metric.",
  "The samples' proposed illustrative expectations are deliberately not read, recorded, or compared here.",
  "Schema validity and successful composition say nothing about whether a judgment is correct.",
  "State text is not copied into this record; requestHash identifies the submitted request.",
];

export interface RunSmokeOptions {
  /** The paid evaluator from `createLiveEvaluator`. */
  live: LiveEvaluatorHandle;
  requestedModel: string;
  codeRevision: string | null;
  startedAt: string;
  /** Injected clock in milliseconds. Defaults to `performance.now`. */
  now?: () => number;
}

export interface SmokeSample {
  scenario: ScenarioId;
  sampleId: string;
  group: string;
  label: string;
  state: unknown;
  questions: ReturnType<typeof getScenario>["questions"];
}

/** The 12 visible samples in run order, built from the unchanged presets. */
export function smokeSamples(): SmokeSample[] {
  const samples: SmokeSample[] = [];
  for (const id of SMOKE_SCENARIOS) {
    const scenario = getScenario(id);
    for (const sample of scenario.samples) {
      samples.push({
        scenario: id,
        sampleId: sample.id,
        group: sample.group,
        label: sample.label,
        // The sample's own State, as the playground submits it. `expected` and
        // `note` are not read.
        state: sample.state,
        questions: scenario.questions,
      });
    }
  }
  return samples;
}

export async function runSmoke(options: RunSmokeOptions): Promise<SmokeRecord> {
  const { live, requestedModel, codeRevision, startedAt } = options;
  const clock = options.now ?? (() => performance.now());
  const samples = smokeSamples();
  const rows: SmokeRow[] = [];
  const durations: number[] = [];
  let stopped = false;

  for (const sample of samples) {
    const base = {
      scenario: sample.scenario,
      sampleId: sample.sampleId,
      group: sample.group,
      label: sample.label,
      requestHash: hashJson({ state: sample.state, questions: sample.questions }),
      questionsHash: questionsHash(sample.questions),
    };
    if (stopped) {
      rows.push({ ...base, status: "not_attempted" });
      continue;
    }

    const started = clock();
    let raw: unknown;
    try {
      raw = await live.evaluator({ state: sample.state as never, questions: sample.questions });
    } catch (error) {
      rows.push({ ...base, status: "error", error: sanitizeError(error), durationMs: clock() - started });
      stopped = true;
      continue;
    }
    const durationMs = clock() - started;
    const validation = validateUpstreamResult(raw, sample.questions);
    const reported = (raw as { model?: unknown } | null)?.model;
    const resolvedModel = typeof reported === "string" && reported.trim() !== "" ? { resolvedModel: reported } : {};

    if (!validation.ok || !validation.value) {
      rows.push({
        ...base,
        status: "error",
        schemaValid: false,
        ...resolvedModel,
        durationMs,
        error: { code: "invalid_response", message: "The response does not match the submitted questions." },
      });
      stopped = true;
      continue;
    }

    const response = validation.value;
    durations.push(durationMs);
    rows.push({
      ...base,
      status: "ok",
      schemaValid: true,
      answers: response.answers,
      composed: COMPOSERS[sample.scenario](response.answers),
      ...(response.model !== undefined ? { resolvedModel: response.model } : {}),
      ...(response.usage !== undefined ? { usage: response.usage } : {}),
      durationMs,
    });
  }

  const ok = rows.filter((r) => r.status === "ok").length;
  const error = rows.filter((r) => r.status === "error").length;
  const models = new Set<string>();
  for (const row of rows) if (row.status === "ok" && row.resolvedModel !== undefined) models.add(row.resolvedModel);

  return {
    schemaVersion: 1,
    provenance: "live",
    requestedModel,
    codeRevision,
    startedAt,
    maxCalls: SMOKE_MAX_CALLS,
    providerAttempts: live.attempts(),
    counts: { total: rows.length, ok, error, notAttempted: rows.length - ok - error },
    resolvedModels: [...models].sort(),
    latency: latencySummary(durations),
    rows,
    caveats: [...SMOKE_CAVEATS],
  };
}

/**
 * The model freeze gate: every successful smoke call must report the same model.
 *
 * Returns the single resolved model, or `null` with a reason when the dataset run
 * must not proceed on a frozen model.
 */
export function frozenModel(record: SmokeRecord): { model: string } | { model: null; reason: string } {
  if (record.counts.ok !== record.counts.total) {
    return {
      model: null,
      reason: `only ${record.counts.ok} of ${record.counts.total} smoke calls succeeded`,
    };
  }
  if (record.resolvedModels.length === 0) {
    return { model: null, reason: "no smoke response reported a resolved model" };
  }
  if (record.resolvedModels.length > 1) {
    return { model: null, reason: `smoke calls reported ${record.resolvedModels.length} different models` };
  }
  return { model: record.resolvedModels[0]! };
}

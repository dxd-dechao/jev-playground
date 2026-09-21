/**
 * Sequential runner over prepared requests with an injected evaluator.
 *
 * This file never creates a client and never reads a credential: the evaluator
 * is a plain function handed in by the caller (a deterministic mock here; a
 * real adapter under a separate budget in JEV-06). Each case is attempted once
 * — there are no retries — and every outcome lands in exactly one bucket:
 * ok, error, or not attempted.
 */

import { validateUpstreamResult } from "../../lib/evaluation-response";
import type { Answers, Questions } from "../../lib/types";
import type {
  ErrorPolicy,
  Evaluator,
  PredictionRow,
  PreparedRequest,
  PreparedRun,
  ProvenanceMode,
  RunManifest,
  SanitizedError,
} from "./types";

export const ERROR_MESSAGES: Record<string, string> = {
  invalid_response: "The evaluator returned a response that does not match the submitted questions.",
  evaluator_error: "The evaluator failed; details are withheld.",
};

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Keep only a short machine code from a thrown error. The message is fixed per
 * code so no upstream body, header, or State content can leak into a report.
 */
export function sanitizeError(error: unknown): SanitizedError {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    ERROR_CODE.test((error as { code: string }).code)
      ? (error as { code: string }).code
      : "evaluator_error";
  return {
    code,
    message: ERROR_MESSAGES[code] ?? `The evaluator failed with code ${code}; details are withheld.`,
  };
}

export interface RunCasesOptions {
  prepared: PreparedRun;
  requests: readonly PreparedRequest[];
  evaluator: Evaluator;
  compose: (answers: Answers) => unknown;
  provenance: ProvenanceMode;
  requestedModel: string | null;
  errorPolicy: ErrorPolicy;
  /**
   * Injected clock in milliseconds; defaults to `performance.now`. Pass `null`
   * to record no duration at all (e.g. a deterministic mock run), which leaves
   * `durationMs` absent rather than zero.
   */
  now?: (() => number) | null;
}

export interface RunCasesResult {
  manifest: RunManifest;
  rows: PredictionRow[];
  /** Selected case IDs never attempted because the run stopped. */
  notAttemptedIds: string[];
}

export async function runCases(options: RunCasesOptions): Promise<RunCasesResult> {
  const { prepared, requests, evaluator, compose, provenance, requestedModel, errorPolicy } = options;
  const clock = options.now === undefined ? () => performance.now() : options.now;
  const started = () => (clock ? clock() : undefined);
  const elapsed = (start: number | undefined) =>
    clock && start !== undefined ? { durationMs: clock() - start } : {};

  const byId = new Map(requests.map((r) => [r.caseId, r]));
  if (byId.size !== requests.length) throw new Error("Prepared requests contain a duplicate caseId");
  for (const id of prepared.caseIds) {
    if (!byId.has(id)) throw new Error(`Prepared requests are missing case ${id}`);
  }
  if (byId.size !== prepared.caseIds.length) {
    throw new Error("Prepared requests contain cases not selected in the prepared run");
  }

  const rows: PredictionRow[] = [];
  const notAttemptedIds: string[] = [];
  let stopped = false;

  for (const caseId of prepared.caseIds) {
    if (stopped) {
      notAttemptedIds.push(caseId);
      continue;
    }
    const { request } = byId.get(caseId)!;
    const questions: Questions = request.questions;
    const base = { caseId, provenance, requestedModel };
    const start = started();
    let raw: unknown;
    try {
      // The evaluator sees the built request and nothing else.
      raw = await evaluator({ state: request.state, questions: request.questions });
    } catch (error) {
      rows.push({ ...base, status: "error", error: sanitizeError(error), ...elapsed(start) });
      if (errorPolicy === "stop") stopped = true;
      continue;
    }
    const duration = elapsed(start);
    const validation = validateUpstreamResult(raw, questions);
    if (!validation.ok || !validation.value) {
      rows.push({
        ...base,
        status: "error",
        error: { code: "invalid_response", message: ERROR_MESSAGES.invalid_response! },
        ...duration,
      });
      if (errorPolicy === "stop") stopped = true;
      continue;
    }
    const response = validation.value;
    const row: PredictionRow = {
      ...base,
      status: "ok",
      response,
      composed: compose(response.answers),
      ...duration,
    };
    if (response.model !== undefined) row.model = response.model;
    if (response.usage !== undefined) row.usage = response.usage;
    rows.push(row);
  }

  const ok = rows.filter((r) => r.status === "ok").length;
  const manifest: RunManifest = {
    ...prepared,
    provenance,
    requestedModel,
    errorPolicy,
    counts: {
      selected: prepared.caseIds.length,
      ok,
      error: rows.length - ok,
      notAttempted: notAttemptedIds.length,
    },
  };
  return { manifest, rows, notAttemptedIds };
}

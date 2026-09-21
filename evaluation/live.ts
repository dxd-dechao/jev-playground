/**
 * The live TypeSafe evaluator (JEV-06). THE ONLY FILE UNDER `evaluation/` THAT
 * CAN SPEND MONEY.
 *
 * WHAT THIS FILE IS AND IS NOT
 * ----------------------------
 * It is a thin adapter: it wraps the existing server-only `evaluateSystemOne`
 * from `lib/evaluation.ts` in the `Evaluator` function shape that
 * `evaluation/shared/runner.ts` already accepts. It does **not** construct a
 * TypeSafe client, set a timeout, configure retries, choose a base URL, read
 * `TYPESAFE_API_KEY`, or validate a response. All of that already exists and
 * stays in one place; duplicating any of it here would mean two answers to
 * "how does this project call the provider".
 *
 * WHY IT IS HARD TO INVOKE BY ACCIDENT
 * ------------------------------------
 * `createLiveEvaluator` refuses to return anything unless the caller passes
 * `confirmLive: true` and a finite positive `maxCalls`. There is no default, no
 * environment-variable switch, and no credential-driven fallback: a test, a
 * build, or `eval:mock-run` cannot reach a paid call by forgetting a flag.
 *
 * SPENDING GUARDS
 * ---------------
 * - A hard attempt counter. Once `maxCalls` attempts have been dispatched the
 *   evaluator throws `budget_exhausted` *before* calling the provider.
 * - One call at a time. A second concurrent call throws rather than doubling
 *   the spend rate; the runner is sequential and this proves it stays that way.
 * - A circuit breaker. After a fatal provider condition (bad credentials,
 *   denied permission, rate limit) every later case fails locally with
 *   `run_halted` and no further request is dispatched. The run still reports an
 *   explicit failure per case, so nothing disappears from a denominator, but a
 *   dead key cannot burn a 202-case budget.
 *
 * Retries stay off: `lib/evaluation.ts` disables them, and this file never adds
 * one. One case is one attempt.
 */

import { renameSync, writeFileSync } from "node:fs";
import {
  evaluateSystemOne,
  isConfigured,
  resolveRequestedModel,
  type EvaluateOutcome,
  type EvaluationDeps,
  type EvaluateInput,
} from "../lib/evaluation";
import type { EvaluationRequest } from "../lib/types";
import type { Evaluator } from "./shared";

/** The injectable shape of `evaluateSystemOne`. Tests pass a fake. */
export type EvaluateFn = (input: EvaluateInput, deps?: EvaluationDeps) => Promise<EvaluateOutcome>;

/**
 * Provider conditions that make every further attempt pointless *and* billable
 * or rate-limited. Anything else (a malformed answer, one timeout, one
 * unavailable response) is a per-case failure and the run carries on.
 */
export const FATAL_CODES: readonly string[] = ["not_configured", "upstream_auth", "upstream_rate_limit"];

export interface LiveEvaluatorOptions {
  /**
   * Deliberate opt-in to paid calls. There is no default: omitting it is a
   * refusal, not a mock run.
   */
  confirmLive: boolean;
  /** Hard cap on attempts this evaluator will dispatch. Must be a positive integer. */
  maxCalls: number;
  /** Test seam replacing `evaluateSystemOne`. Production callers pass nothing. */
  evaluate?: EvaluateFn;
  /** Test seam forwarded to `evaluateSystemOne` (a fake `fetch`, a synthetic key). */
  deps?: EvaluationDeps;
}

export interface LiveEvaluatorHandle {
  evaluator: Evaluator;
  /** Attempts actually dispatched to the provider, not error rows. */
  attempts(): number;
  /** Set once a fatal condition halted the run. */
  halted(): { afterAttempts: number; code: string } | null;
  /**
   * Distinct `model` values the provider reported, sorted.
   *
   * Latency is deliberately *not* tracked here. The runners measure end-to-end
   * duration around the evaluator call, and one definition of "how long a call
   * took" is worth more than two that differ by a few milliseconds.
   */
  resolvedModels(): string[];
}

/** A local failure that carries a short machine code for `sanitizeError`. */
export class LiveRunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LiveRunError";
    this.code = code;
  }
}

function codeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return null;
}

/**
 * Build the paid evaluator.
 *
 * @throws When `confirmLive` is not `true` or `maxCalls` is not a positive
 * integer — the two things a caller must state on purpose.
 */
export function createLiveEvaluator(options: LiveEvaluatorOptions): LiveEvaluatorHandle {
  if (options.confirmLive !== true) {
    throw new Error(
      "createLiveEvaluator requires confirmLive: true. Live evaluation spends money and is never a default.",
    );
  }
  const { maxCalls } = options;
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    throw new Error(`createLiveEvaluator requires an explicit positive integer maxCalls (got ${String(maxCalls)})`);
  }
  const evaluate = options.evaluate ?? evaluateSystemOne;

  let attempts = 0;
  let inFlight = false;
  let halted: { afterAttempts: number; code: string } | null = null;
  const models = new Set<string>();

  const evaluator: Evaluator = async (request: EvaluationRequest) => {
    if (halted !== null) {
      throw new LiveRunError("run_halted", "The run stopped after a fatal provider condition; no request was sent.");
    }
    if (attempts >= maxCalls) {
      throw new LiveRunError("budget_exhausted", `The authorized ${maxCalls}-call budget is used up; no request was sent.`);
    }
    if (inFlight) {
      throw new LiveRunError("concurrent_call", "The live evaluator runs one call at a time; no request was sent.");
    }

    inFlight = true;
    attempts += 1;
    try {
      // The adapter forwards only the built request. It adds no model, no
      // header, and no state of its own.
      const outcome = await evaluate({ state: request.state, questions: request.questions }, options.deps);
      const reported = (outcome.raw as { model?: unknown } | null)?.model;
      if (typeof reported === "string" && reported.trim() !== "") models.add(reported);
      return outcome.raw;
    } catch (error) {
      const code = codeOf(error);
      if (code !== null && FATAL_CODES.includes(code)) {
        halted = { afterAttempts: attempts, code };
      }
      throw error;
    } finally {
      inFlight = false;
    }
  };

  return {
    evaluator,
    attempts: () => attempts,
    halted: () => halted,
    resolvedModels: () => [...models].sort(),
  };
}

/**
 * Run `fn` with `TYPESAFE_MODEL` pinned, then restore it.
 *
 * `lib/evaluation.ts` resolves the requested model from `TYPESAFE_MODEL` (then
 * the SDK's own `TYPESAFE_DEFAULT_MODEL`, then `jev-latest`). Pinning through
 * that documented variable is how the dataset run asks for one exact model
 * without this file duplicating the SDK's configuration. The TypeSafe model
 * reference states that versioned identifiers such as `jev-1.13.0` are accepted
 * by the `model` field, which is what makes pinning to a *resolved* model legal.
 */
export async function withPinnedModel<T>(model: string | null, fn: () => Promise<T>): Promise<T> {
  if (model === null) return fn();
  if (model.trim() === "") throw new Error("A pinned model must be a nonempty identifier");
  const previous = process.env.TYPESAFE_MODEL;
  process.env.TYPESAFE_MODEL = model;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_MODEL;
    else process.env.TYPESAFE_MODEL = previous;
  }
}

/**
 * The model the adapter will ask for, read without calling anything.
 *
 * Re-exported so a dry run can print the requested model while proving it made
 * no provider call.
 */
export function requestedModel(): string {
  return resolveRequestedModel();
}

/** Whether a key is present. Says nothing about whether it works. */
export function keyPresent(): boolean {
  return isConfigured();
}

/* ---------------------------------------------------------- Artifacts -- */

/**
 * Write via a temporary file and a rename, so a reader never sees a half-written
 * artifact and an interrupted run leaves the previous state alone.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

export interface LatencySummary {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * End-to-end evaluation-call latency over successful attempts only.
 *
 * `null` when nothing succeeded — never a zero-filled summary that would read
 * like an instant response. p95 uses the nearest-rank method.
 */
export function latencySummary(durationsMs: readonly number[]): LatencySummary | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
  const middle = sorted.length / 2;
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    medianMs:
      sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

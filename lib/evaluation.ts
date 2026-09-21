/**
 * Server-only adapter for the TypeSafe JavaScript SDK.
 *
 * SERVER ONLY
 * -----------
 * Nothing in this module may reach the browser: it reads the API key from the
 * environment and constructs the SDK client. The module-level guard below fails
 * loudly if it is ever bundled into client code. (The `server-only` package is
 * not used because its default export throws under plain Node, which would make
 * this module untestable outside a Next bundler. The SDK adds a second guard of
 * its own: it refuses to run in a browser unless `dangerouslyAllowBrowser` is
 * set, and we never set it.)
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 * - Lazy client construction. The SDK constructor *throws* when no API key is
 *   present, so building the app and using fixture mode must not construct it.
 * - Exactly one upstream request per call. The SDK retries twice by default;
 *   retries are disabled here because every attempt is a paid call the user did
 *   not ask for.
 * - A finite 30-second budget enforced by real cancellation: both the SDK's own
 *   per-attempt timeout and an `AbortSignal` we control abort the request. An
 *   uncancelled `Promise.race` would leave the call running and still billed.
 * - Server-owned model and provider URL. The browser cannot influence either.
 * - Sanitized errors. Upstream bodies, headers, and credentials never leave this
 *   module, and no submitted State content is placed in an error or a log.
 */

import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  type Fetch,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import {
  GATE_MISCONFIGURED_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from "./playground-gate";
import type { EvaluationErrorCode, Questions, State } from "./types";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/evaluation.ts is server-only: it reads TYPESAFE_API_KEY and must " +
      "never be bundled into browser code.",
  );
}

/** The whole upstream budget. One attempt, so per-attempt equals total. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Hard cap on an accepted request body, enforced while reading rather than from
 * a header.
 *
 * It lives here rather than in the route because a Next.js route module may only
 * export the handler names and the framework's own configuration keys; anything
 * else fails the build's route type check.
 */
export const MAX_BODY_BYTES = 128 * 1024;

/** Documented SDK default when neither `TYPESAFE_MODEL` nor the SDK's own is set. */
export const DEFAULT_MODEL = "jev-latest";

/**
 * Retries are off. The SDK default is `maxRetries: 2`, and it also retries
 * connection and timeout failures; all three are disabled so that one explicit
 * submission can never become three billed calls.
 */
const NO_RETRY = {
  maxRetries: 0,
  apiConnectionError: false,
  apiTimeoutError: false,
} as const;

/** Read the key without copying it anywhere it could be logged or returned. */
function readApiKey(): string | null {
  const raw = process.env.TYPESAFE_API_KEY;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw;
}

/**
 * Whether a key is present — nothing more.
 *
 * This says the server has something to authenticate with. It does not say the
 * key is valid, the account is funded, or the service is reachable. Only a real
 * call can tell you that, and this function deliberately does not make one.
 */
export function isConfigured(): boolean {
  return readApiKey() !== null;
}

/**
 * The model the server will ask for.
 *
 * The plan names `TYPESAFE_MODEL`. The SDK independently reads
 * `TYPESAFE_DEFAULT_MODEL`, so that is honoured as a fallback rather than
 * quietly ignored, and the resolved name is always sent explicitly on the
 * request so the requested model is never ambiguous.
 */
export function resolveRequestedModel(): string {
  const candidates = [process.env.TYPESAFE_MODEL, process.env.TYPESAFE_DEFAULT_MODEL];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return DEFAULT_MODEL;
}

/** Test seam. Production callers pass nothing; tests inject an offline `fetch`. */
export interface EvaluationDeps {
  /**
   * Replacement HTTP transport. Tests pass a fake so the provider boundary is
   * exercised through the real SDK without any network access.
   */
  fetch?: Fetch;
  /** Overrides the environment key. Tests pass a synthetic placeholder. */
  apiKey?: string;
}

/**
 * Build the client. Called per request rather than cached at module scope, so a
 * missing key is a handled error at call time instead of an import-time crash.
 */
export function createClient(deps: EvaluationDeps = {}): TypeSafeClient {
  const apiKey = deps.apiKey ?? readApiKey();
  if (apiKey === null) {
    throw new EvaluationError("not_configured");
  }
  return new TypeSafeClient({
    apiKey,
    defaultModel: resolveRequestedModel(),
    timeout: UPSTREAM_TIMEOUT_MS,
    retry: NO_RETRY,
    // The SDK logs request bodies at `debug`. State can contain a student's
    // message, so SDK logging stays off entirely.
    logLevel: "off",
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

/** An upstream or configuration failure, already classified and sanitized. */
export class EvaluationError extends Error {
  readonly code: EvaluationErrorCode;

  constructor(code: EvaluationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "EvaluationError";
    this.code = code;
  }
}

/**
 * The exact text a user sees. Fixed strings: no upstream body, no header, no
 * credential fragment, and no part of the submitted State can appear in one.
 */
export const ERROR_MESSAGES: Record<EvaluationErrorCode, string> = {
  not_configured:
    "This server has no TypeSafe API key, so it cannot call the model. " +
    "Set TYPESAFE_API_KEY in .env.local and restart.",
  invalid_request:
    "The request was rejected before any model call because it did not validate.",
  payload_too_large:
    "The submitted State is larger than the 128 KiB limit, so it was rejected " +
    "before any model call.",
  unauthorized: UNAUTHORIZED_MESSAGE,
  gate_misconfigured: GATE_MISCONFIGURED_MESSAGE,
  upstream_auth:
    "TypeSafe rejected the server's credentials. The key may be wrong, revoked, " +
    "or lacking access to this model. Check TYPESAFE_API_KEY on the server; the " +
    "key itself is never shown here.",
  upstream_rate_limit:
    "TypeSafe rate-limited this request. Nothing was retried automatically — " +
    "wait a moment and submit again if you want another call.",
  upstream_timeout:
    "The model call was cancelled after 30 seconds without a complete response. " +
    "It was not retried.",
  upstream_unavailable:
    "TypeSafe could not be reached or returned an error. Nothing was retried " +
    "automatically.",
  upstream_malformed:
    "TypeSafe returned a response that does not match the questions that were " +
    "submitted, so none of it is shown. Displaying part of it could look like a " +
    "real answer to a different question.",
  request_aborted: "The request was cancelled before a response arrived.",
  internal_error: "The server failed to complete this evaluation.",
};

/** HTTP status per error code. */
export const ERROR_STATUS: Record<EvaluationErrorCode, number> = {
  not_configured: 503,
  invalid_request: 400,
  payload_too_large: 413,
  unauthorized: 401,
  gate_misconfigured: 503,
  upstream_auth: 502,
  upstream_rate_limit: 429,
  upstream_timeout: 504,
  upstream_unavailable: 502,
  upstream_malformed: 502,
  request_aborted: 499,
  internal_error: 500,
};

/**
 * Map an SDK failure onto one of our codes.
 *
 * `timedOut` distinguishes our own abort from a caller disconnect: both surface
 * as `APIUserAbortError`, but only one of them is a timeout.
 */
export function classifyError(error: unknown, timedOut: boolean): EvaluationError {
  if (error instanceof EvaluationError) return error;
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new EvaluationError("upstream_auth");
  }
  if (error instanceof RateLimitError) {
    return new EvaluationError("upstream_rate_limit");
  }
  if (error instanceof APITimeoutError) {
    return new EvaluationError("upstream_timeout");
  }
  if (error instanceof APIUserAbortError) {
    return new EvaluationError(timedOut ? "upstream_timeout" : "request_aborted");
  }
  if (error instanceof APIConnectionError || error instanceof InternalServerError) {
    return new EvaluationError("upstream_unavailable");
  }
  // Remaining `APIError`s (400, 422, 404, and anything new) mean the service
  // would not process the request. Its body is not forwarded.
  if (typeof error === "object" && error !== null && "status" in error) {
    return new EvaluationError("upstream_unavailable");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new EvaluationError(timedOut ? "upstream_timeout" : "request_aborted");
  }
  return new EvaluationError("internal_error");
}

export interface EvaluateInput {
  state: State;
  questions: Questions;
  /** Aborts the upstream call when the HTTP client goes away. */
  signal?: AbortSignal;
}

export interface EvaluateOutcome {
  /** The SDK result, unvalidated. The caller runs the runtime checks. */
  raw: unknown;
  /** Wall time around the SDK call only, in milliseconds. */
  durationMs: number;
  requestedModel: string;
}

/**
 * One evaluation: one upstream request, no retries, 30-second hard budget.
 *
 * The result is returned unvalidated on purpose. Checking it belongs to
 * `evaluation-response.ts`, which knows the submitted questions; mixing the two
 * would let a transport concern decide what counts as a valid answer.
 *
 * @throws {EvaluationError} Always this type — SDK errors are classified first.
 */
export async function evaluateSystemOne(
  input: EvaluateInput,
  deps: EvaluationDeps = {},
): Promise<EvaluateOutcome> {
  const client = createClient(deps);
  const requestedModel = resolveRequestedModel();

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  const onCallerAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const started = performance.now();
  try {
    const raw = await client.systemOne(
      {
        // The SDK's `EntryType`/`JsonValue` types are narrower than our
        // `State`/`Questions`, which are already schema-validated by the caller.
        state: input.state as never,
        questions: input.questions as never,
        model: requestedModel,
      },
      {
        signal: controller.signal,
        timeout: UPSTREAM_TIMEOUT_MS,
        retry: NO_RETRY,
      },
    );
    // Measure before any validation work so the number means "the call".
    return { raw, durationMs: performance.now() - started, requestedModel };
  } catch (error) {
    throw classifyError(error, timedOut);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

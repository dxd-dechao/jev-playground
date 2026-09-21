/**
 * `POST /api/evaluate-llm` — the path to a Moonshot language-model call.
 *
 * Same body as `POST /api/evaluate`: `{ scenarioId, state, questions }` and
 * nothing else. The password cookie from `POST /api/unlock` is enough; this
 * route does not unlock. The page does not call this route.
 *
 *  - The model and the Moonshot base URL come from the server environment.
 *  - The body is read under a hard byte cap, enforced while reading.
 *  - When `PLAYGROUND_PASSWORD` is set, a valid `jev_access` cookie is required
 *    before `isLlmConfigured` or the adapter run.
 *  - Every validation failure happens *before* Moonshot is touched.
 *  - The response is validated against the submitted questions before it is
 *    returned, and errors are fixed sanitized strings.
 */

import { ERROR_MESSAGES, ERROR_STATUS, MAX_BODY_BYTES } from "@/lib/evaluation";
import {
  LLM_ERROR_MESSAGES,
  LlmEvaluationError,
  evaluateWithLlm,
  isLlmConfigured,
} from "@/lib/llm-evaluation";
import {
  hasValidAccessCookie,
  isGateMisconfigured,
  isPasswordGateEnabled,
} from "@/lib/playground-gate";
import {
  describeDuplicateKey,
  findDuplicateRequestKeys,
  validateEvaluateBody,
  validatePlaygroundRequest,
} from "@/lib/schemas";
import type {
  EvaluationErrorCode,
  EvaluationErrorPayload,
  LiveEvaluationPayload,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "content-type": "application/json",
  "cache-control": "no-store, max-age=0",
} as const;

function messageFor(code: EvaluationErrorCode): string {
  return LLM_ERROR_MESSAGES[code] ?? ERROR_MESSAGES[code];
}

function errorResponse(
  code: EvaluationErrorCode,
  detail?: string,
): Response {
  const payload: EvaluationErrorPayload = {
    error: { code, message: detail ? `${messageFor(code)} ${detail}` : messageFor(code) },
  };
  return new Response(JSON.stringify(payload), {
    status: ERROR_STATUS[code],
    headers: NO_STORE,
  });
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; code: "payload_too_large" | "invalid_request" };

/**
 * Read the body with the cap applied to bytes actually received.
 *
 * Copied from `POST /api/evaluate` rather than shared: that route's success and
 * rejection behaviour stays as it is.
 */
async function readBodyCapped(request: Request): Promise<BodyRead> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (Number.isFinite(parsed) && parsed > MAX_BODY_BYTES) {
      return { ok: false, code: "payload_too_large" };
    }
  }

  const body = request.body;
  if (body === null) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, code: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "invalid_request" };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

export async function POST(request: Request): Promise<Response> {
  if (isGateMisconfigured()) return errorResponse("gate_misconfigured");
  if (isPasswordGateEnabled() && !hasValidAccessCookie(request)) {
    return errorResponse("unauthorized");
  }

  const read = await readBodyCapped(request);
  if (!read.ok) return errorResponse(read.code);

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return errorResponse("invalid_request", "The body is not valid JSON.");
  }

  const body = validateEvaluateBody(parsed);
  if (!body.ok || body.value === undefined) {
    return errorResponse("invalid_request", body.errors.join("; "));
  }

  const duplicates = findDuplicateRequestKeys(read.text);
  if (duplicates.length > 0) {
    return errorResponse(
      "invalid_request",
      duplicates.map(describeDuplicateKey).join("; "),
    );
  }

  const { state, questions } = body.value;

  const validated = validatePlaygroundRequest(state, questions);
  if (!validated.ok || validated.value === undefined) {
    return errorResponse("invalid_request", validated.errors.join("; "));
  }

  if (!isLlmConfigured()) return errorResponse("not_configured");

  try {
    const outcome = await evaluateWithLlm({
      state: validated.value.state,
      questions: validated.value.questions,
      signal: request.signal,
    });

    const payload: LiveEvaluationPayload = {
      source: "live",
      requestedModel: outcome.requestedModel,
      response: outcome.response,
      durationMs: Math.round(outcome.durationMs),
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof LlmEvaluationError) {
      console.error(`[evaluate-llm] failed: ${error.code}`);
      return errorResponse(error.code);
    }
    console.error("[evaluate-llm] unexpected failure");
    return errorResponse("internal_error");
  }
}

/** Anything other than POST. Kept explicit so a stray GET cannot spend money. */
export function GET(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "invalid_request",
        message: "Use POST to request an evaluation.",
      },
    }),
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}

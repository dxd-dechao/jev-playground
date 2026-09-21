/**
 * `POST /api/evaluate` — the only path to a real model call.
 *
 * The browser sends `{ scenarioId, state, questions }` and nothing else. Since
 * JEV-03 the questions are the reviewer's edited ones; they are validated here
 * as strictly as the State (shape, limits, duplicate ids and options) before
 * anything reaches the adapter, and the response is checked against exactly
 * those questions. Everything that carries authority stays here:
 *
 *  - The model and the provider URL come from the server environment. A client
 *    cannot name a model, redirect the call, or supply its own credentials.
 *  - The body is read under a hard byte cap, enforced while reading rather than
 *    trusting `Content-Length`.
 *  - Every validation failure happens *before* the SDK is touched, so a bad
 *    request is never a paid request.
 *  - The response is validated against the submitted questions before it is
 *    returned, and errors are fixed sanitized strings.
 */

import {
  ERROR_MESSAGES,
  ERROR_STATUS,
  EvaluationError,
  MAX_BODY_BYTES,
  evaluateSystemOne,
  isConfigured,
  resolveRequestedModel,
} from "@/lib/evaluation";
import { validateUpstreamResult } from "@/lib/evaluation-response";
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

function errorResponse(
  code: EvaluationErrorCode,
  detail?: string,
): Response {
  const payload: EvaluationErrorPayload = {
    error: { code, message: detail ? `${ERROR_MESSAGES[code]} ${detail}` : ERROR_MESSAGES[code] },
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
 * `Content-Length` is a claim, not a fact: a chunked or mis-declared body could
 * exceed the limit after passing a header check, so the running total is what
 * stops the read. The stream is cancelled rather than drained.
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

  // `JSON.parse` keeps the last of two equal keys, so a repeated question id or
  // Choice option would otherwise be dropped without a word. Refuse instead.
  const duplicates = findDuplicateRequestKeys(read.text);
  if (duplicates.length > 0) {
    return errorResponse(
      "invalid_request",
      duplicates.map(describeDuplicateKey).join("; "),
    );
  }

  // The body schema accepts only the known scenario ids, so an unknown one has
  // already been rejected above as an invalid request. The scenario id names
  // the playground slot; it no longer chooses the questions.
  const { state, questions } = body.value;

  // The client's own edited questions, validated here exactly as the browser
  // validated them. The values passed on are the parsed body itself, so the
  // request the browser displays is the request that is sent.
  const validated = validatePlaygroundRequest(state, questions);
  if (!validated.ok || validated.value === undefined) {
    return errorResponse("invalid_request", validated.errors.join("; "));
  }

  // Checked after validation so an invalid request reports its real problem
  // rather than a missing key, and so neither path reaches the SDK.
  if (!isConfigured()) return errorResponse("not_configured");

  try {
    const outcome = await evaluateSystemOne({
      state: validated.value.state,
      questions: validated.value.questions,
      signal: request.signal,
    });

    const checked = validateUpstreamResult(outcome.raw, validated.value.questions);
    if (!checked.ok || checked.value === undefined) {
      // The reasons are structural (ids, types, ranges) and quote no State, so
      // they are safe to log for a developer. They are not returned.
      console.error(
        "[evaluate] upstream response failed validation:",
        checked.errors.join("; "),
      );
      return errorResponse("upstream_malformed");
    }

    const payload: LiveEvaluationPayload = {
      source: "live",
      requestedModel: outcome.requestedModel,
      response: {
        // The model TypeSafe resolved, which may differ from the one requested.
        model: checked.value.model ?? outcome.requestedModel,
        answers: checked.value.answers,
        ...(checked.value.usage ? { usage: checked.value.usage } : {}),
      },
      durationMs: Math.round(outcome.durationMs),
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof EvaluationError) {
      // Code only. An upstream body or header could contain anything.
      console.error(`[evaluate] failed: ${error.code}`);
      return errorResponse(error.code);
    }
    console.error("[evaluate] unexpected failure");
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

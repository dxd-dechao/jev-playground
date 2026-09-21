/**
 * `POST /api/unlock` — set the playground session cookie.
 *
 * Accepts only `{ password }`. On success it sets an HttpOnly `jev_access`
 * cookie. It never reads `TYPESAFE_API_KEY` and never calls TypeSafe. A Next.js
 * route may only export handlers and the framework's own configuration keys.
 */

import {
  GATE_MISCONFIGURED_MESSAGE,
  MAX_UNLOCK_BODY_BYTES,
  UNAUTHORIZED_MESSAGE,
  UNLOCK_RATE_LIMIT_MESSAGE,
  buildAccessCookieHeaderFromEnv,
  isGateMisconfigured,
  isPasswordGateEnabled,
  isUnlockRateLimited,
  readCappedBody,
  recordUnlockFailure,
  submittedPasswordMatches,
  unlockClientBucket,
} from "@/lib/playground-gate";
import { validateUnlockBody } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "content-type": "application/json",
  "cache-control": "no-store, max-age=0",
} as const;

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...NO_STORE, ...extraHeaders },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse(status, { error: { code, message } });
}

export async function POST(request: Request): Promise<Response> {
  const read = await readCappedBody(request, MAX_UNLOCK_BODY_BYTES);
  if (!read.ok) {
    if (read.code === "payload_too_large") {
      return errorResponse(
        413,
        "payload_too_large",
        "The unlock request is larger than the 1 KiB limit.",
      );
    }
    return errorResponse(400, "invalid_request", "The request could not be read.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return errorResponse(400, "invalid_request", "The body is not valid JSON.");
  }

  const body = validateUnlockBody(parsed);
  if (!body.ok || body.value === undefined) {
    return errorResponse(400, "invalid_request", body.errors.join("; "));
  }

  if (isGateMisconfigured()) {
    return errorResponse(503, "gate_misconfigured", GATE_MISCONFIGURED_MESSAGE);
  }

  if (!isPasswordGateEnabled()) {
    return jsonResponse(200, { ok: true });
  }

  const bucket = unlockClientBucket(request);
  if (isUnlockRateLimited(bucket)) {
    return errorResponse(429, "too_many_attempts", UNLOCK_RATE_LIMIT_MESSAGE);
  }

  if (!submittedPasswordMatches(body.value.password)) {
    recordUnlockFailure(bucket);
    return errorResponse(401, "unauthorized", UNAUTHORIZED_MESSAGE);
  }

  const cookie = buildAccessCookieHeaderFromEnv();
  if (cookie === null) {
    return errorResponse(503, "gate_misconfigured", GATE_MISCONFIGURED_MESSAGE);
  }

  return jsonResponse(200, { ok: true }, { "set-cookie": cookie });
}

export function GET(): Response {
  return jsonResponse(
    405,
    {
      error: {
        code: "invalid_request",
        message: "Use POST to unlock Evaluate.",
      },
    },
    { allow: "POST" },
  );
}

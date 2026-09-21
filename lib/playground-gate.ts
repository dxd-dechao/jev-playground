/**
 * Server-only playground password gate.
 *
 * SERVER ONLY
 * -----------
 * This module reads `PLAYGROUND_PASSWORD` and `PLAYGROUND_SESSION_SECRET` and
 * mints an HMAC-signed session cookie. It must never be bundled into the
 * browser. The `server-only` package is not used because its default export
 * throws under plain Node, which would make this module untestable outside a
 * Next bundler — the same pattern as `lib/evaluation.ts`.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 * - The shared password is compared with `crypto.timingSafeEqual`. Length
 *   mismatches still run a dummy compare and return the same failure.
 * - A valid unlock sets an HttpOnly `jev_access` cookie signed with HMAC-SHA256.
 *   The session secret is never derived from the password.
 * - Unlock failures are rate-limited in memory: 5 per client IP per 15 minutes.
 *   This is per replica, not a security boundary.
 * - Nothing here calls TypeSafe or reads `TYPESAFE_API_KEY`.
 */

import * as crypto from "node:crypto";
import type { PlaygroundAccess } from "./types";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/playground-gate.ts is server-only: it reads PLAYGROUND_PASSWORD and " +
      "PLAYGROUND_SESSION_SECRET and must never be bundled into browser code.",
  );
}

export const COOKIE_NAME = "jev_access";
export const MAX_UNLOCK_BODY_BYTES = 1024;
export const UNLOCK_MAX_FAILURES = 5;
export const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const UNAUTHORIZED_MESSAGE =
  "Enter the playground password to evaluate with Jev.";
export const GATE_MISCONFIGURED_MESSAGE =
  "The playground password gate is not fully configured, so evaluation is locked.";
export const UNLOCK_RATE_LIMIT_MESSAGE =
  "Too many failed password attempts. Wait and try again.";

const COOKIE_PAYLOAD_PREFIX = "v1.";

export type BodyRead =
  | { ok: true; text: string }
  | { ok: false; code: "payload_too_large" | "invalid_request" };

/** Trimmed password, or null when the gate is off. */
function readPlaygroundPassword(): string | null {
  const raw = process.env.PLAYGROUND_PASSWORD;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Trimmed HMAC key, or null when it is missing. */
function readSessionSecret(): string | null {
  const raw = process.env.PLAYGROUND_SESSION_SECRET;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Whether a shared password is configured. Blank and unset both mean off. */
export function isPasswordGateEnabled(): boolean {
  return readPlaygroundPassword() !== null;
}

/**
 * Password is set but the session secret is not. Fail closed: unlock and
 * evaluate must not succeed, and the secret is never derived from the password.
 */
export function isGateMisconfigured(): boolean {
  return isPasswordGateEnabled() && readSessionSecret() === null;
}

/**
 * Compare two UTF-8 strings in roughly constant time. If the lengths differ, a
 * dummy compare still runs so the failure path is the same 401.
 */
export function passwordsMatch(submitted: string, expected: string): boolean {
  const submittedBuffer = Buffer.from(submitted);
  const expectedBuffer = Buffer.from(expected);
  if (submittedBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return crypto.timingSafeEqual(submittedBuffer, expectedBuffer);
}

/**
 * Trim both sides once (copy-paste) and compare against the configured password.
 * Returns false when the gate is off or misconfigured — callers decide the HTTP
 * status before using this.
 */
export function submittedPasswordMatches(submitted: string): boolean {
  const expected = readPlaygroundPassword();
  if (expected === null) return false;
  return passwordsMatch(submitted.trim(), expected);
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function signaturesMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Mint a signed cookie value. Exported so route tests can attach a valid cookie. */
export function mintAccessCookieValue(
  secret: string,
  issuedAt = Date.now(),
): string {
  const payload = `${COOKIE_PAYLOAD_PREFIX}${issuedAt}`;
  return `${payload}.${signPayload(payload, secret)}`;
}

export function verifyAccessCookieValue(
  value: string,
  secret: string,
  now = Date.now(),
): boolean {
  const lastDot = value.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  if (!payload.startsWith(COOKIE_PAYLOAD_PREFIX)) return false;
  const issuedAt = Number(payload.slice(COOKIE_PAYLOAD_PREFIX.length));
  if (!Number.isFinite(issuedAt)) return false;
  const age = now - issuedAt;
  if (age < 0 || age > SESSION_MAX_AGE_SECONDS * 1000) return false;
  const expected = signPayload(payload, secret);
  return signaturesMatch(signature, expected);
}

export function readNamedCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function hasValidAccessCookie(request: Request, now = Date.now()): boolean {
  const secret = readSessionSecret();
  if (secret === null) return false;
  const value = readNamedCookie(request, COOKIE_NAME);
  if (value === null) return false;
  return verifyAccessCookieValue(value, secret, now);
}

export function readAccess(request: Request): PlaygroundAccess {
  if (!isPasswordGateEnabled()) return "open";
  if (hasValidAccessCookie(request)) return "granted";
  return "required";
}

export function buildAccessCookieHeader(secret: string, now = Date.now()): string {
  const value = mintAccessCookieValue(secret, now);
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** Build the Set-Cookie header from the current environment, or null if locked-but-misconfigured. */
export function buildAccessCookieHeaderFromEnv(now = Date.now()): string | null {
  const secret = readSessionSecret();
  if (secret === null) return null;
  return buildAccessCookieHeader(secret, now);
}

/**
 * Unlock rate-limit bucket: Railway's first `x-forwarded-for` hop when present,
 * otherwise one in-process bucket for the whole replica.
 */
export function unlockClientBucket(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return "local";
}

const unlockFailures = new Map<string, number[]>();

function pruneFailures(bucket: string, now: number): number[] {
  const existing = unlockFailures.get(bucket) ?? [];
  const kept = existing.filter((stamp) => now - stamp < UNLOCK_WINDOW_MS);
  if (kept.length === 0) unlockFailures.delete(bucket);
  else unlockFailures.set(bucket, kept);
  return kept;
}

export function isUnlockRateLimited(bucket: string, now = Date.now()): boolean {
  return pruneFailures(bucket, now).length >= UNLOCK_MAX_FAILURES;
}

export function recordUnlockFailure(bucket: string, now = Date.now()): void {
  const kept = pruneFailures(bucket, now);
  kept.push(now);
  unlockFailures.set(bucket, kept);
}

/** Test seam: the in-memory limiter is per process and must not leak across tests. */
export function resetUnlockRateLimitsForTests(): void {
  unlockFailures.clear();
}

/**
 * Read a request body with the cap applied to bytes actually received, the same
 * style as `/api/evaluate`. `Content-Length` is a claim, not a fact.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number,
): Promise<BodyRead> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
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
      if (total > maxBytes) {
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

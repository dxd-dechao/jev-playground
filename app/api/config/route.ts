/**
 * `GET /api/config` — can Live mode be offered at all?
 *
 * Returns exactly `{ configured: boolean }`. Nothing else: no key fragment, no
 * key length, no account metadata, no model list, no environment dump.
 *
 * "Configured" means a nonempty `TYPESAFE_API_KEY` is present on the server. It
 * does not mean the key is valid, the account has quota, or TypeSafe is
 * reachable — verifying any of that would require a paid call, and a
 * configuration check must never make one.
 */

import { isConfigured } from "@/lib/evaluation";
import type { ConfigPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "content-type": "application/json",
  "cache-control": "no-store, max-age=0",
} as const;

export function GET(): Response {
  // A failure here must not take Live mode's *existence* down with it, and must
  // certainly not leak the reason. The browser treats a failed check as
  // "unknown" and keeps Fixture mode fully usable either way.
  let configured = false;
  try {
    configured = isConfigured();
  } catch {
    configured = false;
  }

  const payload: ConfigPayload = { configured };
  return new Response(JSON.stringify(payload), { status: 200, headers: NO_STORE });
}

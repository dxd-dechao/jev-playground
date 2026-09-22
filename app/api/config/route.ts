/**
 * `GET /api/config` — can Evaluate be offered, is a Moonshot key present, and
 * is the password gate on?
 *
 * Returns `{ configured, llmConfigured, access }`. Nothing else: no key
 * fragment, no password, no hash, no cookie value, no account metadata, no
 * model list, no environment dump.
 *
 * "Configured" means a nonempty `TYPESAFE_API_KEY` is present on the server.
 * `llmConfigured` means a nonempty `MOONSHOT_API_KEY` is present. Neither
 * means the key is valid or the service is reachable — verifying that would
 * require a paid call, and a configuration check must never make one.
 *
 * `access` is independent of both key flags: it is the playground password
 * gate, not a claim about either provider.
 */

import { isConfigured } from "@/lib/evaluation";
import { isLlmConfigured } from "@/lib/llm-evaluation";
import { readAccess } from "@/lib/playground-gate";
import type { ConfigPayload } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "content-type": "application/json",
  "cache-control": "no-store, max-age=0",
} as const;

export function GET(request: Request): Response {
  // A failure here must not take Evaluate's *existence* down with it, and must
  // certainly not leak the reason. The browser treats a failed check as
  // "unknown" and keeps editing usable either way.
  let configured = false;
  try {
    configured = isConfigured();
  } catch {
    configured = false;
  }

  let llmConfigured = false;
  try {
    llmConfigured = isLlmConfigured();
  } catch {
    llmConfigured = false;
  }

  const payload: ConfigPayload = {
    configured,
    llmConfigured,
    access: readAccess(request),
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: NO_STORE });
}

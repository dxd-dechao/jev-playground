/**
 * Deterministic hashing. Object keys are sorted recursively before hashing so
 * the same data always yields the same digest regardless of key order.
 */

import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with recursively sorted object keys. `undefined` members are dropped. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) sorted[key] = sortKeys(member);
    }
    return sorted;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

/**
 * A number in [0, 1) derived from `seed:key`. Used for split allocation, so it
 * depends only on the seed and the group ID — never on case order or labels.
 */
export function unitHash(seed: string, key: string): number {
  const hex = sha256(`${seed}:${key}`).slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

/** Locale-independent string ordering, so sorted output is the same everywhere. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

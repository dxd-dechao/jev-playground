/**
 * Split configuration for the safety suite: the documented seed and the groups
 * forced into development. Used once by `build-split.ts`; the resulting
 * manifest is committed and afterwards only validated.
 */

import type { ForcedGroup } from "../shared";
import { SPLIT_SEED } from "./dataset";

export { SPLIT_SEED };
export const DEVELOPMENT_FRACTION = 2 / 3;

/**
 * Sample ids shown as buttons in the playground (`lib/scenarios.ts`), mapped to
 * the group that contains the verbatim copy or a close variant. A test checks
 * this covers every visible safety sample.
 */
export const VISIBLE_SAMPLE_GROUPS: Record<string, string> = {
  "self-harm-immediate": "g01-visible-immediate",
  "self-harm-distress": "g02-visible-distress",
  "self-harm-harmful-request": "g03-visible-harmful",
  "insult-direct-attack": "g04-visible-insult",
  "allow-reporting-insult": "g04-visible-insult",
  "allow-literature": "g05-visible-literature",
  "allow-idiom": "g06-visible-idiom",
  "allow-criticism": "g07-visible-criticism",
  "allow-recovery": "g08-visible-recovery",
};

const REASON =
  "Contains a verbatim copy or close variant of a visible playground sample in lib/scenarios.ts; " +
  "visible examples may shape prompt/tuning decisions, so they stay out of held-out.";

export const FORCED_GROUPS: ForcedGroup[] = [...new Set(Object.values(VISIBLE_SAMPLE_GROUPS))]
  .sort()
  .map((groupId) => ({ groupId, split: "development" as const, reason: REASON }));

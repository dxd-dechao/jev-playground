/**
 * JEV-05 student-safety suite, loaded by `evaluation/cli.ts` by name.
 *
 * Reuses the preset's default safety questions and the existing
 * `composeSafetyRecommendation` unchanged. Requests are built only from the
 * whitelisted input fields via `buildSafetyRequest`.
 */

import { composeSafetyRecommendation } from "../../lib/safety-guardrails";
import { buildSafetyRequest, defaultQuestions, type SuiteDefinition } from "../shared";
import { loadSafetyDataset, loadSafetySplitManifest } from "./dataset";
import { scoreSafety } from "./score";
import type { SafetyCase } from "./types";

/**
 * Identifies the preset policy being evaluated: the unchanged default safety
 * questions in lib/scenarios.ts and composition in lib/safety-guardrails.ts,
 * as of the JEV-04/05 foundation commit. The questions hash is recorded
 * separately in every run manifest.
 */
export const SAFETY_POLICY_REVISION =
  "safety-preset-v1: lib/scenarios.ts default safety questions + lib/safety-guardrails.ts composeSafetyRecommendation (unchanged at 3bfaf25; targeted_insult not thresholded)";

export const suite: SuiteDefinition<SafetyCase> = {
  id: "safety",
  questions: defaultQuestions("safety"),
  policyRevision: SAFETY_POLICY_REVISION,
  loadDataset: loadSafetyDataset,
  loadSplitManifest: loadSafetySplitManifest,
  buildRequest: (c) => buildSafetyRequest(c.input),
  compose: composeSafetyRecommendation,
  score: scoreSafety,
};

/**
 * Municipal suite (JEV-04). Loaded by the CLI as `evaluation/municipal/index.ts`.
 *
 * - Dataset: the hash-verified 150-case snapshot, input = feedback only.
 * - Split: the committed `split-manifest.json` (never regenerated here).
 * - Requests: `buildMunicipalRequest` with the preset's unchanged questions.
 * - Composition: the existing `composeMunicipalRouting`, unchanged.
 */

import { AGENCY_TAXONOMY_VERSION } from "../../lib/agency-definitions";
import { composeMunicipalRouting } from "../../lib/municipal-routing";
import { buildMunicipalRequest, defaultQuestions, readJson, type SplitManifest, type SuiteDefinition } from "../shared";
import { loadMunicipalDataset, SPLIT_MANIFEST_PATH, type MunicipalCase } from "./dataset";
import { scoreMunicipal } from "./score";

export type { MunicipalCase } from "./dataset";

export function loadMunicipalSplitManifest(): SplitManifest {
  return readJson<SplitManifest>(SPLIT_MANIFEST_PATH);
}

export const suite: SuiteDefinition<MunicipalCase> = {
  id: "municipal",
  questions: defaultQuestions("municipal"),
  policyRevision: `agency-taxonomy:${AGENCY_TAXONOMY_VERSION}`,
  loadDataset: loadMunicipalDataset,
  loadSplitManifest: loadMunicipalSplitManifest,
  buildRequest: (c) => buildMunicipalRequest(c.input),
  compose: composeMunicipalRouting,
  score: scoreMunicipal,
};

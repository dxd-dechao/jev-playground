/**
 * One-time split builder for the safety suite.
 *
 *   npx vite-node evaluation/safety/build-split.ts [output-path]
 *
 * Default output is `evaluation/safety/split-manifest.json`. Run once, review,
 * commit. Scoring and preparation only read and validate the committed file.
 * Re-run only when cases or groups change (bump `datasetVersion` first).
 */

import { buildSplitManifest, writeJson } from "../shared";
import { loadSafetyDataset, safetyFilePath, SAFETY_FILES } from "./dataset";
import { DEVELOPMENT_FRACTION, FORCED_GROUPS, SPLIT_SEED } from "./split-config";

const out = process.argv.slice(2).filter((a) => a !== "--")[0] ?? safetyFilePath(SAFETY_FILES.split);
const manifest = buildSplitManifest(loadSafetyDataset(), {
  seed: SPLIT_SEED,
  developmentFraction: DEVELOPMENT_FRACTION,
  forcedGroups: FORCED_GROUPS,
});
writeJson(out, manifest);
console.log(
  `Wrote ${out}: development ${manifest.counts.development.groups} groups / ${manifest.counts.development.cases} cases; ` +
    `heldout ${manifest.counts.heldout.groups} groups / ${manifest.counts.heldout.cases} cases`,
);

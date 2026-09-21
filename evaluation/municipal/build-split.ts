/**
 * One-off: build the municipal split manifest. Run once by the suite author;
 * the resulting JSON is reviewed and committed as `split-manifest.json`.
 * Scoring and preparation only ever *validate* the committed file.
 *
 *   npx vite-node evaluation/municipal/build-split.ts [--out <file>]
 *
 * Default output is the committed path. The seed, development fraction, and
 * forced groups are fixed in `groups.ts` so the build is reproducible.
 */

import { buildSplitManifest, DEFAULT_DEVELOPMENT_FRACTION, writeJson } from "../shared";
import { loadMunicipalDataset, SPLIT_MANIFEST_PATH } from "./dataset";
import { FORCED_GROUPS, SPLIT_SEED } from "./groups";

const outIndex = process.argv.indexOf("--out");
const out = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1]! : SPLIT_MANIFEST_PATH;

const manifest = buildSplitManifest(loadMunicipalDataset(), {
  seed: SPLIT_SEED,
  developmentFraction: DEFAULT_DEVELOPMENT_FRACTION,
  forcedGroups: FORCED_GROUPS,
});
writeJson(out, manifest);
console.log(
  `municipal split: development ${manifest.counts.development.cases} cases / ${manifest.counts.development.groups} groups, ` +
    `heldout ${manifest.counts.heldout.cases} cases / ${manifest.counts.heldout.groups} groups → ${out}`,
);

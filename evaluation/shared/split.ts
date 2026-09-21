/**
 * Deterministic, group-aware development / held-out split.
 *
 * Allocation: a group goes to development when `unitHash(seed, groupId)` is
 * below `developmentFraction` (default 2/3), otherwise held-out — unless the
 * suite forces it with a recorded reason. Every case in a group shares the
 * group's split, so paired and near-duplicate cases never straddle the line.
 *
 * The manifest is built once, committed, and afterwards only validated.
 * Synthetic held-out cases are held out from tuning; they are not independent
 * real-world validation.
 */

import { compareIds, hashJson, unitHash } from "./hash";
import type {
  Dataset,
  EvalCase,
  ForcedGroup,
  SplitAssignment,
  SplitManifest,
  SplitName,
} from "./types";
import { SPLIT_NAMES } from "./types";

export const DEFAULT_DEVELOPMENT_FRACTION = 2 / 3;

export const SPLIT_METHOD =
  "group-level: development iff forced, else sha256(`${seed}:${groupId}`)[0:8]/2^32 < developmentFraction";

/** Hash of sorted (caseId, groupId) pairs: what the split depends on. */
export function membershipHash(cases: readonly Pick<EvalCase, "id" | "groupId">[]): string {
  return hashJson(
    [...cases]
      .sort((a, b) => compareIds(a.id, b.id))
      .map((c) => [c.id, c.groupId]),
  );
}

export function allocateGroup(
  seed: string,
  groupId: string,
  developmentFraction: number,
  forced: readonly ForcedGroup[],
): SplitName {
  const override = forced.find((f) => f.groupId === groupId);
  if (override) return override.split;
  return unitHash(seed, groupId) < developmentFraction ? "development" : "heldout";
}

export interface BuildSplitOptions {
  seed: string;
  developmentFraction?: number;
  forcedGroups?: ForcedGroup[];
}

export function buildSplitManifest(dataset: Dataset, options: BuildSplitOptions): SplitManifest {
  const developmentFraction = options.developmentFraction ?? DEFAULT_DEVELOPMENT_FRACTION;
  const forcedGroups = [...(options.forcedGroups ?? [])].sort((a, b) =>
    compareIds(a.groupId, b.groupId),
  );
  const groupIds = new Set(dataset.cases.map((c) => c.groupId));
  for (const forced of forcedGroups) {
    if (!groupIds.has(forced.groupId)) {
      throw new Error(`Forced group ${forced.groupId} does not exist in the dataset`);
    }
  }

  const assignments: SplitAssignment[] = [...dataset.cases]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((c) => ({
      caseId: c.id,
      groupId: c.groupId,
      split: allocateGroup(options.seed, c.groupId, developmentFraction, forcedGroups),
    }));

  return {
    schemaVersion: 1,
    suite: dataset.suite,
    datasetVersion: dataset.datasetVersion,
    membershipHash: membershipHash(dataset.cases),
    seed: options.seed,
    method: SPLIT_METHOD,
    developmentFraction,
    forcedGroups,
    assignments,
    counts: computeCounts(assignments),
    sliceCoverage: computeSliceCoverage(dataset.cases, assignments),
  };
}

function computeCounts(assignments: readonly SplitAssignment[]): SplitManifest["counts"] {
  const counts = {
    development: { groups: 0, cases: 0 },
    heldout: { groups: 0, cases: 0 },
  };
  const groups: Record<SplitName, Set<string>> = { development: new Set(), heldout: new Set() };
  for (const a of assignments) {
    counts[a.split].cases += 1;
    groups[a.split].add(a.groupId);
  }
  counts.development.groups = groups.development.size;
  counts.heldout.groups = groups.heldout.size;
  return counts;
}

function computeSliceCoverage(
  cases: readonly EvalCase[],
  assignments: readonly SplitAssignment[],
): SplitManifest["sliceCoverage"] {
  const splitOf = new Map(assignments.map((a) => [a.caseId, a.split]));
  const coverage: SplitManifest["sliceCoverage"] = {};
  const slices = [...new Set(cases.flatMap((c) => c.slices))].sort();
  for (const slice of slices) coverage[slice] = { development: 0, heldout: 0 };
  for (const c of cases) {
    const split = splitOf.get(c.id);
    if (!split) continue;
    for (const slice of c.slices) {
      const entry = coverage[slice];
      if (entry) entry[split] += 1;
    }
  }
  return coverage;
}

/**
 * Every problem between a committed manifest and the current dataset: unknown
 * or missing IDs, duplicates, group conflicts, overlap, stale hashes, and any
 * assignment that the documented rule would not reproduce.
 */
export function validateSplitManifest(manifest: SplitManifest, dataset: Dataset): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push("split manifest: unsupported schemaVersion");
  if (manifest.suite !== dataset.suite) errors.push(`split manifest: suite ${manifest.suite} != dataset ${dataset.suite}`);
  if (manifest.datasetVersion !== dataset.datasetVersion) {
    errors.push(`split manifest: datasetVersion ${manifest.datasetVersion} != dataset ${dataset.datasetVersion}`);
  }
  if (manifest.membershipHash !== membershipHash(dataset.cases)) {
    errors.push("split manifest: membershipHash does not match the dataset's (caseId, groupId) pairs");
  }

  const datasetGroup = new Map(dataset.cases.map((c) => [c.id, c.groupId]));
  const seen = new Map<string, SplitName>();
  const groupSplit = new Map<string, SplitName>();
  for (const a of manifest.assignments) {
    if (!SPLIT_NAMES.includes(a.split)) errors.push(`split manifest: ${a.caseId} has unknown split ${String(a.split)}`);
    const previous = seen.get(a.caseId);
    if (previous !== undefined) {
      errors.push(
        previous === a.split
          ? `split manifest: duplicate case ${a.caseId}`
          : `split manifest: case ${a.caseId} appears in both splits (overlap)`,
      );
    }
    seen.set(a.caseId, a.split);
    const expectedGroup = datasetGroup.get(a.caseId);
    if (expectedGroup === undefined) {
      errors.push(`split manifest: unknown case ${a.caseId}`);
    } else if (expectedGroup !== a.groupId) {
      errors.push(`split manifest: case ${a.caseId} is in group ${a.groupId}, dataset says ${expectedGroup}`);
    }
    const groupPrevious = groupSplit.get(a.groupId);
    if (groupPrevious !== undefined && groupPrevious !== a.split) {
      errors.push(`split manifest: group ${a.groupId} is assigned to both splits`);
    }
    groupSplit.set(a.groupId, a.split);
  }
  for (const id of datasetGroup.keys()) {
    if (!seen.has(id)) errors.push(`split manifest: case ${id} is missing`);
  }
  for (const [groupId, split] of groupSplit) {
    const expected = allocateGroup(manifest.seed, groupId, manifest.developmentFraction, manifest.forcedGroups);
    if (expected !== split) {
      errors.push(`split manifest: group ${groupId} is ${split}, but the documented rule gives ${expected}`);
    }
  }
  const counts = computeCounts(manifest.assignments);
  if (hashJson(counts) !== hashJson(manifest.counts)) {
    errors.push("split manifest: recorded counts do not match the assignments");
  }
  if (hashJson(computeSliceCoverage(dataset.cases, manifest.assignments)) !== hashJson(manifest.sliceCoverage)) {
    errors.push("split manifest: recorded slice coverage does not match the dataset");
  }
  return errors;
}

export function assertValidSplitManifest(manifest: SplitManifest, dataset: Dataset): void {
  const errors = validateSplitManifest(manifest, dataset);
  if (errors.length > 0) {
    throw new Error(`Invalid ${dataset.suite} split manifest:\n- ${errors.join("\n- ")}`);
  }
}

/** Sorted case IDs in one split. */
export function selectSplit(manifest: SplitManifest, split: SplitName): string[] {
  return manifest.assignments
    .filter((a) => a.split === split)
    .map((a) => a.caseId)
    .sort(compareIds);
}

/** Hash of a split manifest's contents, recorded in every run manifest. */
export function splitManifestHash(manifest: SplitManifest): string {
  return hashJson(manifest);
}

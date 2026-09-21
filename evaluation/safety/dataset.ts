/**
 * Loads the committed safety cases, labels, provenance, and split manifest.
 *
 * - `cases.json` holds the model-visible input only (plus id, group, slices).
 * - `labels.json` holds the labels and reviewer notes, keyed by case id.
 * - `provenance.json` records who authored the cases and the SHA-256 of the
 *   committed `cases.json` bytes. `sourceHash` is that digest, verified on
 *   every load. Labels live in a separate file so recording a human review
 *   changes neither `sourceHash` nor `inputHash`, and earlier predictions stay
 *   scoreable.
 * - `split-manifest.json` is built once by `build-split.ts` and only read here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertValidDataset, sha256, type Dataset, type SplitManifest } from "../shared";
import {
  CATEGORY_CONTEXTS,
  CATEGORY_HANDLING,
  REACHABLE_CONTEXTS,
  SAFETY_CATEGORIES,
  SAFETY_RECOMMENDATIONS,
  SAFETY_SELF_HARM_OPTIONS,
  type SafetyCase,
  type SafetyLabels,
} from "./types";

export const SAFETY_FILES = {
  cases: "cases.json",
  labels: "labels.json",
  provenance: "provenance.json",
  split: "split-manifest.json",
} as const;

export const SPLIT_SEED = "jev-05-safety-split-v1";

export function safetyFilePath(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export interface SafetyProvenance {
  schemaVersion: 1;
  datasetVersion: string;
  origin: string;
  authoredBy: string;
  authoredOn: string;
  reviewStatus: string;
  casesFile: string;
  casesSha256: string;
  labelsFile: string;
  description: string;
  constraints: string[];
}

interface CasesFile {
  schemaVersion: 1;
  suite: "safety";
  datasetVersion: string;
  cases: { id: string; groupId: string; slices: string[]; input: Record<string, unknown> }[];
}

interface LabelsFile {
  schemaVersion: 1;
  suite: "safety";
  datasetVersion: string;
  labels: Record<string, { labels: SafetyLabels; notes?: string }>;
}

const INPUT_KEYS = new Set(["student_message", "conversation_history", "learning_context"]);

/** Safety-specific problems beyond the shared structural validation. */
export function validateSafetyCases(cases: readonly SafetyCase[]): string[] {
  const errors: string[] = [];
  for (const c of cases) {
    const extra = Object.keys(c.input).filter((k) => !INPUT_KEYS.has(k));
    if (extra.length > 0) errors.push(`${c.id}: input has non-whitelisted keys ${extra.join(", ")}`);
    if (typeof c.input.student_message !== "string" || c.input.student_message.trim() === "") {
      errors.push(`${c.id}: input.student_message is required`);
    }
    if (typeof c.input.learning_context !== "string" || c.input.learning_context.trim() === "") {
      errors.push(`${c.id}: input.learning_context is required`);
    }
    const { self_harm_context: shc, handling, category } = c.labels;
    if (shc && !SAFETY_SELF_HARM_OPTIONS.includes(shc.value)) {
      errors.push(`${c.id}: self_harm_context ${String(shc.value)} is not a defined option`);
    }
    if (handling && !SAFETY_RECOMMENDATIONS.includes(handling.value)) {
      errors.push(`${c.id}: handling ${String(handling.value)} is not a composed outcome`);
    }
    if (category && !SAFETY_CATEGORIES.includes(category.value)) {
      errors.push(`${c.id}: category ${String(category.value)} is not defined`);
    }
    if (category && handling && CATEGORY_HANDLING[category.value] !== handling.value) {
      errors.push(`${c.id}: category ${category.value} implies handling ${CATEGORY_HANDLING[category.value]}, not ${handling.value}`);
    }
    if (handling && shc && !REACHABLE_CONTEXTS[handling.value]?.includes(shc.value)) {
      errors.push(`${c.id}: existing composition cannot reach ${handling.value} from self_harm_context ${shc.value}`);
    }
    if (category && shc && !CATEGORY_CONTEXTS[category.value]?.includes(shc.value)) {
      errors.push(`${c.id}: category ${category.value} is inconsistent with self_harm_context ${shc.value}`);
    }
  }
  return errors;
}

/** Joins case and label files; throws on any mismatch. Pure for testing. */
export function assembleSafetyDataset(
  casesBytes: Uint8Array | string,
  labelsText: string,
  provenance: SafetyProvenance,
): Dataset<SafetyCase> {
  const digest = sha256(casesBytes);
  if (digest !== provenance.casesSha256) {
    throw new Error(
      `safety ${SAFETY_FILES.cases} SHA-256 ${digest} does not match provenance.casesSha256 ${provenance.casesSha256}`,
    );
  }
  const casesFile = JSON.parse(typeof casesBytes === "string" ? casesBytes : new TextDecoder().decode(casesBytes)) as CasesFile;
  const labelsFile = JSON.parse(labelsText) as LabelsFile;
  const errors: string[] = [];
  if (casesFile.datasetVersion !== provenance.datasetVersion) errors.push("cases.json datasetVersion differs from provenance");
  if (labelsFile.datasetVersion !== provenance.datasetVersion) errors.push("labels.json datasetVersion differs from provenance");
  const labelIds = new Set(Object.keys(labelsFile.labels));
  const cases: SafetyCase[] = casesFile.cases.map((raw) => {
    const entry = labelsFile.labels[raw.id];
    if (!entry) errors.push(`${raw.id}: no entry in labels.json`);
    labelIds.delete(raw.id);
    const evalCase: SafetyCase = {
      id: raw.id,
      suite: "safety",
      groupId: raw.groupId,
      slices: raw.slices,
      input: raw.input as unknown as SafetyCase["input"],
      labels: entry?.labels ?? {},
    };
    if (entry?.notes !== undefined) evalCase.notes = entry.notes;
    return evalCase;
  });
  for (const orphan of labelIds) errors.push(`labels.json has labels for unknown case ${orphan}`);
  errors.push(...validateSafetyCases(cases));
  if (errors.length > 0) throw new Error(`Invalid safety dataset:\n- ${errors.join("\n- ")}`);

  const dataset: Dataset<SafetyCase> = {
    suite: "safety",
    datasetVersion: provenance.datasetVersion,
    source: `${provenance.origin}; authored by ${provenance.authoredBy} on ${provenance.authoredOn}; ${provenance.reviewStatus}`,
    sourceHash: digest,
    cases,
  };
  assertValidDataset(dataset, "safety");
  return dataset;
}

export function loadSafetyProvenance(): SafetyProvenance {
  return JSON.parse(readFileSync(safetyFilePath(SAFETY_FILES.provenance), "utf8")) as SafetyProvenance;
}

export function loadSafetyDataset(): Dataset<SafetyCase> {
  return assembleSafetyDataset(
    readFileSync(safetyFilePath(SAFETY_FILES.cases)),
    readFileSync(safetyFilePath(SAFETY_FILES.labels), "utf8"),
    loadSafetyProvenance(),
  );
}

/** The committed manifest, read as-is. Never regenerated here. */
export function loadSafetySplitManifest(): SplitManifest {
  return JSON.parse(readFileSync(safetyFilePath(SAFETY_FILES.split), "utf8")) as SplitManifest;
}

/**
 * Dataset validation and the hashes that bind predictions to their inputs.
 *
 * `inputHash` covers only what the model sees, so recording a human label
 * review (which changes `labelsHash`) does not invalidate earlier predictions.
 */

import { compareIds, hashJson } from "./hash";
import type {
  CaseLabels,
  Dataset,
  EvalCase,
  LabelField,
  LabelProvenance,
  LabelReview,
  SuiteId,
} from "./types";
import { LABEL_PROVENANCES } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Problems with one label field; empty when valid. */
export function validateLabelField(field: unknown, label: string): string[] {
  if (field === undefined) return [];
  if (!isRecord(field)) return [`${label}: must be a label object`];
  const errors: string[] = [];
  if (!("value" in field)) errors.push(`${label}: missing value`);
  const provenance = field.provenance;
  if (!LABEL_PROVENANCES.includes(provenance as LabelProvenance)) {
    errors.push(`${label}: provenance must be one of ${LABEL_PROVENANCES.join(", ")}`);
    return errors;
  }
  if (provenance === "reviewed") {
    const review = field.review;
    if (!isRecord(review)) {
      errors.push(`${label}: reviewed labels require review {reviewer, reviewedOn}`);
    } else {
      if (typeof review.reviewer !== "string" || review.reviewer.trim() === "") {
        errors.push(`${label}: review.reviewer must name a real reviewer`);
      }
      if (typeof review.reviewedOn !== "string" || !ISO_DATE.test(review.reviewedOn)) {
        errors.push(`${label}: review.reviewedOn must be YYYY-MM-DD`);
      }
    }
  } else if (field.review !== undefined) {
    errors.push(`${label}: only reviewed labels may carry review metadata`);
  }
  if (provenance === "inherited_reference") {
    if (typeof field.source !== "string" || field.source.trim() === "") {
      errors.push(`${label}: inherited_reference labels must name their source`);
    }
  }
  return errors;
}

/** All structural problems in a dataset; empty when valid. */
export function validateDataset(dataset: Dataset, suite: SuiteId): string[] {
  const errors: string[] = [];
  if (dataset.suite !== suite) errors.push(`dataset.suite is ${dataset.suite}, expected ${suite}`);
  if (!dataset.datasetVersion) errors.push("dataset.datasetVersion is required");
  if (!/^[0-9a-f]{64}$/.test(dataset.sourceHash)) errors.push("dataset.sourceHash must be a SHA-256 hex digest");
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    errors.push("dataset.cases must be a non-empty array");
    return errors;
  }
  const seen = new Set<string>();
  for (const [index, evalCase] of dataset.cases.entries()) {
    const at = `cases[${index}]`;
    if (typeof evalCase.id !== "string" || evalCase.id === "") {
      errors.push(`${at}: id is required`);
      continue;
    }
    if (seen.has(evalCase.id)) errors.push(`${at}: duplicate id ${evalCase.id}`);
    seen.add(evalCase.id);
    if (evalCase.suite !== suite) errors.push(`${evalCase.id}: suite must be ${suite}`);
    if (typeof evalCase.groupId !== "string" || evalCase.groupId === "") {
      errors.push(`${evalCase.id}: groupId is required`);
    }
    if (!Array.isArray(evalCase.slices) || !evalCase.slices.every((s) => typeof s === "string")) {
      errors.push(`${evalCase.id}: slices must be an array of strings`);
    }
    if (!isRecord(evalCase.input)) errors.push(`${evalCase.id}: input must be an object`);
    if (!isRecord(evalCase.labels)) {
      errors.push(`${evalCase.id}: labels must be an object`);
      continue;
    }
    for (const [name, field] of Object.entries(evalCase.labels)) {
      errors.push(...validateLabelField(field, `${evalCase.id}.labels.${name}`));
    }
  }
  return errors;
}

export function assertValidDataset(dataset: Dataset, suite: SuiteId): void {
  const errors = validateDataset(dataset, suite);
  if (errors.length > 0) {
    throw new Error(`Invalid ${suite} dataset:\n- ${errors.join("\n- ")}`);
  }
}

/** Hash of (caseId, input) pairs, sorted by caseId. */
export function inputHash(cases: readonly EvalCase[]): string {
  return hashJson(
    [...cases]
      .sort((a, b) => compareIds(a.id, b.id))
      .map((c) => ({ id: c.id, input: c.input })),
  );
}

/** Hash of (caseId, labels) pairs, sorted by caseId. */
export function labelsHash(cases: readonly EvalCase[]): string {
  return hashJson(
    [...cases]
      .sort((a, b) => compareIds(a.id, b.id))
      .map((c) => ({ id: c.id, labels: c.labels })),
  );
}

export type LabelInventory = Record<string, Record<LabelProvenance | "absent", number>>;

/** Count, per label field, how many cases carry each provenance. */
export function labelInventory(cases: readonly EvalCase<unknown, CaseLabels>[]): LabelInventory {
  const fields = new Set<string>();
  for (const c of cases) for (const name of Object.keys(c.labels)) fields.add(name);
  const inventory: LabelInventory = {};
  for (const name of [...fields].sort()) {
    const counts = { inherited_reference: 0, proposed: 0, reviewed: 0, absent: 0 };
    for (const c of cases) {
      const field = c.labels[name];
      if (field === undefined) counts.absent += 1;
      else counts[field.provenance] += 1;
    }
    inventory[name] = counts;
  }
  return inventory;
}

/** True only for a label a named human reviewer has checked. */
export function isReviewed<T>(
  field: LabelField<T> | undefined,
): field is LabelField<T> & { provenance: "reviewed"; review: LabelReview } {
  return field !== undefined && field.provenance === "reviewed" && field.review !== undefined;
}

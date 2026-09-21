/**
 * Municipal adapter: the committed source snapshot → `Dataset<MunicipalCase>`.
 *
 * Only `text` becomes model-visible input (as `feedback`). `primary_agency`
 * and `acceptable_agencies` are carried as `inherited_reference` labels that
 * name the snapshot. `tag` and `primary_agency` become report slices. The
 * source's categories, priority, and follow-up flags are not used; `note` and
 * `expected_behavior` are kept only as reviewer notes, which never reach State.
 *
 * Disposition labels come from a separate annotation file and are merged into
 * `labels.disposition` only when an entry has a value.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENCY_OPTIONS } from "../../lib/agency-definitions";
import { MUNICIPAL_DISPOSITION_OPTIONS, type MunicipalDisposition } from "../../lib/scenarios";
import {
  assertValidDataset,
  sha256,
  type Dataset,
  type EvalCase,
  type LabelField,
  type LabelReview,
  type MunicipalInput,
} from "../shared";
import { groupIdFor } from "./groups";

export type MunicipalLabels = {
  primary_agency?: LabelField<string>;
  acceptable_agencies?: LabelField<string[]>;
  disposition?: LabelField<MunicipalDisposition>;
};

export type MunicipalCase = EvalCase<MunicipalInput, MunicipalLabels>;

export const MUNICIPAL_DATASET_VERSION = "municipal-q3-150-v1";
export const SNAPSHOT_RELATIVE_PATH = "evaluation/municipal/source/test_cases.json";
export const LABEL_SOURCE =
  `${SNAPSHOT_RELATIVE_PATH} (copy of DS Interview Q3/question-3/evaluation/test_cases.json; ` +
  "single-source synthetic reference, not independently reviewed)";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export const SNAPSHOT_PATH = here("./source/test_cases.json");
export const PROVENANCE_PATH = here("./source/provenance.json");
export const DISPOSITION_LABELS_PATH = here("./disposition-labels.json");
export const SPLIT_MANIFEST_PATH = here("./split-manifest.json");

/* ------------------------------------------------------------ Source -- */

export interface SourceCase {
  id: string;
  text: string;
  primary_agency: string;
  acceptable_agencies: string[];
  tag: string;
  note?: string;
  expected_behavior?: string;
  [other: string]: unknown;
}

export interface SourceFile {
  meta: Record<string, unknown>;
  cases: SourceCase[];
}

export interface SnapshotProvenance {
  sha256: string;
  originalPath: string;
  readOn: string;
  caseCount: number;
  [other: string]: unknown;
}

/** Read the snapshot and refuse it if its bytes no longer match the recorded hash. */
export function readVerifiedSnapshot(): { bytes: Buffer; hash: string; source: SourceFile } {
  const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as SnapshotProvenance;
  const bytes = readFileSync(SNAPSHOT_PATH);
  const hash = sha256(bytes);
  if (hash !== provenance.sha256) {
    throw new Error(
      `Municipal source snapshot hash ${hash} does not match the recorded ${provenance.sha256}. ` +
        "The snapshot must stay a byte-for-byte copy of the original.",
    );
  }
  return { bytes, hash, source: JSON.parse(bytes.toString("utf8")) as SourceFile };
}

/* ------------------------------------------------------- Dispositions -- */

export interface DispositionEntry {
  caseId: string;
  value: MunicipalDisposition | null;
  provenance: "proposed" | "reviewed";
  rationale?: string;
  review?: LabelReview;
  /** Kept by a reviewer who changed the value. Not copied into labels. */
  proposedValue?: MunicipalDisposition;
}

export interface DispositionFile {
  schemaVersion: 1;
  field: "disposition";
  definitions: Record<MunicipalDisposition, string>;
  labels: DispositionEntry[];
  [other: string]: unknown;
}

export function readDispositionFile(path = DISPOSITION_LABELS_PATH): DispositionFile {
  return JSON.parse(readFileSync(path, "utf8")) as DispositionFile;
}

/** Turn annotation entries into label fields; entries without a value are skipped. */
export function dispositionLabels(
  file: Pick<DispositionFile, "labels">,
  knownIds: ReadonlySet<string>,
): Map<string, LabelField<MunicipalDisposition>> {
  const result = new Map<string, LabelField<MunicipalDisposition>>();
  for (const entry of file.labels) {
    if (!knownIds.has(entry.caseId)) throw new Error(`Disposition label for unknown case ${entry.caseId}`);
    if (result.has(entry.caseId)) throw new Error(`Duplicate disposition label for ${entry.caseId}`);
    if (entry.value === null || entry.value === undefined) continue;
    if (!MUNICIPAL_DISPOSITION_OPTIONS.includes(entry.value)) {
      throw new Error(`${entry.caseId}: disposition ${String(entry.value)} is not a defined option`);
    }
    if (entry.provenance !== "proposed" && entry.provenance !== "reviewed") {
      throw new Error(`${entry.caseId}: disposition provenance must be proposed or reviewed`);
    }
    const field: LabelField<MunicipalDisposition> = { value: entry.value, provenance: entry.provenance };
    if (entry.rationale !== undefined) field.rationale = entry.rationale;
    if (entry.review !== undefined) field.review = entry.review;
    result.set(entry.caseId, field);
  }
  return result;
}

/* ------------------------------------------------------------ Adapter -- */

export function sliceTag(tag: string): string {
  return `tag:${tag}`;
}
export function sliceAgency(agency: string): string {
  return `agency:${agency}`;
}

function caseNotes(c: SourceCase): string | undefined {
  const parts: string[] = [];
  if (typeof c.note === "string") parts.push(`Source note: ${c.note}`);
  if (typeof c.expected_behavior === "string") parts.push(`Source expected_behavior: ${c.expected_behavior}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** Pure adaptation of source cases; used by `loadMunicipalDataset` and tests. */
export function adaptMunicipalSource(
  source: SourceFile,
  sourceHash: string,
  dispositions: Pick<DispositionFile, "labels"> = { labels: [] },
): Dataset<MunicipalCase> {
  const knownIds = new Set(source.cases.map((c) => c.id));
  const disposition = dispositionLabels(dispositions, knownIds);
  const cases = source.cases.map((c): MunicipalCase => {
    if (!AGENCY_OPTIONS.includes(c.primary_agency)) {
      throw new Error(`${c.id}: primary_agency ${c.primary_agency} is not a configured option`);
    }
    for (const agency of c.acceptable_agencies) {
      if (!AGENCY_OPTIONS.includes(agency)) throw new Error(`${c.id}: acceptable agency ${agency} is not a configured option`);
    }
    if (!c.acceptable_agencies.includes(c.primary_agency)) {
      throw new Error(`${c.id}: primary_agency is not among acceptable_agencies`);
    }
    const labels: MunicipalLabels = {
      primary_agency: { value: c.primary_agency, provenance: "inherited_reference", source: LABEL_SOURCE },
      acceptable_agencies: {
        value: [...c.acceptable_agencies],
        provenance: "inherited_reference",
        source: LABEL_SOURCE,
      },
    };
    const d = disposition.get(c.id);
    if (d) labels.disposition = d;
    const evalCase: MunicipalCase = {
      id: c.id,
      suite: "municipal",
      groupId: groupIdFor(c.id),
      slices: [sliceTag(c.tag), sliceAgency(c.primary_agency)],
      // Input whitelist: the feedback text only.
      input: { feedback: c.text },
      labels,
    };
    const notes = caseNotes(c);
    if (notes !== undefined) evalCase.notes = notes;
    return evalCase;
  });
  return {
    suite: "municipal",
    datasetVersion: MUNICIPAL_DATASET_VERSION,
    source:
      "DS Interview Q3/question-3/evaluation/test_cases.json (150 hand-authored synthetic cases), " +
      `snapshotted at ${SNAPSHOT_RELATIVE_PATH} on 2026-09-21`,
    sourceHash,
    cases,
  };
}

/** Load the municipal dataset from the committed, hash-verified snapshot. */
export function loadMunicipalDataset(): Dataset<MunicipalCase> {
  const { hash, source } = readVerifiedSnapshot();
  const dataset = adaptMunicipalSource(source, hash, readDispositionFile());
  assertValidDataset(dataset, "municipal");
  return dataset;
}

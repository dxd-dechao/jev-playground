/**
 * Shared evaluation contract for the offline municipal (JEV-04) and student
 * safety (JEV-05) suites.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * A case's `input` and its `labels` are separate objects, and only `input`
 * can reach a request. IDs, slices, group IDs, expected labels, reviewer
 * metadata, and notes never enter State. See `requests.ts`.
 *
 * Nothing in `evaluation/shared/` creates a TypeSafe client, reads an API
 * credential, or imports `lib/evaluation.ts`. A live adapter is JEV-06's job
 * and is injected into `runCases` as a plain function.
 */

import type {
  Answers,
  EvaluationRequest,
  EvaluationResponse,
  Questions,
  Usage,
} from "../../lib/types";

export type SuiteId = "municipal" | "safety";
export const SUITE_IDS: readonly SuiteId[] = ["municipal", "safety"];

export type SplitName = "development" | "heldout";
export const SPLIT_NAMES: readonly SplitName[] = ["development", "heldout"];

/* ------------------------------------------------------------- Labels -- */

/**
 * Where a label value came from. Field-specific: one case can carry an
 * inherited agency label next to a proposed disposition label.
 *
 * - `inherited_reference` — copied from an existing source (e.g. the interview
 *   test set). Single-source; not freshly reviewed for this project.
 * - `proposed` — authored by an agent or a person for this project and not yet
 *   reviewed by anyone else.
 * - `reviewed` — a named human reviewer checked the value on a stated date.
 *   An agent can never mark its own proposal reviewed.
 */
export type LabelProvenance = "inherited_reference" | "proposed" | "reviewed";
export const LABEL_PROVENANCES: readonly LabelProvenance[] = [
  "inherited_reference",
  "proposed",
  "reviewed",
];

export interface LabelReview {
  /** A real reviewer's name or handle. Never an agent, never invented. */
  reviewer: string;
  /** ISO calendar date, YYYY-MM-DD. */
  reviewedOn: string;
  note?: string;
}

export interface LabelField<T> {
  value: T;
  provenance: LabelProvenance;
  /** Required for `inherited_reference`: what it was inherited from. */
  source?: string;
  /** Why this value; recommended for `proposed`. */
  rationale?: string;
  /** Present if and only if `provenance === "reviewed"`. */
  review?: LabelReview;
}

/** A case's labels: every field is a `LabelField`, or absent when unlabelled. */
export type CaseLabels = Record<string, LabelField<unknown> | undefined>;

/* -------------------------------------------------------------- Cases -- */

/** The only fields a municipal request may be built from. */
export interface MunicipalInput {
  feedback: string;
  clarification_history?: { role: "resident" | "officer"; message: string }[];
}

/** The only fields a safety request may be built from. */
export interface SafetyInput {
  student_message: string;
  conversation_history?: { role: "student" | "assistant"; message: string }[];
  /** Required: no hidden default is filled in at request time. */
  learning_context: string;
}

export interface EvalCase<TInput = unknown, TLabels extends CaseLabels = CaseLabels> {
  /** Stable, unique within the suite. Never sent in State. */
  id: string;
  suite: SuiteId;
  /** Paired / near-duplicate cases share a group and always share a split. */
  groupId: string;
  /** Reporting tags such as the original tag, agency, or contrast type. */
  slices: string[];
  /** The model-visible material, and nothing else. */
  input: TInput;
  labels: TLabels;
  /** Human-readable notes for reviewers. Never sent in State. */
  notes?: string;
}

export interface Dataset<TCase extends EvalCase = EvalCase> {
  suite: SuiteId;
  /** A human-chosen version string, bumped when cases change. */
  datasetVersion: string;
  /** Where the cases came from, in words. */
  source: string;
  /** SHA-256 of the source file(s) the cases were adapted from. */
  sourceHash: string;
  cases: TCase[];
}

/* -------------------------------------------------------------- Split -- */

export interface SplitAssignment {
  caseId: string;
  groupId: string;
  split: SplitName;
}

export interface ForcedGroup {
  groupId: string;
  split: SplitName;
  reason: string;
}

/**
 * A committed split manifest. Built once by `buildSplitManifest`, reviewed,
 * committed, and only ever *validated* afterwards — scoring never regenerates it.
 */
export interface SplitManifest {
  schemaVersion: 1;
  suite: SuiteId;
  datasetVersion: string;
  /** Hash of the sorted (caseId, groupId) pairs; see `membershipHash`. */
  membershipHash: string;
  seed: string;
  method: string;
  developmentFraction: number;
  forcedGroups: ForcedGroup[];
  /** Sorted by caseId. */
  assignments: SplitAssignment[];
  counts: Record<SplitName, { groups: number; cases: number }>;
  /** Cases per slice per split, so thin coverage is visible. */
  sliceCoverage: Record<string, Record<SplitName, number>>;
}

/* ----------------------------------------------------------- Requests -- */

/** One line of a prepared `requests.jsonl`: the join key plus the request. */
export interface PreparedRequest {
  caseId: string;
  request: EvaluationRequest;
}

/** Written by `prepare`. Everything a run needs except how it was run. */
export interface PreparedRun {
  schemaVersion: 1;
  suite: SuiteId;
  datasetVersion: string;
  sourceHash: string;
  /** Hash of (caseId, input) for every case in the dataset. */
  inputHash: string;
  /** Hash of (caseId, labels) for every case in the dataset. Informational. */
  labelsHash: string;
  /** Hash of the committed split manifest file contents (stable JSON). */
  splitManifestHash: string;
  split: SplitName;
  questionsHash: string;
  /** e.g. the agency taxonomy version; identifies the preset policy. */
  policyRevision: string;
  /** Git commit at preparation, or null if unavailable. */
  codeRevision: string | null;
  /** Selected case IDs in run order (sorted). */
  caseIds: string[];
  /** Intentionally variable; excluded from determinism comparisons. */
  preparedAt: string;
}

/* -------------------------------------------------------- Predictions -- */

export type ProvenanceMode = "mock" | "live";

export interface RunManifest extends PreparedRun {
  provenance: ProvenanceMode;
  /** The model the runner asked for; null for mock runs or when not applicable. */
  requestedModel: string | null;
  errorPolicy: ErrorPolicy;
  counts: {
    selected: number;
    ok: number;
    error: number;
    /** Selected cases the runner never attempted (e.g. after a stop). */
    notAttempted: number;
  };
}

export interface SanitizedError {
  /** A short machine code, e.g. `invalid_response` or `evaluator_error`. */
  code: string;
  /** A fixed message. Never an upstream body, a header, or State content. */
  message: string;
}

export interface PredictionRow {
  caseId: string;
  provenance: ProvenanceMode;
  requestedModel: string | null;
  status: "ok" | "error";
  /** Present iff status is "ok": the validated typed response. */
  response?: EvaluationResponse;
  /** Present iff status is "error". */
  error?: SanitizedError;
  /** Composed with existing lib code from `response.answers`; iff ok. */
  composed?: unknown;
  /** Absent when unmeasured — never zero-filled. */
  durationMs?: number;
  /** Copied from the response when it reported usage; otherwise absent. */
  usage?: Usage;
  /** The model the response reported; otherwise absent. */
  model?: string;
}

/* ------------------------------------------------------------- Runner -- */

/**
 * The only thing a runner may call. It receives the built request (and only
 * that) and returns the raw upstream-shaped result `{ model, answers, usage? }`.
 */
export type Evaluator = (request: EvaluationRequest) => Promise<unknown>;

/**
 * - `continue`: an error becomes an error row and the run carries on.
 * - `stop`: the first error becomes an error row and every later case is
 *   left not attempted (reported as missing, never silently dropped).
 */
export type ErrorPolicy = "continue" | "stop";

/* ------------------------------------------------------------- Suites -- */

/** Result of `loadPredictions`: every selected case is in exactly one bucket. */
export interface LoadedPredictions {
  manifest: RunManifest;
  /** Keyed by caseId, only for rows present in the file. */
  rows: Map<string, PredictionRow>;
  okIds: string[];
  errorIds: string[];
  /** Selected in the manifest but absent from the file. */
  missingIds: string[];
  selected: number;
}

export interface ScoreInput<TCase extends EvalCase = EvalCase> {
  manifest: RunManifest;
  /** The selected cases, in manifest order, with labels. */
  cases: TCase[];
  predictions: LoadedPredictions;
  /**
   * Hash of the labels used for this report (`labelsHash` of the current
   * dataset). Distinct from `manifest.labelsHash`, which is the labels at
   * prepare/inference time. Label-only reviews change this field without
   * invalidating saved predictions.
   */
  scoringLabelsHash: string;
}

export interface ScoreReport {
  /** Structured metrics; must include explicit numerators/denominators. */
  json: Record<string, unknown>;
  markdown: string;
}

/**
 * What each suite module exports as `suite` from `evaluation/<suite>/index.ts`.
 * The CLI loads it by name; shared code never special-cases a suite.
 */
export interface SuiteDefinition<TCase extends EvalCase = EvalCase> {
  id: SuiteId;
  questions: Questions;
  policyRevision: string;
  loadDataset(): Dataset<TCase>;
  loadSplitManifest(): SplitManifest;
  buildRequest(evalCase: TCase): EvaluationRequest;
  compose(answers: Answers): unknown;
  score(input: ScoreInput<TCase>): ScoreReport;
}

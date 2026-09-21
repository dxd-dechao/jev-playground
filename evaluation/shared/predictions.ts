/**
 * Prediction file IO and strict loading.
 *
 * A prediction file is refused, not repaired, when it could mislead: duplicate
 * or unknown case IDs, a manifest that no longer matches the dataset, split, or
 * questions, rows from a different provenance or model configuration, or a
 * stored composed outcome that the existing composition code would not
 * reproduce. A deliberately partial file loads, and its missing and error rows
 * stay visible in every count.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { validateUpstreamResult } from "../../lib/evaluation-response";
import type { Answers, Questions } from "../../lib/types";
import { stableStringify } from "./hash";
import type { LoadedPredictions, PredictionRow, RunManifest } from "./types";

/* ------------------------------------------------------------------ IO -- */

export function parseJsonl<T = unknown>(text: string, label = "jsonl"): T[] {
  const rows: T[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${label}: line ${index + 1} is not valid JSON`);
    }
  }
  return rows;
}

/** One stable-key JSON object per line, so repeated output is byte-identical. */
export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => stableStringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

export function readJsonl<T = unknown>(path: string): T[] {
  return parseJsonl<T>(readFileSync(path, "utf8"), path);
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, toJsonl(rows));
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Pretty JSON with sorted keys and a trailing newline. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(JSON.parse(stableStringify(value)), null, 2) + "\n");
}

/* ------------------------------------------------------------- Loading -- */

/** The values a run manifest must match to be scored against today's suite. */
export interface ManifestExpectations {
  suite: RunManifest["suite"];
  datasetVersion: string;
  sourceHash: string;
  inputHash: string;
  splitManifestHash: string;
  questionsHash: string;
  /** Case IDs that exist in the committed split named by the manifest. */
  splitCaseIds: readonly string[];
}

export function validateRunManifest(manifest: RunManifest, expected: ManifestExpectations): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push("run manifest: unsupported schemaVersion");
  const pairs: [keyof ManifestExpectations & keyof RunManifest, string][] = [
    ["suite", "suite"],
    ["datasetVersion", "dataset version"],
    ["sourceHash", "source hash"],
    ["inputHash", "dataset input hash"],
    ["splitManifestHash", "split manifest hash"],
    ["questionsHash", "questions hash"],
  ];
  for (const [key, label] of pairs) {
    if (manifest[key] !== expected[key]) {
      errors.push(`run manifest: ${label} does not match the current ${expected.suite} suite`);
    }
  }
  if (manifest.provenance !== "mock" && manifest.provenance !== "live") {
    errors.push("run manifest: provenance must be mock or live");
  }
  if (manifest.provenance === "mock" && manifest.requestedModel !== null) {
    errors.push("run manifest: a mock run must not name a requested model");
  }
  if (!Array.isArray(manifest.caseIds)) {
    errors.push("run manifest: caseIds must be an array");
    return errors;
  }
  const inSplit = new Set(expected.splitCaseIds);
  const seen = new Set<string>();
  for (const id of manifest.caseIds) {
    if (seen.has(id)) errors.push(`run manifest: duplicate case ${id}`);
    seen.add(id);
    if (!inSplit.has(id)) errors.push(`run manifest: case ${id} is not in the ${manifest.split} split`);
  }
  return errors;
}

export interface LoadPredictionsOptions {
  manifest: RunManifest;
  rows: readonly unknown[];
  expected: ManifestExpectations;
  questions: Questions;
  compose: (answers: Answers) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadPredictions(options: LoadPredictionsOptions): LoadedPredictions {
  const { manifest, expected, questions, compose } = options;
  const errors = validateRunManifest(manifest, expected);
  const selected = new Set(manifest.caseIds ?? []);
  const rows = new Map<string, PredictionRow>();

  for (const [index, raw] of options.rows.entries()) {
    const at = `predictions[${index}]`;
    if (!isRecord(raw) || typeof raw.caseId !== "string") {
      errors.push(`${at}: must be an object with a caseId`);
      continue;
    }
    const row = raw as unknown as PredictionRow;
    const id = row.caseId;
    if (rows.has(id)) {
      errors.push(`${at}: duplicate prediction for ${id} (refusing to pick one)`);
      continue;
    }
    if (!selected.has(id)) errors.push(`${at}: ${id} is not selected in the run manifest`);
    if (row.provenance !== manifest.provenance) {
      errors.push(`${at}: provenance ${String(row.provenance)} differs from the manifest's ${manifest.provenance}`);
    }
    if ((row.requestedModel ?? null) !== manifest.requestedModel) {
      errors.push(`${at}: requestedModel differs from the manifest's (mixed configurations)`);
    }
    if (row.status === "ok") {
      if (row.error !== undefined) errors.push(`${at}: an ok row must not carry an error`);
      const validation = validateUpstreamResult(row.response, questions);
      if (!validation.ok || !validation.value) {
        errors.push(`${at}: response does not validate against the submitted questions`);
      } else if (stableStringify(compose(validation.value.answers)) !== stableStringify(row.composed)) {
        errors.push(`${at}: stored composed outcome differs from what existing code composes`);
      }
    } else if (row.status === "error") {
      if (row.response !== undefined || row.composed !== undefined) {
        errors.push(`${at}: an error row must not carry a response or composed outcome`);
      }
      if (!isRecord(row.error) || typeof row.error.code !== "string") {
        errors.push(`${at}: an error row needs a sanitized error {code, message}`);
      }
    } else {
      errors.push(`${at}: status must be ok or error`);
    }
    rows.set(id, row);
  }

  if (errors.length > 0) {
    throw new Error(`Refusing to score these predictions:\n- ${errors.join("\n- ")}`);
  }

  const okIds: string[] = [];
  const errorIds: string[] = [];
  const missingIds: string[] = [];
  for (const id of manifest.caseIds) {
    const row = rows.get(id);
    if (!row) missingIds.push(id);
    else if (row.status === "ok") okIds.push(id);
    else errorIds.push(id);
  }
  return { manifest, rows, okIds, errorIds, missingIds, selected: manifest.caseIds.length };
}

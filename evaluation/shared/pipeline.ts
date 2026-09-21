/**
 * Suite-agnostic prepare and score steps, used by the CLI and by tests.
 *
 * Neither step calls a model. `prepareRun` validates the dataset and the
 * committed split and builds label-free requests; `scoreRun` validates a
 * prediction file against the current suite and hands it to the suite scorer.
 */

import { assertValidDataset, inputHash, labelsHash } from "./dataset";
import { loadPredictions, type ManifestExpectations } from "./predictions";
import { questionsHash } from "./requests";
import { assertValidSplitManifest, selectSplit, splitManifestHash } from "./split";
import type {
  EvalCase,
  PreparedRequest,
  PreparedRun,
  RunManifest,
  ScoreReport,
  SplitName,
  SuiteDefinition,
} from "./types";

export interface PrepareOptions {
  split: SplitName;
  codeRevision: string | null;
  preparedAt: string;
}

export interface PrepareResult {
  prepared: PreparedRun;
  requests: PreparedRequest[];
}

export function prepareRun<TCase extends EvalCase>(
  suite: SuiteDefinition<TCase>,
  options: PrepareOptions,
): PrepareResult {
  const dataset = suite.loadDataset();
  assertValidDataset(dataset, suite.id);
  const split = suite.loadSplitManifest();
  assertValidSplitManifest(split, dataset);

  const caseIds = selectSplit(split, options.split);
  const byId = new Map(dataset.cases.map((c) => [c.id, c]));
  const requests = caseIds.map((caseId) => ({ caseId, request: suite.buildRequest(byId.get(caseId)!) }));
  const questions = suite.questions;
  for (const { caseId, request } of requests) {
    if (questionsHash(request.questions) !== questionsHash(questions)) {
      throw new Error(`${caseId}: built request does not use the suite's default questions`);
    }
  }

  const prepared: PreparedRun = {
    schemaVersion: 1,
    suite: suite.id,
    datasetVersion: dataset.datasetVersion,
    sourceHash: dataset.sourceHash,
    inputHash: inputHash(dataset.cases),
    labelsHash: labelsHash(dataset.cases),
    splitManifestHash: splitManifestHash(split),
    split: options.split,
    questionsHash: questionsHash(questions),
    policyRevision: suite.policyRevision,
    codeRevision: options.codeRevision,
    caseIds,
    preparedAt: options.preparedAt,
  };
  return { prepared, requests };
}

/** What a run manifest for `split` must match today. */
export function manifestExpectations<TCase extends EvalCase>(
  suite: SuiteDefinition<TCase>,
  split: SplitName,
): ManifestExpectations {
  const dataset = suite.loadDataset();
  assertValidDataset(dataset, suite.id);
  const splitManifest = suite.loadSplitManifest();
  assertValidSplitManifest(splitManifest, dataset);
  return {
    suite: suite.id,
    datasetVersion: dataset.datasetVersion,
    sourceHash: dataset.sourceHash,
    inputHash: inputHash(dataset.cases),
    splitManifestHash: splitManifestHash(splitManifest),
    questionsHash: questionsHash(suite.questions),
    splitCaseIds: selectSplit(splitManifest, split),
  };
}

export function scoreRun<TCase extends EvalCase>(
  suite: SuiteDefinition<TCase>,
  manifest: RunManifest,
  rows: readonly unknown[],
): ScoreReport {
  if (manifest.suite !== suite.id) {
    throw new Error(`Run manifest is for suite ${manifest.suite}, not ${suite.id}`);
  }
  const predictions = loadPredictions({
    manifest,
    rows,
    expected: manifestExpectations(suite, manifest.split),
    questions: suite.questions,
    compose: suite.compose,
  });
  const dataset = suite.loadDataset();
  const byId = new Map(dataset.cases.map((c) => [c.id, c]));
  const cases = manifest.caseIds.map((id) => byId.get(id)!);
  return suite.score({
    manifest,
    cases,
    predictions,
    scoringLabelsHash: labelsHash(dataset.cases),
  });
}

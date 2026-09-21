/**
 * Municipal scorer.
 *
 * Two things are scored separately and never merged:
 *
 * 1. The RAW `primary_agency` answer against the inherited agency references
 *    (exact primary match and acceptable-agency match). This uses the raw
 *    answer even when the composed routing suppressed, deferred, or sent the
 *    case to review, so abstention cannot hide an agency error.
 * 2. The COMPOSED routing outcome from `composeMunicipalRouting`
 *    (recommended / tentative / suppressed / review), reported as a
 *    distribution over all selected cases.
 *
 * Every rate is `rate(numerator, denominator)`; zero denominators are
 * "unavailable". Success-only accuracy is always shown next to total-case
 * coverage so errors and missing rows stay visible. Disposition accuracy uses
 * `reviewed` labels only; agreement with proposed labels is a separate,
 * clearly labelled diagnostic.
 */

import { composeMunicipalRouting, type MunicipalComposition, type MunicipalRoutingStatus } from "../../lib/municipal-routing";
import { UNCLEAR_AGENCY } from "../../lib/agency-definitions";
import type { Answers } from "../../lib/types";
import { isChoiceAnswer } from "../../lib/types";
import {
  countBy,
  coverageSummary,
  formatRate,
  isReviewed,
  labelInventory,
  markdownTable,
  rate,
  reportHeader,
  type Rate,
  type ScoreInput,
  type ScoreReport,
} from "../shared";
import type { MunicipalCase } from "./dataset";

export const COMPOSED_STATUSES: readonly MunicipalRoutingStatus[] = ["recommended", "tentative", "suppressed", "review"];

type Outcome = "ok" | "error" | "missing";

interface CaseResult {
  id: string;
  tag: string;
  agency: string;
  outcome: Outcome;
  errorCode?: string;
  rawAgency: string | null;
  exact: boolean;
  acceptable: boolean;
  labelled: boolean;
  composed?: MunicipalComposition;
  rawDisposition: string | null;
}

export interface BreakdownRow {
  selected: number;
  ok: number;
  error: number;
  missing: number;
  exact: number;
  acceptable: number;
  /** Successful predictions whose raw agency is outside the acceptable set. */
  wrongAgency: number;
}

function rawPrimaryAgency(answers: Answers): string | null {
  const answer = answers["primary_agency"];
  return answer && isChoiceAnswer(answer) ? answer.choice : null;
}

function rawDisposition(answers: Answers): string | null {
  const answer = answers["disposition"];
  return answer && isChoiceAnswer(answer) ? answer.choice : null;
}

function tagOf(c: MunicipalCase): string {
  const slice = c.slices.find((s) => s.startsWith("tag:"));
  return slice ? slice.slice("tag:".length) : "(none)";
}

function evaluateCase(c: MunicipalCase, input: ScoreInput<MunicipalCase>): CaseResult {
  const row = input.predictions.rows.get(c.id);
  const primary = c.labels.primary_agency?.value;
  const acceptableSet = c.labels.acceptable_agencies?.value;
  const base = {
    id: c.id,
    tag: tagOf(c),
    agency: primary ?? "(unlabelled)",
    labelled: primary !== undefined && acceptableSet !== undefined,
    rawAgency: null,
    exact: false,
    acceptable: false,
    rawDisposition: null,
  };
  if (!row) return { ...base, outcome: "missing" };
  if (row.status !== "ok" || !row.response) {
    const result: CaseResult = { ...base, outcome: "error" };
    if (row.error?.code) result.errorCode = row.error.code;
    return result;
  }
  const answers = row.response.answers;
  const rawAgency = rawPrimaryAgency(answers);
  return {
    ...base,
    outcome: "ok",
    rawAgency,
    exact: rawAgency !== null && primary !== undefined && rawAgency === primary,
    acceptable: rawAgency !== null && acceptableSet !== undefined && acceptableSet.includes(rawAgency),
    composed: composeMunicipalRouting(answers),
    rawDisposition: rawDisposition(answers),
  };
}

function breakdown(results: readonly CaseResult[], key: (r: CaseResult) => string): Record<string, BreakdownRow> {
  const rows: Record<string, BreakdownRow> = {};
  for (const r of results) {
    const k = key(r);
    const row = (rows[k] ??= { selected: 0, ok: 0, error: 0, missing: 0, exact: 0, acceptable: 0, wrongAgency: 0 });
    row.selected += 1;
    row[r.outcome] += 1;
    if (r.outcome === "ok" && r.labelled) {
      if (r.exact) row.exact += 1;
      if (r.acceptable) row.acceptable += 1;
      else row.wrongAgency += 1;
    }
  }
  return Object.fromEntries(Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function dispositionMetrics(
  results: readonly CaseResult[],
  cases: readonly MunicipalCase[],
  which: "reviewed" | "proposed",
) {
  const byId = new Map(results.map((r) => [r.id, r]));
  let eligible = 0;
  let scored = 0;
  let correct = 0;
  let error = 0;
  let missing = 0;
  for (const c of cases) {
    const label = c.labels.disposition;
    const qualifies = which === "reviewed" ? isReviewed(label) : label?.provenance === "proposed";
    if (!label || !qualifies) continue;
    eligible += 1;
    const r = byId.get(c.id)!;
    if (r.outcome === "error") error += 1;
    else if (r.outcome === "missing") missing += 1;
    else {
      scored += 1;
      if (r.rawDisposition === label.value) correct += 1;
    }
  }
  return {
    eligible,
    scored,
    correct,
    missing: { error, missing },
    /** Over labelled cases with a successful prediction. */
    accuracy: rate(correct, scored, { error, missing }),
    /** Correct over every labelled selected case, failures counted as not correct. */
    coverage: rate(correct, eligible),
  };
}

export function scoreMunicipal(input: ScoreInput<MunicipalCase>): ScoreReport {
  const { manifest, cases, predictions, scoringLabelsHash } = input;
  const results = cases.map((c) => evaluateCase(c, input));
  const selected = results.length;
  const ok = results.filter((r) => r.outcome === "ok");
  const errorCount = results.filter((r) => r.outcome === "error").length;
  const missingCount = results.filter((r) => r.outcome === "missing").length;
  const okLabelled = ok.filter((r) => r.labelled);
  const unlabelled = results.filter((r) => !r.labelled).length;
  const excluded = { error: errorCount, missing: missingCount, unlabelled: ok.length - okLabelled.length };

  const exact = okLabelled.filter((r) => r.exact).length;
  const acceptable = okLabelled.filter((r) => r.acceptable).length;
  const labelledSelected = selected - unlabelled;

  const statusCounts = Object.fromEntries(COMPOSED_STATUSES.map((s) => [s, 0])) as Record<MunicipalRoutingStatus, number>;
  for (const r of ok) statusCounts[r.composed!.status] += 1;

  const byStatus = Object.fromEntries(
    COMPOSED_STATUSES.map((s) => {
      const group = okLabelled.filter((r) => r.composed!.status === s);
      return [
        s,
        {
          ok: group.length,
          exact: rate(group.filter((r) => r.exact).length, group.length),
          acceptable: rate(group.filter((r) => r.acceptable).length, group.length),
        },
      ];
    }),
  ) as Record<MunicipalRoutingStatus, { ok: number; exact: Rate; acceptable: Rate }>;

  const recommended = okLabelled.filter((r) => r.composed!.status === "recommended");
  const recommendedAcceptable = recommended.filter((r) => r.composed!.recommendedAgency !== null && r.acceptable).length;

  const byTag = breakdown(results, (r) => r.tag);
  const byAgency = breakdown(results, (r) => r.agency);
  const errorCodes = countBy(
    results.filter((r) => r.outcome === "error"),
    (r) => r.errorCode ?? "unknown",
  );
  const rawAgencyCounts = countBy(ok, (r) => r.rawAgency ?? "(unreadable)");

  const reviewedDisposition = dispositionMetrics(results, cases, "reviewed");
  const proposedDisposition = dispositionMetrics(results, cases, "proposed");
  const inventory = labelInventory(cases);

  const json = {
    suite: "municipal",
    provenance: manifest.provenance,
    split: manifest.split,
    datasetVersion: manifest.datasetVersion,
    preparationLabelsHash: manifest.labelsHash,
    scoringLabelsHash,
    coverage: coverageSummary(predictions),
    labelInventory: inventory,
    rawAgency: {
      definition:
        "Raw primary_agency answer vs inherited references, scored for every successful prediction regardless of the composed routing status.",
      primaryExact: {
        successful: rate(exact, okLabelled.length, excluded),
        totalCoverage: rate(exact, labelledSelected),
      },
      acceptableAgency: {
        successful: rate(acceptable, okLabelled.length, excluded),
        totalCoverage: rate(acceptable, labelledSelected),
      },
      unlabelled,
      rawAnswerCounts: rawAgencyCounts,
      rawUnclearAnswers: ok.filter((r) => r.rawAgency === UNCLEAR_AGENCY).length,
      byComposedStatus: byStatus,
    },
    composed: {
      definition:
        "Code-composed routing (composeMunicipalRouting). Rates are over all selected cases; errors and missing rows are counted separately, never as a routing status.",
      statusCounts,
      routingCoverage: rate(statusCounts.recommended, selected),
      tentativeRate: rate(statusCounts.tentative, selected),
      suppressedRate: rate(statusCounts.suppressed, selected),
      humanReviewRate: rate(statusCounts.review, selected),
      failures: { error: errorCount, missing: missingCount, rate: rate(errorCount + missingCount, selected) },
      recommendedAgencyAcceptable: rate(recommendedAcceptable, recommended.length),
      correctlyRecommendedCoverage: rate(recommendedAcceptable, labelledSelected),
    },
    breakdowns: { byTag, byInheritedPrimaryAgency: byAgency, errorCodes },
    disposition: {
      reviewed: reviewedDisposition,
      proposedDiagnostic: {
        label: "DIAGNOSTIC ONLY — agreement with PROPOSED (unreviewed) disposition labels. Not accuracy.",
        ...proposedDisposition,
      },
    },
  };

  const md: string[] = [reportHeader("Municipal routing evaluation", manifest, predictions, inventory, scoringLabelsHash)];

  md.push(
    "## Raw agency answer (scored even when routing is suppressed or deferred)",
    "",
    "Agency references are inherited single-source synthetic labels, not reviewed operational ground truth.",
    "",
    markdownTable(
      ["Metric", "Successful predictions", "All selected cases (failures count as not correct)"],
      [
        ["Primary exact match", formatRate(json.rawAgency.primaryExact.successful), formatRate(json.rawAgency.primaryExact.totalCoverage)],
        ["Acceptable-agency match", formatRate(json.rawAgency.acceptableAgency.successful), formatRate(json.rawAgency.acceptableAgency.totalCoverage)],
      ],
    ),
    "",
    `Raw \`Unclear\` answers: ${json.rawAgency.rawUnclearAnswers} of ${ok.length} successful predictions.` +
      (unlabelled > 0 ? ` Cases without agency labels (excluded): ${unlabelled}.` : ""),
    "",
    "### Raw agency by composed status",
    "",
    markdownTable(
      ["Composed status", "Successful", "Raw exact", "Raw acceptable"],
      COMPOSED_STATUSES.map((s) => [s, byStatus[s].ok, formatRate(byStatus[s].exact), formatRate(byStatus[s].acceptable)]),
    ),
    "",
    "## Composed routing outcome",
    "",
    markdownTable(
      ["Outcome", "Count", "Rate over all selected"],
      [
        ["recommended (routing coverage)", statusCounts.recommended, formatRate(json.composed.routingCoverage)],
        ["tentative (shown separately)", statusCounts.tentative, formatRate(json.composed.tentativeRate)],
        ["suppressed", statusCounts.suppressed, formatRate(json.composed.suppressedRate)],
        ["review (human-review rate)", statusCounts.review, formatRate(json.composed.humanReviewRate)],
        ["error (not a routing outcome)", errorCount, formatRate(rate(errorCount, selected))],
        ["missing (not a routing outcome)", missingCount, formatRate(rate(missingCount, selected))],
      ],
    ),
    "",
    `Recommended agency within the acceptable set: ${formatRate(json.composed.recommendedAgencyAcceptable)} of recommended; ` +
      `${formatRate(json.composed.correctlyRecommendedCoverage)} of all selected cases.`,
    "",
    "## Breakdown by original tag",
    "",
    breakdownTable(byTag, "Tag"),
    "",
    "## Breakdown by inherited primary agency",
    "",
    breakdownTable(byAgency, "Inherited primary agency"),
    "",
  );
  if (errorCount > 0) {
    md.push("Error codes: " + Object.entries(errorCodes).map(([k, n]) => `${k} ${n}`).join(", "), "");
  }

  md.push(
    "## Disposition (reviewed labels only)",
    "",
    markdownTable(
      ["Eligible (reviewed)", "Scored", "Error", "Missing", "Accuracy (successful)", "Correct coverage (all eligible)"],
      [
        [
          reviewedDisposition.eligible,
          reviewedDisposition.scored,
          reviewedDisposition.missing.error,
          reviewedDisposition.missing.missing,
          formatRate(reviewedDisposition.accuracy),
          formatRate(reviewedDisposition.coverage),
        ],
      ],
    ),
    "",
    reviewedDisposition.eligible === 0
      ? "No disposition label has been reviewed by a human, so disposition accuracy is unavailable."
      : "Only labels with a recorded human reviewer and date are counted.",
    "",
    "### Diagnostic only: agreement with proposed (unreviewed) disposition labels",
    "",
    "Not an accuracy metric. The proposed labels were drafted by an agent and have not been reviewed.",
    "",
    markdownTable(
      ["Proposed labels", "Scored", "Error", "Missing", "Agreement (successful)"],
      [
        [
          proposedDisposition.eligible,
          proposedDisposition.scored,
          proposedDisposition.missing.error,
          proposedDisposition.missing.missing,
          formatRate(proposedDisposition.accuracy),
        ],
      ],
    ),
    "",
  );

  return { json, markdown: md.join("\n") };
}

function breakdownTable(rows: Record<string, BreakdownRow>, label: string): string {
  return markdownTable(
    [label, "Selected", "OK", "Error", "Missing", "Raw exact", "Raw acceptable", "Wrong agency (raw)"],
    Object.entries(rows).map(([k, r]) => [
      k,
      r.selected,
      r.ok,
      r.error,
      r.missing,
      formatRate(rate(r.exact, r.ok)),
      formatRate(rate(r.acceptable, r.ok)),
      r.wrongAgency,
    ]),
  );
}

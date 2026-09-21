/**
 * Report helpers shared by both scorers.
 *
 * Every metric is a `Rate` with an explicit numerator and denominator. A zero
 * denominator yields `value: null`, rendered as "unavailable" — never 0% and
 * never 100%.
 */

import type { LabelInventory } from "./dataset";
import type { LoadedPredictions, RunManifest } from "./types";

export const MOCK_BANNER = "MOCK DATA — NOT MODEL PERFORMANCE";

export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator / denominator, or null when the denominator is zero. */
  value: number | null;
  /** Cases left out of the denominator, with why. */
  excluded?: Record<string, number>;
}

export function rate(numerator: number, denominator: number, excluded?: Record<string, number>): Rate {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 0) {
    throw new Error(`rate: counts must be nonnegative integers (${numerator}/${denominator})`);
  }
  if (numerator > denominator) throw new Error(`rate: numerator ${numerator} exceeds denominator ${denominator}`);
  const result: Rate = { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
  if (excluded !== undefined) result.excluded = excluded;
  return result;
}

export function formatRate(r: Rate): string {
  const excluded = r.excluded
    ? Object.entries(r.excluded)
        .filter(([, n]) => n > 0)
        .map(([why, n]) => `${n} ${why}`)
        .join(", ")
    : "";
  const suffix = excluded ? `; excluded: ${excluded}` : "";
  if (r.value === null) return `unavailable (0 eligible${suffix})`;
  return `${r.numerator}/${r.denominator} (${(r.value * 100).toFixed(1)}%${suffix})`;
}

/** Counts per key, with keys sorted for stable output. */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function markdownTable(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const escape = (cell: string | number) => String(cell).replace(/\|/g, "\\|");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

/** Success / failure / missing counts every report must show. */
export function coverageSummary(predictions: LoadedPredictions) {
  return {
    selected: predictions.selected,
    ok: predictions.okIds.length,
    error: predictions.errorIds.length,
    missing: predictions.missingIds.length,
    successCoverage: rate(predictions.okIds.length, predictions.selected),
  };
}

/** The standard report preamble: provenance banner, run identity, coverage. */
export function reportHeader(
  title: string,
  manifest: RunManifest,
  predictions: LoadedPredictions,
  inventory: LabelInventory,
): string {
  const coverage = coverageSummary(predictions);
  const lines: string[] = [];
  if (manifest.provenance === "mock") {
    lines.push(`> **${MOCK_BANNER}.** These predictions came from a deterministic mock evaluator. They verify the scoring arithmetic only.`, "");
  } else {
    lines.push(
      "> **Live predictions.** Metrics describe this run only, on synthetic cases. They are not operational validation.",
      "",
    );
  }
  lines.push(
    `# ${title}`,
    "",
    markdownTable(
      ["Field", "Value"],
      [
        ["Suite", manifest.suite],
        ["Split", `${manifest.split} (synthetic; held-out is not independent real-world validation)`],
        ["Provenance", manifest.provenance],
        ["Requested model", manifest.requestedModel ?? "n/a"],
        ["Dataset version", manifest.datasetVersion],
        ["Source hash", manifest.sourceHash],
        ["Input hash", manifest.inputHash],
        ["Split manifest hash", manifest.splitManifestHash],
        ["Questions hash", manifest.questionsHash],
        ["Policy revision", manifest.policyRevision],
        ["Code revision", manifest.codeRevision ?? "unavailable"],
        ["Error policy", manifest.errorPolicy],
      ],
    ),
    "",
    "## Coverage",
    "",
    markdownTable(
      ["Selected", "OK", "Error", "Missing", "Success coverage"],
      [[coverage.selected, coverage.ok, coverage.error, coverage.missing, formatRate(coverage.successCoverage)]],
    ),
    "",
    "## Label provenance",
    "",
    markdownTable(
      ["Label field", "inherited_reference", "proposed", "reviewed", "absent"],
      Object.entries(inventory).map(([name, c]) => [name, c.inherited_reference, c.proposed, c.reviewed, c.absent]),
    ),
    "",
    "Only `reviewed` labels feed reviewed-label metrics. Inherited references are single-source; proposed labels are unreviewed and any agreement with them is diagnostic only.",
    "",
  );
  return lines.join("\n");
}

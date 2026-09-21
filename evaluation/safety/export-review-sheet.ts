/**
 * Writes a CSV review sheet (one row per case and label field) from the
 * current labels, for a human reviewer to fill in.
 *
 *   npx vite-node evaluation/safety/export-review-sheet.ts <output.csv>
 *
 * The sheet is a working copy. The record of a review is `labels.json`; see
 * `review-template.md` for how a completed sheet is transcribed.
 */

import { writeFileSync } from "node:fs";
import { loadSafetyDataset } from "./dataset";

const FIELDS = ["self_harm_context", "handling", "category"] as const;

function csv(cell: unknown): string {
  const text = cell === undefined || cell === null ? "" : String(cell);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reviewSheetRows(): string[][] {
  const dataset = loadSafetyDataset();
  const rows: string[][] = [
    [
      "case_id", "group_id", "student_message", "conversation_history", "learning_context", "notes",
      "field", "current_value", "current_provenance", "rationale",
      "reviewer_decision (agree|change)", "reviewer_value", "reviewer_name", "reviewed_on (YYYY-MM-DD)", "reviewer_note",
    ],
  ];
  for (const c of dataset.cases) {
    for (const field of FIELDS) {
      const label = c.labels[field];
      rows.push([
        c.id, c.groupId, c.input.student_message,
        (c.input.conversation_history ?? []).map((t) => `${t.role}: ${t.message}`).join(" | "),
        c.input.learning_context, c.notes ?? "",
        field, String(label?.value ?? ""), label?.provenance ?? "absent", label?.rationale ?? "",
        "", "", "", "", "",
      ]);
    }
  }
  return rows;
}

const out = process.argv.slice(2).filter((a) => a !== "--")[0];
if (out) {
  writeFileSync(out, reviewSheetRows().map((r) => r.map(csv).join(",")).join("\n") + "\n");
  console.log(`Wrote review sheet to ${out}`);
}

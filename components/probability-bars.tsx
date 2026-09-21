/**
 * Distribution rendering for every answer type.
 *
 * Rules this component exists to enforce:
 *  - The full distribution is always shown, never just the winner.
 *  - Every probability is readable as text. The bar is decorative
 *    (`aria-hidden`) so a screen reader gets the number, not a graphic.
 *  - Confidence and probability are labelled separately and never merged.
 *  - A Noul is labelled as "probability that …", not as a boolean or a score.
 *  - A Score uses the API's own `legend` and level keys for its scale.
 */

import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "@/lib/types";

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function Bar({ value, emphasis }: { value: number; emphasis: boolean }) {
  const width = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
    >
      <span
        className={`block h-full rounded-full ${
          emphasis ? "bg-[var(--color-accent)]" : "bg-[var(--color-ink-soft)]/45"
        }`}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

interface Row {
  key: string;
  label: string;
  value: number;
  emphasis: boolean;
}

function DistributionRows({ rows }: { rows: Row[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span
              className={`text-sm ${
                row.emphasis
                  ? "font-semibold text-[var(--color-ink)]"
                  : "text-[var(--color-ink-soft)]"
              }`}
            >
              {row.label}
            </span>
            <span className="font-mono text-xs tabular-nums text-[var(--color-ink-soft)]">
              {percent(row.value)}
            </span>
          </div>
          <Bar value={row.value} emphasis={row.emphasis} />
        </li>
      ))}
    </ul>
  );
}

/** Confidence is a separate statistic derived from the distribution's shape. */
export function ConfidenceLine({ confidence }: { confidence: number }) {
  return (
    <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
      <span className="font-medium text-[var(--color-ink)]">Confidence</span>{" "}
      <span className="font-mono tabular-nums">{confidence.toFixed(2)}</span> —
      a statistic derived from the shape of the distribution above. It is not a
      measured probability that the selected option is correct.
    </p>
  );
}

export function ChoiceDistribution({
  answer,
  optionLabels,
}: {
  answer: ChoiceAnswer;
  /** Optional plain-language label per option key. */
  optionLabels?: Record<string, string>;
}) {
  const rows: Row[] = Object.entries(answer.probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([key, value]) => ({
      key,
      label: optionLabels?.[key] ?? key,
      value,
      emphasis: key === answer.choice,
    }));

  return (
    <div>
      <p className="text-sm text-[var(--color-ink-soft)]">
        Selected option:{" "}
        <span className="font-semibold text-[var(--color-ink)]">
          {optionLabels?.[answer.choice] ?? answer.choice}
        </span>
      </p>
      <DistributionRows rows={rows} />
      <ConfidenceLine confidence={answer.confidence} />
    </div>
  );
}

export function NoulProbability({
  answer,
  meaning,
}: {
  answer: NoulAnswer;
  /** What a value near 1 means, spelled out. Required: "true" is not a label. */
  meaning: string;
}) {
  return (
    <div>
      <p className="text-sm text-[var(--color-ink-soft)]">
        Probability that {meaning}:{" "}
        <span className="font-mono font-semibold tabular-nums text-[var(--color-ink)]">
          {percent(answer.noul)}
        </span>
      </p>
      <div className="mt-2">
        <Bar value={answer.noul} emphasis />
      </div>
      <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
        A Noul answer is the probability that the answer to the yes/no question
        is yes. It is not a boolean, not a severity score, and not a measure of
        accuracy. Noul answers carry no confidence value.
      </p>
    </div>
  );
}

export function ScoreDistribution({ answer }: { answer: ScoreAnswer }) {
  const rows: Row[] = Object.keys(answer.probabilities)
    .sort((a, b) => Number(a) - Number(b))
    .map((level) => ({
      key: level,
      label: `${level} — ${answer.legend[level] ?? "Unavailable"}`,
      value: answer.probabilities[level] ?? 0,
      emphasis: false,
    }));

  const levels = Object.keys(answer.legend).map(Number);
  const lowest = levels.length > 0 ? Math.min(...levels) : 0;
  const highest = levels.length > 0 ? Math.max(...levels) : 0;

  return (
    <div>
      <p className="text-sm text-[var(--color-ink-soft)]">
        Score:{" "}
        <span className="font-mono font-semibold tabular-nums text-[var(--color-ink)]">
          {answer.score.toFixed(2)}
        </span>{" "}
        on the scale {lowest}–{highest} defined by this question&rsquo;s legend.
        A score can land between levels.
      </p>
      <DistributionRows rows={rows} />
      <ConfidenceLine confidence={answer.confidence} />
    </div>
  );
}

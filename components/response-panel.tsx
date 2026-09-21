"use client";

/**
 * Panel 3 of 3: the response.
 *
 * Invariants this panel is responsible for:
 *  - The "Fixture data — no model call" badge is visible in Cards *and* JSON.
 *  - Raw answers are shown separately from the composed application outcome,
 *    which is explicitly tagged as code, not a model judgment.
 *  - Measurement fields (model, tokens, latency, cost) read "Unavailable".
 *    Nothing was measured, so nothing may look measured.
 *  - A result belongs to the request snapshot it was produced from. Editing
 *    State marks it stale; it is never silently re-attached to new input.
 */

import type { FixtureResult } from "@/lib/fixtures";
import { FIXTURE_BADGE_TEXT, FIXTURE_EXPLANATION } from "@/lib/fixtures";
import type { Scenario } from "@/lib/scenarios";
import {
  MUNICIPAL_DISPOSITION_LABELS,
  MUNICIPAL_STATUS_LABELS,
  composeMunicipalRouting,
} from "@/lib/municipal-routing";
import {
  SAFETY_HANDLING_LABELS,
  SAFETY_RECOMMENDATION_LABELS,
  SAFETY_SELF_HARM_LABELS,
  composeSafetyRecommendation,
} from "@/lib/safety-guardrails";
import type { Answer, EvaluationRequest } from "@/lib/types";
import { isChoiceAnswer, isNoulAnswer, isScoreAnswer } from "@/lib/types";
import {
  ChoiceDistribution,
  NoulProbability,
  ScoreDistribution,
} from "./probability-bars";

/** A displayed result, bound to the exact request it was produced from. */
export interface PreviewResult {
  scenarioId: Scenario["id"];
  fixture: FixtureResult;
  /** The request as submitted. Kept so staleness can be detected honestly. */
  requestSnapshot: EvaluationRequest;
  /** The exact State text at preview time. */
  submittedStateText: string;
}

export type ResponseView = "cards" | "json";

function FixtureBadge() {
  return (
    <span
      data-testid="fixture-badge"
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-ink)]"
    >
      <span aria-hidden="true">●</span>
      {FIXTURE_BADGE_TEXT}
    </span>
  );
}

function Measurement() {
  return (
    <div className="mt-4 rounded-lg border border-[var(--color-line)] p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
        Measurement
      </h4>
      <dl
        data-testid="measurement-block"
        className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
      >
        {["Resolved model", "Input tokens", "Output tokens", "Latency", "Cost"].map(
          (field) => (
            <div key={field} className="flex justify-between gap-2">
              <dt className="text-[var(--color-ink-soft)]">{field}</dt>
              <dd className="font-medium">Unavailable</dd>
            </div>
          ),
        )}
      </dl>
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        No request was sent, so there is nothing to measure. These fields will
        carry real values only once a live evaluation path exists.
      </p>
    </div>
  );
}

function AnswerCard({
  id,
  answer,
  scenarioId,
}: {
  id: string;
  answer: Answer;
  scenarioId: Scenario["id"];
}) {
  const optionLabels =
    scenarioId === "safety" && id === "self_harm_context"
      ? (SAFETY_SELF_HARM_LABELS as Record<string, string>)
      : scenarioId === "safety" && id === "handling"
        ? (SAFETY_HANDLING_LABELS as Record<string, string>)
        : scenarioId === "municipal" && id === "disposition"
          ? (MUNICIPAL_DISPOSITION_LABELS as Record<string, string>)
          : undefined;

  return (
    <li
      data-testid={`answer-${id}`}
      className="rounded-lg border border-[var(--color-line)] p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-semibold">{id}</span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
          {answer.type}
        </span>
      </div>
      <div className="mt-2">
        {isChoiceAnswer(answer) ? (
          <ChoiceDistribution answer={answer} optionLabels={optionLabels} />
        ) : null}
        {isNoulAnswer(answer) ? (
          <NoulProbability
            answer={answer}
            meaning={
              scenarioId === "safety" && id === "targeted_insult"
                ? "the student is using a personal insult or targeted abuse against someone"
                : "the answer to this yes/no question is yes"
            }
          />
        ) : null}
        {isScoreAnswer(answer) ? <ScoreDistribution answer={answer} /> : null}
      </div>
    </li>
  );
}

function SafetyComposition({ result }: { result: PreviewResult }) {
  const composition = composeSafetyRecommendation(result.fixture.response.answers);
  return (
    <div
      data-testid="composed-outcome"
      className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3"
    >
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
        Composed by application code — not a model answer
      </h4>
      <p className="mt-1.5 text-sm">
        <span className="font-semibold">Recommendation: </span>
        <span data-testid="safety-recommendation" className="font-semibold">
          {SAFETY_RECOMMENDATION_LABELS[composition.recommendation]}
        </span>
      </p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        {composition.reason}
      </p>
      {composition.conflict ? (
        <p
          data-testid="composition-conflict"
          className="mt-1.5 text-xs font-semibold text-[var(--color-warn)]"
        >
          The two independent Choice answers disagree.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        The targeted-insult probability is displayed only. Code does not
        threshold it into an automatic outcome; choosing a threshold needs
        evaluation that has not been done.
      </p>
    </div>
  );
}

function MunicipalComposition({ result }: { result: PreviewResult }) {
  const composition = composeMunicipalRouting(result.fixture.response.answers);
  return (
    <div
      data-testid="composed-outcome"
      className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3"
    >
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">
        Composed by application code — not a model answer
      </h4>
      <p className="mt-1.5 text-sm">
        <span className="font-semibold">Routing status: </span>
        <span data-testid="municipal-status" className="font-semibold">
          {MUNICIPAL_STATUS_LABELS[composition.status]}
        </span>
      </p>
      <p className="mt-1 text-sm">
        <span className="font-semibold">Agency: </span>
        <span data-testid="municipal-agency">
          {composition.recommendedAgency ??
            composition.tentativeAgency ??
            "None shown"}
        </span>
      </p>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        {composition.reason}
      </p>
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        No dispatch happens here. Nothing is sent to any agency.
      </p>
    </div>
  );
}

export function ResponsePanel({
  scenario,
  result,
  isStale,
  view,
  onViewChange,
}: {
  scenario: Scenario;
  /** Always the result for `scenario`, or null. Never another scenario's. */
  result: PreviewResult | null;
  isStale: boolean;
  view: ResponseView;
  onViewChange: (view: ResponseView) => void;
}) {
  return (
    <section
      aria-labelledby="response-heading"
      className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="response-heading"
          className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]"
        >
          Response
        </h2>
        <div
          role="group"
          aria-label="Response view"
          className="flex rounded-md border border-[var(--color-line)] p-0.5"
        >
          {(["cards", "json"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              data-testid={`view-${candidate}`}
              aria-pressed={view === candidate}
              onClick={() => onViewChange(candidate)}
              className={`rounded px-2.5 py-1 text-xs font-medium capitalize ${
                view === candidate
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-soft)]"
              }`}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>

      {result === null ? (
        <p
          data-testid="response-empty"
          className="mt-4 rounded-lg border border-dashed border-[var(--color-line)] p-4 text-sm text-[var(--color-ink-soft)]"
        >
          No fixture shown yet. Choose a sample or edit the State, then press
          Preview fixture.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <FixtureBadge />
            <span
              data-testid="fixture-kind"
              className="text-[11px] font-medium text-[var(--color-ink-soft)]"
            >
              {result.fixture.label}
            </span>
          </div>

          <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
            {result.fixture.disclaimer} {FIXTURE_EXPLANATION}
          </p>

          {isStale ? (
            <p
              data-testid="stale-warning"
              role="status"
              className="mt-3 rounded-lg border border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3 text-xs font-medium"
            >
              State has been edited since this fixture was shown. What you see
              below belongs to the earlier request snapshot, not to the State in
              the editor. Press Preview fixture again.
            </p>
          ) : null}

          {view === "cards" ? (
            <div className="mt-4 space-y-4">
              {scenario.id === "safety" ? (
                <SafetyComposition result={result} />
              ) : (
                <MunicipalComposition result={result} />
              )}

              <div>
                <h3 className="text-sm font-semibold">
                  Raw answers, one per question
                </h3>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  Every answer is preserved with its full distribution. These are
                  the fixture&rsquo;s values, kept separate from the composed
                  outcome above.
                </p>
                <ul role="list" className="mt-2 space-y-3">
                  {scenario.questionOrder.map((id) => {
                    const answer = result.fixture.response.answers[id];
                    if (!answer) return null;
                    return (
                      <AnswerCard
                        key={id}
                        id={id}
                        answer={answer}
                        scenarioId={scenario.id}
                      />
                    );
                  })}
                </ul>
              </div>

              <Measurement />
            </div>
          ) : (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Fixture response JSON</h3>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                <code>model</code> and <code>usage</code> are absent because no
                call was made. The cards above render exactly these values.
              </p>
              <pre
                data-testid="response-json"
                className="json-block mt-2 max-h-[28rem] overflow-auto rounded-md bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
              >
                {JSON.stringify(result.fixture.response, null, 2)}
              </pre>

              <h3 className="mt-4 text-sm font-semibold">
                Request snapshot this fixture belongs to
              </h3>
              <pre
                data-testid="snapshot-json"
                className="json-block mt-2 max-h-72 overflow-auto rounded-md bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
              >
                {JSON.stringify(result.requestSnapshot, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}

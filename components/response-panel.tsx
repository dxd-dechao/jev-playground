"use client";

/**
 * Panel 3 of 3: the response.
 *
 * Invariants this panel is responsible for:
 *  - Every result states its own source. A fixture shows the "Fixture data — no
 *    model call" badge; a live result shows a live badge and its measurements.
 *    The badge appears in Cards *and* JSON, and the source is carried on the
 *    result rather than inferred from what happens to be in view.
 *  - Raw answers are shown separately from the composed application outcome,
 *    which is explicitly tagged as code, not a model judgment.
 *  - Fixture measurement fields read "Unavailable". Nothing was measured, so
 *    nothing may look measured. Live fields show only what was really measured
 *    or returned; cost is never shown, because the API documents no cost field.
 *  - A result belongs to the request snapshot it was produced from. Editing
 *    State or questions marks it stale; it is never silently re-attached to new
 *    input, and a live result is never replaced by a fixture or vice versa.
 *  - Answer order, option labels, and the composed outcome come from that
 *    snapshot. Preset labels and preset composition apply only when the
 *    snapshot asked exactly the preset's default questions; otherwise the raw
 *    answers are shown under "Custom questions — preset composition not
 *    applied."
 */

import type { FixtureResult } from "@/lib/fixtures";
import {
  FIXTURE_BADGE_TEXT,
  FIXTURE_EXPLANATION,
  questionsMatchPreset,
} from "@/lib/fixtures";
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
import type {
  Answer,
  Answers,
  EvaluationRequest,
  EvaluationResponse,
  Instructions,
  LiveEvaluationPayload,
  Question,
} from "@/lib/types";
import { isChoiceAnswer, isNoulAnswer, isScoreAnswer } from "@/lib/types";
import {
  ChoiceDistribution,
  NoulProbability,
  ScoreDistribution,
} from "./probability-bars";

/** Which button produced a result. Carried, never guessed. */
export type PlaygroundMode = "fixture" | "live";

/** What a result and its request have in common, whatever the source. */
interface ResultBase {
  scenarioId: Scenario["id"];
  /**
   * The request as submitted — State and questions. Staleness, answer order,
   * option labels, and whether composition applies are all read from this, never
   * from the current editor or the scenario preset.
   */
  requestSnapshot: EvaluationRequest;
  /** The submitted questions' ids in the order they were shown when submitted. */
  questionOrder: string[];
}

/**
 * A displayed result.
 *
 * The union is the point: a live response is not a fixture with extra fields,
 * and nothing can read `result.fixture` off a real model answer. Adding a source
 * would force every reader to handle it.
 */
export type PlaygroundResult =
  | (ResultBase & { source: "fixture"; fixture: FixtureResult })
  | (ResultBase & { source: "live"; live: LiveEvaluationPayload });

/** A failed live submission, bound to the request that failed. */
export interface PlaygroundError extends ResultBase {
  source: "live";
  code: string;
  message: string;
}

export type ResponseView = "cards" | "json";

/** The answers to render, whichever source they came from. */
export function resultAnswers(result: PlaygroundResult): Answers {
  return result.source === "fixture"
    ? result.fixture.response.answers
    : result.live.response.answers;
}

/**
 * Answer ids in the order the snapshot's questions were shown when submitted.
 * Any answer id not in that order (there should be none: the route checks ids
 * both ways) is appended rather than hidden.
 */
function answerOrder(result: PlaygroundResult): string[] {
  const answers = resultAnswers(result);
  const ordered = result.questionOrder.filter((id) => id in answers);
  return [...ordered, ...Object.keys(answers).filter((id) => !ordered.includes(id))];
}

/** The response envelope to show in the JSON view. */
function resultResponse(result: PlaygroundResult): EvaluationResponse {
  return result.source === "fixture" ? result.fixture.response : result.live.response;
}

function FixtureBadge() {
  return (
    <span
      data-testid="fixture-badge"
      className="inline-flex items-center gap-1.5 border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-ink)]"
    >
      <span aria-hidden="true">●</span>
      {FIXTURE_BADGE_TEXT}
    </span>
  );
}

export const LIVE_BADGE_TEXT = "Live Jev response — real model call";

function LiveBadge() {
  return (
    <span
      data-testid="live-badge"
      className="inline-flex items-center gap-1.5 border-2 border-[var(--color-line)] bg-[var(--color-highlight)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-ink)]"
    >
      <span aria-hidden="true">●</span>
      {LIVE_BADGE_TEXT}
    </span>
  );
}

/** The one badge that belongs to this result's source. */
function SourceBadge({ result }: { result: PlaygroundResult }) {
  return result.source === "fixture" ? <FixtureBadge /> : <LiveBadge />;
}

function MeasurementRow({ field, value }: { field: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-[var(--color-ink-soft)]">{field}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/**
 * Measurements.
 *
 * Fixture mode: every field is "Unavailable", because no call happened.
 * Live mode: the duration was measured around the call, the resolved model is
 * the one TypeSafe reported, and each token count appears only if the response
 * carried that count — separately, so a response reporting one of the two shows
 * the real number beside an honest "Unavailable" instead of a zero. Cost is
 * always "Unavailable" — the API documents no cost field, and a computed
 * estimate here would be a guess wearing a measurement's clothes.
 */
function Measurement({ result }: { result: PlaygroundResult }) {
  const live = result.source === "live" ? result.live : null;
  const usage = live?.response.usage;
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;

  return (
    <div className="mt-4 border-2 border-[var(--color-line)] bg-[var(--color-panel)] p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
        Measurement
      </h4>
      <dl
        data-testid="measurement-block"
        className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
      >
        <MeasurementRow
          field="Requested model"
          value={live ? live.requestedModel : "Unavailable"}
        />
        <MeasurementRow
          field="Resolved model"
          value={live ? live.response.model : "Unavailable"}
        />
        <MeasurementRow
          field="Input tokens"
          value={inputTokens === undefined ? "Unavailable" : String(inputTokens)}
        />
        <MeasurementRow
          field="Output tokens"
          value={outputTokens === undefined ? "Unavailable" : String(outputTokens)}
        />
        <MeasurementRow
          field="Evaluation call duration"
          value={live ? `${live.durationMs} ms` : "Unavailable"}
        />
        <MeasurementRow field="Cost" value="Unavailable" />
      </dl>
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        {live ? (
          <>
            Duration is wall time measured around the evaluation call only, so it
            includes network time and excludes rendering. Cost is unavailable
            because the API documents no cost field; nothing here is an estimate.
            {inputTokens === undefined && outputTokens === undefined
              ? " This response carried no token counts, so none are shown."
              : inputTokens === undefined || outputTokens === undefined
                ? " This response reported only one of the two token counts. " +
                  "The other is unavailable, not zero."
                : null}
          </>
        ) : (
          "No request was sent, so there is nothing to measure."
        )}
      </p>
    </div>
  );
}

/** One line of text for a criteria description, whatever its shape. */
function describe(value: Instructions): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function AnswerCard({
  id,
  answer,
  question,
  scenarioId,
  presetMeanings,
}: {
  id: string;
  answer: Answer;
  /** The question as it was submitted, from the result's snapshot. */
  question: Question | undefined;
  scenarioId: Scenario["id"];
  /**
   * The snapshot asked exactly the preset's default questions, so the preset's
   * plain-language option labels still describe these options. For any edited
   * request the raw option keys are shown instead: a reused key such as
   * `handling` may now mean something else entirely.
   */
  presetMeanings: boolean;
}) {
  const optionLabels = !presetMeanings
    ? undefined
    : scenarioId === "safety" && id === "self_harm_context"
      ? (SAFETY_SELF_HARM_LABELS as Record<string, string>)
      : scenarioId === "safety" && id === "handling"
        ? (SAFETY_HANDLING_LABELS as Record<string, string>)
        : scenarioId === "municipal" && id === "disposition"
          ? (MUNICIPAL_DISPOSITION_LABELS as Record<string, string>)
          : undefined;

  const yesMeans =
    question?.type === "noul" && question.criteria?.true !== undefined
      ? describe(question.criteria.true)
      : undefined;

  return (
    <li
      data-testid={`answer-${id}`}
      className="border-2 border-[var(--color-line)] bg-[var(--color-panel)] p-3"
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
              presetMeanings && scenarioId === "safety" && id === "targeted_insult"
                ? "the student is using a personal insult or targeted abuse against someone"
                : "the answer to this yes/no question is yes"
            }
            yesMeans={presetMeanings ? undefined : yesMeans}
          />
        ) : null}
        {isScoreAnswer(answer) ? <ScoreDistribution answer={answer} /> : null}
      </div>
    </li>
  );
}

function SafetyComposition({ result }: { result: PlaygroundResult }) {
  const composition = composeSafetyRecommendation(resultAnswers(result));
  return (
    <div
      data-testid="composed-outcome"
      className="border-2 border-[var(--color-line)] bg-[var(--color-highlight)] p-3"
    >
      <h4 className="field-label">
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

function MunicipalComposition({ result }: { result: PlaygroundResult }) {
  const composition = composeMunicipalRouting(resultAnswers(result));
  return (
    <div
      data-testid="composed-outcome"
      className="border-2 border-[var(--color-line)] bg-[var(--color-highlight)] p-3"
    >
      <h4 className="field-label">
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
  mode,
  result,
  error,
  isStale,
  isErrorStale,
  isPending,
  view,
  onViewChange,
}: {
  scenario: Scenario;
  /** The mode whose slot is being displayed. */
  mode: PlaygroundMode;
  /**
   * Always the result for this exact `scenario` and `mode`, or null. The parent
   * keys results by both, so no switch can show another pair's answers.
   */
  result: PlaygroundResult | null;
  /** A live failure for this scenario. Kept visible; never replaced by a fixture. */
  error: PlaygroundError | null;
  isStale: boolean;
  isErrorStale: boolean;
  isPending: boolean;
  view: ResponseView;
  onViewChange: (view: ResponseView) => void;
}) {
  // Decided from the snapshot the result answers, never from the editor: an
  // answer to edited questions is not reinterpreted through the preset's rules
  // even if its ids happen to match the preset's.
  const presetQuestions =
    result !== null &&
    questionsMatchPreset(result.scenarioId, result.requestSnapshot.questions);

  return (
    <section aria-labelledby="response-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="response-heading" className="tag-heading">
          Response
        </h2>
        <div
          role="group"
          aria-label="Response view"
          className="flex border-2 border-[var(--color-line)] bg-[var(--color-panel)] shadow-[3px_3px_0_var(--color-line)]"
        >
          {(["cards", "json"] as const).map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              data-testid={`view-${candidate}`}
              aria-pressed={view === candidate}
              onClick={() => onViewChange(candidate)}
              className={`min-h-9 px-3 py-1 text-xs font-bold capitalize ${
                index > 0 ? "border-l-2 border-[var(--color-line)]" : ""
              } ${
                view === candidate
                  ? "bg-[var(--color-highlight)] text-[var(--color-ink)]"
                  : "bg-[var(--color-panel)] text-[var(--color-ink)] hover:bg-[var(--color-canvas)]"
              }`}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>

      <div className="hard-card mt-5 p-4">
        {isPending ? (
          <p
            data-testid="response-loading"
            role="status"
            aria-live="polite"
            className="mt-3 border-2 border-[var(--color-line)] bg-[var(--color-highlight)] p-3 text-sm font-medium"
          >
            Evaluating with Jev… one request is in flight. It will be cancelled
            after 30 seconds and will not be retried automatically.
          </p>
        ) : null}

        {error !== null ? (
          <div
            data-testid="live-error"
            role="alert"
            className="mt-3 border-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3"
          >
            <p className="text-sm font-semibold text-[var(--color-danger)]">
              The live evaluation failed
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink)]">{error.message}</p>
            <p
              data-testid="live-error-code"
              className="mt-1 font-mono text-[11px] text-[var(--color-ink-soft)]"
            >
              {error.code}
            </p>
            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
              No fixture was substituted. A failed model call has no answer, and
              showing a hand-written one here would misrepresent it.
              {isErrorStale
                ? " The request has since been edited, so this failure belongs to the earlier request."
                : null}
            </p>
          </div>
        ) : null}

        {result === null ? (
          <p
            data-testid="response-empty"
            className="mt-4 border-2 border-dashed border-[var(--color-line-soft)] p-4 text-sm text-[var(--color-ink-soft)]"
          >
            {mode === "fixture"
              ? "No fixture shown yet. Choose a sample or edit the State, then press Preview fixture."
              : "No live result yet. Press Evaluate with Jev to make one real model call with the State on the left."}
          </p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SourceBadge result={result} />
              {/* The source in plain words, present in Cards and JSON alike. */}
              <span
                data-testid="result-source"
                className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]"
              >
                {result.source === "fixture" ? "Source: fixture" : "Source: live"}
              </span>
              <span
                data-testid="fixture-kind"
                className="text-[11px] font-medium text-[var(--color-ink-soft)]"
              >
                {result.source === "fixture"
                  ? result.fixture.label
                  : `Model: ${result.live.response.model}`}
              </span>
            </div>

            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
              {result.source === "fixture" ? (
                <>
                  {result.fixture.disclaimer} {FIXTURE_EXPLANATION}
                </>
              ) : (
                <>
                  These answers came from a real TypeSafe call made when you pressed
                  Evaluate with Jev. They are this model&rsquo;s judgment of the
                  State you submitted, not a verdict on the student or the report,
                  and one response is not evidence of accuracy.
                </>
              )}
            </p>

            {isStale ? (
              <p
                data-testid="stale-warning"
                role="status"
                className="mt-3 border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3 text-xs font-medium"
              >
                The request (State or questions) has been edited since this
                result was produced. What you see below belongs to the earlier
                request snapshot, not to the request in the editor.{" "}
                {result.source === "fixture"
                  ? "Press Preview fixture again."
                  : "Press Evaluate with Jev again to spend another call on the new request."}
              </p>
            ) : null}

            {view === "cards" ? (
              <div className="mt-4 space-y-4">
                {!presetQuestions ? (
                  <p
                    data-testid="custom-composition-note"
                    className="border-2 border-dashed border-[var(--color-line-soft)] p-3 text-xs text-[var(--color-ink-soft)]"
                  >
                    <span className="font-semibold text-[var(--color-ink)]">
                      Custom questions — preset composition not applied.
                    </span>{" "}
                    This request did not ask exactly the preset&rsquo;s default
                    questions, so the preset&rsquo;s application rules would be
                    reading answers to questions they were not written for. The
                    raw answers are shown as returned, with no composed outcome.
                  </p>
                ) : scenario.id === "safety" ? (
                  <SafetyComposition result={result} />
                ) : (
                  <MunicipalComposition result={result} />
                )}

                <div>
                  <h3 className="text-sm font-semibold">
                    Raw answers, one per question
                  </h3>
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    Every answer is preserved with its full distribution, exactly
                    as {result.source === "fixture" ? "written" : "returned"}
                    {presetQuestions
                      ? ", kept separate from the composed outcome above."
                      : ", in the order the questions were submitted."}
                  </p>
                  <ul role="list" className="mt-2 space-y-3">
                    {answerOrder(result).map((id) => {
                      const answer = resultAnswers(result)[id];
                      if (!answer) return null;
                      return (
                        <AnswerCard
                          key={id}
                          id={id}
                          answer={answer}
                          question={result.requestSnapshot.questions[id]}
                          scenarioId={scenario.id}
                          presetMeanings={presetQuestions}
                        />
                      );
                    })}
                  </ul>
                </div>

                <Measurement result={result} />
              </div>
            ) : (
              <div className="mt-4">
                <h3 className="text-sm font-semibold">
                  {result.source === "fixture"
                    ? "Fixture response JSON"
                    : "Live response JSON"}
                </h3>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  {result.source === "fixture" ? (
                    <>
                      <code>model</code> and <code>usage</code> are absent because
                      no call was made. The cards above render exactly these values.
                    </>
                  ) : (
                    <>
                      The response as it was received, after being checked against
                      the questions that were submitted. <code>usage</code> and each
                      token count inside it appear only if TypeSafe returned them,
                      so an absent count is missing here rather than zero. The cards
                      above render exactly these values.
                    </>
                  )}
                </p>
                <pre
                  data-testid="response-json"
                  className="json-block mt-2 max-h-[28rem] overflow-auto border-2 border-[var(--color-line-soft)] bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
                >
                  {JSON.stringify(resultResponse(result), null, 2)}
                </pre>

                {result.source === "live" ? (
                  <dl
                    data-testid="json-measurement"
                    className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
                  >
                    <MeasurementRow
                      field="Requested model"
                      value={result.live.requestedModel}
                    />
                    <MeasurementRow
                      field="Evaluation call duration"
                      value={`${result.live.durationMs} ms`}
                    />
                    <MeasurementRow field="Cost" value="Unavailable" />
                  </dl>
                ) : null}

                <h3 className="mt-4 text-sm font-semibold">
                  {result.source === "fixture"
                    ? "Request snapshot this fixture belongs to"
                    : "Request snapshot that was sent"}
                </h3>
                <pre
                  data-testid="snapshot-json"
                  className="json-block mt-2 max-h-72 overflow-auto border-2 border-[var(--color-line-soft)] bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
                >
                  {JSON.stringify(result.requestSnapshot, null, 2)}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

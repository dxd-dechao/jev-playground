"use client";

/**
 * Panel 3 of 3: the response.
 *
 * Invariants this panel is responsible for:
 *  - Every result is a live engine response and says so: the Jev or LLM badge
 *    appears in Cards *and* JSON, with the model and measurements it reported.
 *    Nothing hand-written is ever shown in its place, including after a failure.
 *    A single-engine result keeps Measurement under that engine's answers. A
 *    Both comparison moves one Measurement block to the top of the card.
 *  - Raw answers are shown separately from the composed application outcome,
 *    which is explicitly tagged as code, not a model judgment.
 *  - Measurement fields show only what was really measured or returned; cost
 *    is never shown, because the API documents no cost field.
 *  - A result belongs to the request snapshot it was produced from. Editing
 *    State or questions marks it stale; it is never silently re-attached to new
 *    input.
 *  - Answer order, option labels, and the composed outcome come from that
 *    snapshot. Preset labels and preset composition apply only when the
 *    snapshot asked exactly the preset's default questions; otherwise the raw
 *    answers are shown under "Custom questions — preset composition not
 *    applied."
 */

import { questionsMatchPreset } from "@/lib/fixtures";
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

/** What a result and a failure have in common: the request they belong to. */
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

/** A displayed live result, bound to the request it answers. */
export interface PlaygroundResult extends ResultBase {
  source: "live";
  live: LiveEvaluationPayload;
}

/** A failed live submission, bound to the request that failed. */
export interface PlaygroundError extends ResultBase {
  source: "live";
  code: string;
  message: string;
}

export type ResponseView = "cards" | "json";

/** The answers to render. */
export function resultAnswers(result: PlaygroundResult): Answers {
  return result.live.response.answers;
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
  return result.live.response;
}

export const LIVE_BADGE_TEXT = "Live Jev response — real model call";
export const LLM_BADGE_TEXT = "Live LLM response — real model call";

export type EngineId = "jev" | "llm";

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

function LlmBadge() {
  return (
    <span
      data-testid="llm-badge"
      className="inline-flex items-center gap-1.5 border-2 border-[var(--color-line)] bg-[var(--color-highlight)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-ink)]"
    >
      <span aria-hidden="true">●</span>
      {LLM_BADGE_TEXT}
    </span>
  );
}

function MeasurementRow({ field, value }: { field: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-[var(--color-ink-soft)]">{field}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

type MeasurementFields = {
  requestedModel: string;
  resolvedModel: string;
  inputTokens: string;
  outputTokens: string;
  duration: string;
  cost: string;
};

function tokenLabel(count: number | undefined): string {
  return count === undefined ? "Unavailable" : String(count);
}

function fieldsFromResult(result: PlaygroundResult): MeasurementFields {
  const live = result.live;
  const usage = live.response.usage;
  return {
    requestedModel: live.requestedModel,
    resolvedModel: live.response.model,
    inputTokens: tokenLabel(usage?.input_tokens),
    outputTokens: tokenLabel(usage?.output_tokens),
    duration: `${live.durationMs} ms`,
    cost: "Unavailable",
  };
}

const EVALUATING_FIELDS: MeasurementFields = {
  requestedModel: "Evaluating…",
  resolvedModel: "Evaluating…",
  inputTokens: "Evaluating…",
  outputTokens: "Evaluating…",
  duration: "Evaluating…",
  cost: "Evaluating…",
};

const UNAVAILABLE_FIELDS: MeasurementFields = {
  requestedModel: "Unavailable",
  resolvedModel: "Unavailable",
  inputTokens: "Unavailable",
  outputTokens: "Unavailable",
  duration: "Unavailable",
  cost: "Unavailable",
};

function comparisonFields(
  result: PlaygroundResult | null,
  waiting: boolean,
): MeasurementFields {
  if (waiting) return EVALUATING_FIELDS;
  if (result === null) return UNAVAILABLE_FIELDS;
  return fieldsFromResult(result);
}

function MeasurementRows({ fields }: { fields: MeasurementFields }) {
  return (
    <>
      <MeasurementRow field="Requested model" value={fields.requestedModel} />
      <MeasurementRow field="Resolved model" value={fields.resolvedModel} />
      <MeasurementRow field="Input tokens" value={fields.inputTokens} />
      <MeasurementRow field="Output tokens" value={fields.outputTokens} />
      <MeasurementRow field="Evaluation call duration" value={fields.duration} />
      <MeasurementRow field="Cost" value={fields.cost} />
    </>
  );
}

function MeasurementHonesty({
  inputTokens,
  outputTokens,
}: {
  inputTokens?: number;
  outputTokens?: number;
}) {
  return (
    <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
      Duration is wall time measured around the evaluation call only, so it
      includes network time and excludes rendering. Cost is unavailable
      because the API documents no cost field; nothing here is an estimate.
      {inputTokens === undefined && outputTokens === undefined
        ? " This response carried no token counts, so none are shown."
        : inputTokens === undefined || outputTokens === undefined
          ? " This response reported only one of the two token counts. " +
            "The other is unavailable, not zero."
          : null}
    </p>
  );
}

/**
 * Measurements.
 *
 * The duration was measured around the call, the resolved model is
 * the one TypeSafe reported, and each token count appears only if the response
 * carried that count — separately, so a response reporting one of the two shows
 * the real number beside an honest "Unavailable" instead of a zero. Cost is
 * always "Unavailable" — the API documents no cost field, and a computed
 * estimate here would be a guess wearing a measurement's clothes.
 */
function Measurement({ result }: { result: PlaygroundResult }) {
  const usage = result.live.response.usage;
  return (
    <div className="mt-4 border-2 border-[var(--color-line)] bg-[var(--color-panel)] p-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
        Measurement
      </h4>
      <dl
        data-testid="measurement-block"
        className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
      >
        <MeasurementRows fields={fieldsFromResult(result)} />
      </dl>
      <MeasurementHonesty
        inputTokens={usage?.input_tokens}
        outputTokens={usage?.output_tokens}
      />
    </div>
  );
}

function ComparisonMeasurement({
  jevResult,
  llmResult,
  jevWaiting,
  llmWaiting,
}: {
  jevResult: PlaygroundResult | null;
  llmResult: PlaygroundResult | null;
  jevWaiting: boolean;
  llmWaiting: boolean;
}) {
  return (
    <div
      data-testid="comparison-measurement"
      className="border-2 border-[var(--color-line)] bg-[var(--color-panel)] p-3"
    >
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
        Measurement
      </h4>
      <div className="comparison-columns mt-2">
        <div>
          <h5 className="text-xs font-extrabold">Jev</h5>
          <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs">
            <MeasurementRows fields={comparisonFields(jevResult, jevWaiting)} />
          </dl>
        </div>
        <div>
          <h5 className="text-xs font-extrabold">LLM</h5>
          <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs">
            <MeasurementRows fields={comparisonFields(llmResult, llmWaiting)} />
          </dl>
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        Duration is wall time measured around each evaluation call only, so it
        includes network time and excludes rendering. Cost is unavailable
        because the APIs document no cost field; nothing here is an estimate.
        A count the response omitted is unavailable, not zero.
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
      <p className="text-sm">
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
      <p className="text-sm">
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

function EngineResultBody({
  engine,
  scenario,
  result,
  isStale,
  view,
  hideMeasurement,
}: {
  engine: EngineId;
  scenario: Scenario;
  result: PlaygroundResult;
  isStale: boolean;
  view: ResponseView;
  hideMeasurement: boolean;
}) {
  const presetQuestions = questionsMatchPreset(
    result.scenarioId,
    result.requestSnapshot.questions,
  );
  const repeatHint =
    engine === "jev" ? "Press Evaluate with Jev again" : "Press Evaluate with LLM again";

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {engine === "jev" ? <LiveBadge /> : <LlmBadge />}
        <span
          data-testid={engine === "jev" ? "result-model" : "llm-result-model"}
          className="text-[11px] font-medium text-[var(--color-ink-soft)]"
        >
          {`Model: ${result.live.response.model}`}
        </span>
      </div>

      <p
        data-testid={engine === "jev" ? "result-intro" : "llm-result-intro"}
        className="mt-2 text-xs text-[var(--color-ink-soft)]"
      >
        {engine === "jev"
          ? "These answers came from a real TypeSafe call made when you pressed Evaluate with Jev. They are this model\u2019s judgment of the State you submitted."
          : "These answers came from the language-model call when you pressed Evaluate with LLM. They are this model\u2019s judgment of the State you submitted."}
      </p>

      {isStale ? (
        <p
          data-testid={engine === "jev" ? "stale-warning" : "llm-stale-warning"}
          role="status"
          className="mt-3 border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3 text-xs font-medium"
        >
          The request (State or questions) has been edited since this result was
          produced. What you see below belongs to the earlier request snapshot,
          not to the request in the editor. {repeatHint} to spend another call
          on the new request.
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
              questions, so the preset&rsquo;s application rules would be reading
              answers to questions they were not written for. The raw answers are
              shown as returned, with no composed outcome.
            </p>
          ) : scenario.id === "safety" ? (
            <SafetyComposition result={result} />
          ) : (
            <MunicipalComposition result={result} />
          )}

          <div>
            <h3 className="text-sm font-semibold">Raw answers, one per question</h3>
            <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
              Every answer is preserved with its full distribution, exactly as
              returned
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

          {hideMeasurement ? null : <Measurement result={result} />}
        </div>
      ) : (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Live response JSON</h3>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
            The response as it was received, after being checked against the
            questions that were submitted. <code>usage</code> and each token count
            inside it appear only if the service returned them, so an absent
            count is missing here rather than zero. The cards above render
            exactly these values.
          </p>
          <pre
            data-testid={engine === "jev" ? "response-json" : "llm-response-json"}
            className="json-block mt-2 max-h-[28rem] overflow-auto border-2 border-[var(--color-line-soft)] bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
          >
            {JSON.stringify(resultResponse(result), null, 2)}
          </pre>

          {hideMeasurement ? null : (
            <dl
              data-testid={engine === "jev" ? "json-measurement" : "llm-json-measurement"}
              className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs"
            >
              <MeasurementRow field="Requested model" value={result.live.requestedModel} />
              <MeasurementRow
                field="Evaluation call duration"
                value={`${result.live.durationMs} ms`}
              />
              <MeasurementRow field="Cost" value="Unavailable" />
            </dl>
          )}

          <h3 className="mt-4 text-sm font-semibold">Request snapshot that was sent</h3>
          <pre
            data-testid={engine === "jev" ? "snapshot-json" : "llm-snapshot-json"}
            className="json-block mt-2 max-h-72 overflow-auto border-2 border-[var(--color-line-soft)] bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
          >
            {JSON.stringify(result.requestSnapshot, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}

function EngineSection({
  engine,
  scenario,
  result,
  error,
  isStale,
  isErrorStale,
  isWaiting,
  view,
  wrap,
  hideMeasurement,
}: {
  engine: EngineId;
  scenario: Scenario;
  result: PlaygroundResult | null;
  error: PlaygroundError | null;
  isStale: boolean;
  isErrorStale: boolean;
  isWaiting: boolean;
  view: ResponseView;
  wrap: boolean;
  hideMeasurement: boolean;
}) {
  const loadingTestId = engine === "jev" ? "response-loading" : "response-loading-llm";
  const loadingLabel =
    engine === "jev"
      ? "Evaluating with Jev… one request is in flight. It will be cancelled after 30 seconds and will not be retried automatically."
      : "Evaluating with LLM… one request is in flight. It will be cancelled after 30 seconds and will not be retried automatically.";

  const body = (
    <>
      {isWaiting ? (
        <p
          data-testid={loadingTestId}
          role="status"
          aria-live="polite"
          className="mt-3 border-2 border-[var(--color-line)] bg-[var(--color-highlight)] p-3 text-sm font-medium"
        >
          {loadingLabel}
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
          {isErrorStale ? (
            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
              The request has since been edited, so this failure belongs to the
              earlier request.
            </p>
          ) : null}
        </div>
      ) : null}

      {result !== null ? (
        <EngineResultBody
          engine={engine}
          scenario={scenario}
          result={result}
          isStale={isStale}
          view={view}
          hideMeasurement={hideMeasurement}
        />
      ) : null}
    </>
  );

  if (!wrap) return body;
  return (
    <div
      data-testid={engine === "jev" ? "response-engine-jev" : "response-engine-llm"}
      className="mt-4 border-t-2 border-[var(--color-line-soft)] pt-4 first:mt-0 first:border-t-0 first:pt-0"
    >
      {body}
    </div>
  );
}

export function ResponsePanel({
  scenario,
  jevResult,
  llmResult,
  jevError,
  llmError,
  jevStale,
  llmStale,
  jevErrorStale,
  llmErrorStale,
  waitingEngines,
  comparison,
  view,
  onViewChange,
}: {
  scenario: Scenario;
  jevResult: PlaygroundResult | null;
  llmResult: PlaygroundResult | null;
  jevError: PlaygroundError | null;
  llmError: PlaygroundError | null;
  jevStale: boolean;
  llmStale: boolean;
  jevErrorStale: boolean;
  llmErrorStale: boolean;
  waitingEngines: EngineId[];
  comparison: boolean;
  view: ResponseView;
  onViewChange: (view: ResponseView) => void;
}) {
  const jevWaiting = waitingEngines.includes("jev");
  const llmWaiting = waitingEngines.includes("llm");
  const showJev = jevResult !== null || jevError !== null || jevWaiting;
  const showLlm = llmResult !== null || llmError !== null || llmWaiting;
  const wrap = showJev && showLlm;
  const neitherResult = jevResult === null && llmResult === null;
  const showComparison = comparison && (showJev || showLlm);

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
        {showComparison ? (
          <ComparisonMeasurement
            jevResult={jevResult}
            llmResult={llmResult}
            jevWaiting={jevWaiting}
            llmWaiting={llmWaiting}
          />
        ) : null}

        {showJev ? (
          <EngineSection
            engine="jev"
            scenario={scenario}
            result={jevResult}
            error={jevError}
            isStale={jevStale}
            isErrorStale={jevErrorStale}
            isWaiting={jevWaiting}
            view={view}
            wrap={wrap}
            hideMeasurement={showComparison}
          />
        ) : null}

        {showLlm ? (
          <EngineSection
            engine="llm"
            scenario={scenario}
            result={llmResult}
            error={llmError}
            isStale={llmStale}
            isErrorStale={llmErrorStale}
            isWaiting={llmWaiting}
            view={view}
            wrap={wrap}
            hideMeasurement={showComparison}
          />
        ) : null}

        {neitherResult ? (
          <p
            data-testid="response-empty"
            className="mt-4 border-2 border-dashed border-[var(--color-line-soft)] p-4 text-sm text-[var(--color-ink-soft)]"
          >
            No result yet. Press Evaluate with Jev, Evaluate with LLM, or
            Evaluate with both.
          </p>
        ) : null}
      </div>
    </section>
  );
}

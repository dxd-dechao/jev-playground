"use client";

/**
 * Panel 2 of 3: the request.
 *
 * What is editable in JEV-01: the State JSON. Sample buttons replace State
 * only; Reset restores the whole preset. Full question editing, add/remove
 * controls, and an editable whole-request JSON view are deferred to a later
 * task, so the questions and the combined request are rendered read-only.
 */

import { useId } from "react";
import type { Question, Questions } from "@/lib/types";
import type { Scenario } from "@/lib/scenarios";
import { sampleGroups } from "@/lib/scenarios";

function questionTypeLabel(question: Question): string {
  switch (question.type) {
    case "noul":
      return "Noul (yes/no probability)";
    case "choice":
      return "Choice (one option + distribution)";
    case "score":
      return "Score (level rating + distribution)";
  }
}

function InstructionsBody({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <p className="text-sm text-[var(--color-ink-soft)]">{value}</p>;
  }
  return (
    <pre className="json-block mt-1 rounded-md bg-[var(--color-canvas)] p-2 font-mono text-xs text-[var(--color-ink-soft)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function CriteriaBody({ question }: { question: Question }) {
  if (question.type === "noul") {
    const criteria = question.criteria;
    if (!criteria) return null;
    return (
      <dl className="mt-2 space-y-1 text-sm">
        {criteria.true !== undefined ? (
          <div>
            <dt className="inline font-medium">Yes means: </dt>
            <dd className="inline text-[var(--color-ink-soft)]">
              {typeof criteria.true === "string"
                ? criteria.true
                : JSON.stringify(criteria.true)}
            </dd>
          </div>
        ) : null}
        {criteria.false !== undefined ? (
          <div>
            <dt className="inline font-medium">No means: </dt>
            <dd className="inline text-[var(--color-ink-soft)]">
              {typeof criteria.false === "string"
                ? criteria.false
                : JSON.stringify(criteria.false)}
            </dd>
          </div>
        ) : null}
      </dl>
    );
  }

  if (question.type === "choice") {
    return (
      <dl className="mt-2 space-y-1.5 text-sm">
        {Object.entries(question.criteria).map(([option, description]) => (
          <div key={option}>
            <dt className="inline font-mono text-xs font-semibold">{option}</dt>
            <dd className="inline text-[var(--color-ink-soft)]">
              {description === null
                ? " — no extra detail"
                : ` — ${
                    typeof description === "string"
                      ? description
                      : JSON.stringify(description)
                  }`}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <ol className="mt-2 space-y-1 text-sm text-[var(--color-ink-soft)]">
      {question.criteria.map((level, index) => (
        <li key={index}>
          <span className="font-mono text-xs font-semibold text-[var(--color-ink)]">
            {index}
          </span>{" "}
          — {typeof level === "string" ? level : JSON.stringify(level)}
        </li>
      ))}
    </ol>
  );
}

export function RequestEditor({
  scenario,
  stateText,
  onStateTextChange,
  onLoadSample,
  onReset,
  matchedSampleId,
  parseError,
  validationErrors,
  canPreview,
  onPreview,
}: {
  scenario: Scenario;
  stateText: string;
  onStateTextChange: (text: string) => void;
  onLoadSample: (sampleId: string) => void;
  onReset: () => void;
  /** The sample whose State the current draft exactly matches, if any. */
  matchedSampleId: string | null;
  /** JSON syntax error message, if the draft does not parse. */
  parseError: string | null;
  /** Schema problems, if the draft parses but is not a valid request. */
  validationErrors: string[];
  canPreview: boolean;
  onPreview: () => void;
}) {
  const textareaId = useId();
  const errorId = useId();
  const questions: Questions = scenario.questions;
  const hasProblem = parseError !== null || validationErrors.length > 0;

  const requestPreview = (() => {
    let parsedState: unknown = null;
    try {
      parsedState = JSON.parse(stateText);
    } catch {
      return null;
    }
    return JSON.stringify({ state: parsedState, questions }, null, 2);
  })();

  return (
    <section
      aria-labelledby="request-heading"
      className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5"
    >
      <h2
        id="request-heading"
        className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]"
      >
        Request
      </h2>

      {/* Sample states ------------------------------------------------- */}
      <div className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Sample states</h3>
          <button
            type="button"
            data-testid="reset-preset"
            onClick={onReset}
            className="rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium hover:border-[var(--color-ink-soft)]"
          >
            Reset to preset
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          A sample button replaces the State below. Reset restores this
          scenario&rsquo;s default State.
        </p>

        {sampleGroups(scenario).map((group) => (
          <div key={group.group} className="mt-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
              {group.group}
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {group.samples.map((sample) => {
                const isLoaded = sample.id === matchedSampleId;
                return (
                  <button
                    key={sample.id}
                    type="button"
                    data-testid={`sample-${sample.id}`}
                    aria-pressed={isLoaded}
                    onClick={() => onLoadSample(sample.id)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                      isLoaded
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-ink)]"
                        : "border-[var(--color-line)] hover:border-[var(--color-ink-soft)]"
                    }`}
                  >
                    {sample.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {matchedSampleId ? (
          <SampleMetadata scenario={scenario} sampleId={matchedSampleId} />
        ) : (
          <p
            data-testid="custom-state-note"
            className="mt-3 rounded-lg border border-dashed border-[var(--color-line)] p-2.5 text-xs text-[var(--color-ink-soft)]"
          >
            Custom State — this does not match any sample, so no sample fixture
            or expected outcome applies.
          </p>
        )}
      </div>

      {/* State editor -------------------------------------------------- */}
      <div className="mt-6">
        <label htmlFor={textareaId} className="text-sm font-semibold">
          State (editable JSON)
        </label>
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          This is what the questions are evaluated against. Expected labels must
          not appear here.
        </p>
        <textarea
          id={textareaId}
          data-testid="state-editor"
          value={stateText}
          spellCheck={false}
          onChange={(event) => onStateTextChange(event.target.value)}
          aria-invalid={hasProblem}
          aria-describedby={hasProblem ? errorId : undefined}
          rows={14}
          className={`mt-2 w-full resize-y rounded-lg border bg-[var(--color-canvas)] p-3 font-mono text-xs leading-relaxed ${
            hasProblem
              ? "border-[var(--color-danger)]"
              : "border-[var(--color-line)]"
          }`}
        />

        {hasProblem ? (
          <div
            id={errorId}
            data-testid="state-errors"
            role="alert"
            className="mt-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3"
          >
            {parseError !== null ? (
              <>
                <p className="text-sm font-semibold text-[var(--color-danger)]">
                  This State is not valid JSON, so it cannot be previewed.
                </p>
                <p className="mt-1 font-mono text-xs text-[var(--color-ink)]">
                  {parseError}
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                  Your text has been kept exactly as you typed it. Fix the
                  syntax — usually a missing comma, quote, or brace — or press
                  Reset to preset.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-[var(--color-danger)]">
                  This request does not match the expected shape, so it cannot
                  be previewed.
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-[var(--color-ink)]">
                  {validationErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="preview-fixture"
            disabled={!canPreview}
            onClick={onPreview}
            className="rounded-md bg-[var(--color-accent)] px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[var(--color-ink-soft)]/35 disabled:text-[var(--color-ink-soft)]"
          >
            Preview fixture
          </button>
          <span className="text-xs text-[var(--color-ink-soft)]">
            Shows a fixed illustrative response. No model is called and no
            request leaves your browser.
          </span>
        </div>
      </div>

      {/* Questions ----------------------------------------------------- */}
      <div className="mt-6 border-t border-[var(--color-line)] pt-4">
        <h3 className="text-sm font-semibold">
          Questions ({scenario.questionOrder.length}, evaluated together)
        </h3>
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
          Read-only in this version. Each question is self-contained: a question
          id is not sent to the model, and no question can read another
          question&rsquo;s answer in the same request.
        </p>
        <ul role="list" className="mt-3 space-y-3">
          {scenario.questionOrder.map((id) => {
            const question = questions[id];
            if (!question) return null;
            return (
              <li
                key={id}
                data-testid={`question-${id}`}
                className="rounded-lg border border-[var(--color-line)] p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs font-semibold">{id}</span>
                  <span className="text-[11px] font-medium text-[var(--color-ink-soft)]">
                    {questionTypeLabel(question)}
                  </span>
                </div>
                <div className="mt-2">
                  <InstructionsBody value={question.instructions} />
                </div>
                <CriteriaBody question={question} />
              </li>
            );
          })}
        </ul>
      </div>

      {/* Full request JSON --------------------------------------------- */}
      <details className="mt-5 rounded-lg border border-[var(--color-line)] p-3">
        <summary className="cursor-pointer text-sm font-semibold">
          Full request JSON (read-only)
        </summary>
        <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
          The <code>{"{ state, questions }"}</code> pair as it would be
          submitted. <code>model</code> is absent by design: it belongs to the
          server in a later task, and nothing is submitted in this version.
        </p>
        <pre
          data-testid="request-json"
          className="json-block mt-2 max-h-80 overflow-auto rounded-md bg-[var(--color-canvas)] p-3 font-mono text-[11px] leading-relaxed"
        >
          {requestPreview ??
            "State is not valid JSON, so the combined request cannot be shown."}
        </pre>
      </details>
    </section>
  );
}

function SampleMetadata({
  scenario,
  sampleId,
}: {
  scenario: Scenario;
  sampleId: string;
}) {
  const sample = scenario.samples.find((entry) => entry.id === sampleId);
  if (!sample) return null;
  return (
    <div
      data-testid="selected-sample-info"
      className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] p-3"
    >
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
        Sample metadata — not submitted
      </h4>
      <p className="mt-1 text-xs text-[var(--color-ink)]">
        <span className="font-semibold">Proposed expected outcome:</span>{" "}
        {sample.expected}
      </p>
      {sample.note ? (
        <p className="mt-1 text-xs text-[var(--color-ink-soft)]">{sample.note}</p>
      ) : null}
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        This expectation is a proposal for review, not measured Jev performance.
        It is held outside State and is never sent.
      </p>
    </div>
  );
}

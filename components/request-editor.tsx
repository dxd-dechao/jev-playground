"use client";

/**
 * Panel 2 of 3: the request.
 *
 * What is editable: the whole `{ state, questions }` request, in either of two
 * equivalent views.
 *
 *  - **Form** — State as JSON or as literal Text, and every question's id,
 *    type, instructions, and criteria (see `question-editor.tsx`).
 *  - **Whole-request JSON** — exactly `{ state, questions }` as one text box.
 *    A valid edit carries over to the Form; an invalid one is kept verbatim,
 *    blocks submission, and leaves the Form read-only until it is fixed or the
 *    preset is explicitly reset.
 *
 * Sample buttons replace State only and keep the questions; Reset restores the
 * whole preset. This panel also owns the choice between Fixture and Live. The
 * two actions have different consequences: one shows hand-written data for the
 * default questions, the other spends a real model call. Nothing here submits
 * anything on its own — typing, choosing a sample, resetting, and switching
 * mode or view never trigger a call. Cmd/Ctrl+Enter is handled by the page and
 * obeys the same guards as the button.
 */

import { useId } from "react";
import type {
  DraftReading,
  QuestionRow,
  RequestDraft,
  RequestView,
  StateMode,
} from "@/lib/request-draft";
import { stateEditorText } from "@/lib/request-draft";
import type { Scenario } from "@/lib/scenarios";
import { sampleGroups } from "@/lib/scenarios";
import type { ConfigStatus } from "@/lib/types";
import { QuestionEditor } from "./question-editor";
import type { PlaygroundMode } from "./response-panel";

/** The two things submitting can mean. */
const MODE_LABELS: Record<PlaygroundMode, string> = {
  fixture: "Fixture",
  live: "Live",
};

const MODE_DESCRIPTIONS: Record<PlaygroundMode, string> = {
  fixture:
    "Shows a fixed illustrative response for the default questions. No model is called and no request leaves your browser.",
  live: "Sends this request — State and questions — to TypeSafe Jev once per submission. One submission, one real billed call, no automatic retries.",
};

/** One half of a two-way switch: yellow when chosen. */
const segmentClass = (active: boolean) =>
  `min-h-9 px-3 py-1 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:text-[var(--color-ink-soft)] disabled:line-through ${
    active
      ? "bg-[var(--color-highlight)] text-[var(--color-ink)]"
      : "bg-[var(--color-panel)] text-[var(--color-ink)] hover:bg-[var(--color-canvas)]"
  }`;

export function RequestEditor({
  scenario,
  draft,
  reading,
  formLocked,
  validationErrors,
  warnings,
  isRequestValid,
  questionsAreDefault,
  matchedSampleId,
  onStateModeChange,
  onStateTextChange,
  onRowsChange,
  onViewChange,
  onRequestJsonChange,
  onLoadSample,
  onReset,
  mode,
  onModeChange,
  configStatus,
  onRecheckConfig,
  isPending,
  canSubmit,
  onSubmit,
}: {
  scenario: Scenario;
  draft: RequestDraft;
  /** What the draft currently asks, or its conversion problems. */
  reading: DraftReading;
  /** Raw JSON is invalid and authoritative: the Form must not be edited. */
  formLocked: boolean;
  /** Schema problems, if the draft converts but is not a valid request. */
  validationErrors: string[];
  /** Non-blocking notes about a valid request. */
  warnings: string[];
  /** The draft converts and validates. Necessary for either action, not sufficient. */
  isRequestValid: boolean;
  /** The questions are exactly the preset's defaults, so a fixture can exist. */
  questionsAreDefault: boolean;
  /** The sample whose State the current draft exactly matches, if any. */
  matchedSampleId: string | null;
  onStateModeChange: (mode: StateMode) => void;
  onStateTextChange: (text: string) => void;
  onRowsChange: (rows: QuestionRow[]) => void;
  onViewChange: (view: RequestView) => void;
  onRequestJsonChange: (text: string) => void;
  onLoadSample: (sampleId: string) => void;
  onReset: () => void;
  mode: PlaygroundMode;
  onModeChange: (mode: PlaygroundMode) => void;
  /** What the server said about its own configuration. Never a key or a fragment. */
  configStatus: ConfigStatus;
  onRecheckConfig: () => void;
  /** A live call for this scenario is in flight. */
  isPending: boolean;
  /** Every guard for the current mode passes. The page computes it once. */
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  const stateTextareaId = useId();
  const stateErrorId = useId();
  const jsonTextareaId = useId();
  const problemsId = useId();
  const submitNoteId = useId();

  // The Form can be serialized to JSON only when it converts; duplicate ids,
  // for instance, have no faithful JSON object form.
  const canOpenJson = draft.requestJson !== null || reading.request !== null;
  const problems = [...reading.errors, ...validationErrors];
  const hasProblems = problems.length > 0;
  // How many questions the one request would carry, when it can be read.
  const questionCount =
    reading.request !== null ? Object.keys(reading.request.questions).length : null;

  return (
    <section aria-labelledby="request-heading">
      {/* Heading and view switch ------------------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="request-heading" className="tag-heading">
          Request
        </h2>
        <div
          role="group"
          aria-label="Request view"
          className="flex border-2 border-[var(--color-line)] bg-[var(--color-panel)] shadow-[3px_3px_0_var(--color-line)]"
        >
          <button
            type="button"
            data-testid="request-view-form"
            aria-pressed={draft.view === "form"}
            onClick={() => onViewChange("form")}
            className={segmentClass(draft.view === "form")}
          >
            Form
          </button>
          <button
            type="button"
            data-testid="request-view-json"
            aria-pressed={draft.view === "json"}
            disabled={!canOpenJson}
            onClick={() => onViewChange("json")}
            className={`${segmentClass(draft.view === "json")} border-l-2 border-[var(--color-line)]`}
          >
            Whole-request JSON
          </button>
        </div>
      </div>
      {!canOpenJson ? (
        <p data-testid="json-view-blocked" className="mt-2 text-xs text-[var(--color-ink-soft)]">
          The JSON view opens once the Form can be written as one JSON object:
          fix the duplicate ids or invalid JSON fields listed below first.
        </p>
      ) : null}

      <details data-testid="scenario-about" className="disclosure mt-4 text-sm">
        <summary className="inline-block font-semibold">About this scenario</summary>
        <div className="mt-2 space-y-2 border-l-4 border-[var(--color-line)] pl-3">
          <p>{scenario.purpose}</p>
          <p
            data-testid="scenario-caveat"
            className="border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-2.5 text-xs"
          >
            {scenario.caveat}
          </p>
        </div>
      </details>

      {/* Mode, configuration and the one submission ------------------------ */}
      <div data-testid="submit-area" className="hard-card mt-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="field-label" id={`${submitNoteId}-mode`}>
            Mode
          </span>
          <div
            role="group"
            aria-label="Evaluation mode"
            className="flex border-2 border-[var(--color-line)]"
          >
            {(["fixture", "live"] as const).map((candidate, index) => (
              <button
                key={candidate}
                type="button"
                data-testid={`mode-${candidate}`}
                aria-pressed={mode === candidate}
                onClick={() => onModeChange(candidate)}
                className={`${segmentClass(mode === candidate)} ${
                  index > 0 ? "border-l-2 border-[var(--color-line)]" : ""
                }`}
              >
                {MODE_LABELS[candidate]}
              </button>
            ))}
          </div>
        </div>
        <p data-testid="mode-description" className="mt-2 text-xs text-[var(--color-ink-soft)]">
          {MODE_DESCRIPTIONS[mode]}
        </p>
        {mode === "live" ? (
          <ConfigNotice status={configStatus} onRecheck={onRecheckConfig} />
        ) : null}
        {mode === "fixture" && reading.request !== null && !questionsAreDefault ? (
          <p
            data-testid="fixture-unavailable"
            className="mt-2 border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-2.5 text-xs text-[var(--color-ink)]"
          >
            No fixture exists for these questions. Fixtures were written by hand
            as answers to this scenario&rsquo;s default questions, and showing
            them here would present old answers as answers to your criteria.
            Switch to Live to evaluate the edited questions — your edits are
            kept — or Reset to preset.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          {mode === "fixture" ? (
            <button
              type="button"
              data-testid="preview-fixture"
              disabled={!canSubmit}
              aria-describedby={`${submitNoteId}${hasProblems ? ` ${problemsId}` : ""}`}
              onClick={onSubmit}
              className="btn-primary"
            >
              <span aria-hidden="true">▶</span>
              Preview fixture
            </button>
          ) : (
            <button
              type="button"
              data-testid="evaluate-live"
              disabled={!canSubmit}
              aria-busy={isPending}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-describedby={`${submitNoteId}${hasProblems ? ` ${problemsId}` : ""}`}
              onClick={onSubmit}
              className="btn-primary"
            >
              <span aria-hidden="true">▶</span>
              {isPending ? "Evaluating with Jev…" : "Evaluate with Jev"}
            </button>
          )}
          <div id={submitNoteId} className="min-w-0 flex-1 basis-56 text-xs">
            <p data-testid="request-summary" className="font-semibold">
              {questionCount === null
                ? "One request: State and every question, submitted together."
                : `One request: State and ${questionCount} question${
                    questionCount === 1 ? "" : "s"
                  }, submitted together.`}
            </p>
            <p className="mt-0.5 text-[var(--color-ink-soft)]">
              {mode === "fixture"
                ? "No request is sent. Nothing is measured."
                : isPending
                  ? "One request is in flight. Submission stays disabled until it finishes, so a second press cannot start a second call."
                  : "The server chooses the model and holds the key. This request is sent exactly as it appears below."}{" "}
              <span data-testid="shortcut-hint">
                Shortcut: <kbd className="font-mono">⌘</kbd>/<kbd className="font-mono">Ctrl</kbd>+
                <kbd className="font-mono">Enter</kbd>.
              </span>
            </p>
            {!isRequestValid ? (
              <p className="mt-0.5 font-semibold text-[var(--color-danger)]">
                Submission is disabled until the request is valid.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* State: samples and reset in every view; its editor in the Form ---- */}
      <div className="mt-8">
        <section
          aria-labelledby={`${stateTextareaId}-heading`}
          data-testid="state-section"
          className="hard-card p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${stateTextareaId}-heading`} className="text-lg font-extrabold">
              <label htmlFor={stateTextareaId}>State</label>
            </h3>
            <button
              type="button"
              data-testid="reset-preset"
              onClick={onReset}
              className="btn btn-danger"
            >
              Reset to preset
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
            What every question is evaluated against. A sample button
            replaces the State only; your questions are kept. Reset restores
            this scenario&rsquo;s default State <em>and</em> questions, and
            discards any invalid draft.
          </p>

          <div className="mt-3 space-y-2.5">
            {sampleGroups(scenario).map((group) => (
              <div key={group.group}>
                <h4 className="field-label text-[var(--color-ink-soft)]">{group.group}</h4>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {group.samples.map((sample) => {
                    const isLoaded = sample.id === matchedSampleId;
                    return (
                      <button
                        key={sample.id}
                        type="button"
                        data-testid={`sample-${sample.id}`}
                        aria-pressed={isLoaded}
                        disabled={formLocked}
                        onClick={() => onLoadSample(sample.id)}
                        className="btn"
                      >
                        {sample.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {formLocked ? (
            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
              Samples are unavailable while the whole-request JSON is invalid,
              because loading one would overwrite what you typed.
            </p>
          ) : null}

          {matchedSampleId ? (
            <SampleMetadata scenario={scenario} sampleId={matchedSampleId} />
          ) : (
            <p
              data-testid="custom-state-note"
              className="mt-3 border-2 border-dashed border-[var(--color-line-soft)] p-2.5 text-xs text-[var(--color-ink-soft)]"
            >
              Custom State — this does not match any sample, so no sample
              fixture or expected outcome applies.
            </p>
          )}

          {draft.view === "form" && !formLocked ? (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <span className="field-label">Format</span>
                <div
                  role="group"
                  aria-label="State format"
                  className="flex border-2 border-[var(--color-line)]"
                >
                  <button
                    type="button"
                    data-testid="state-mode-json"
                    aria-pressed={draft.state.mode === "json"}
                    onClick={() => onStateModeChange("json")}
                    className={segmentClass(draft.state.mode === "json")}
                  >
                    JSON
                  </button>
                  <button
                    type="button"
                    data-testid="state-mode-text"
                    aria-pressed={draft.state.mode === "text"}
                    onClick={() => onStateModeChange("text")}
                    className={`${segmentClass(draft.state.mode === "text")} border-l-2 border-[var(--color-line)]`}
                  >
                    Text
                  </button>
                </div>
              </div>
              <p data-testid="state-mode-note" className="mt-1 text-xs text-[var(--color-ink-soft)]">
                {draft.state.mode === "json"
                  ? "JSON State: an object, array, or string. This is what the questions are evaluated against; expected labels must not appear here."
                  : draft.state.textBase !== null && draft.state.text === draft.state.textBase
                    ? "Text State: sent as one literal string, exactly as typed. This text was converted from the JSON source; switching back to JSON restores that source unchanged."
                    : "Text State: sent as one literal string, exactly as typed. Switching back to JSON turns this edited text into a JSON string; nothing is re-read as structure or dropped."}
              </p>
              <textarea
                id={stateTextareaId}
                data-testid="state-editor"
                value={stateEditorText(draft.state)}
                spellCheck={false}
                onChange={(event) => onStateTextChange(event.target.value)}
                aria-invalid={reading.stateError !== null}
                aria-describedby={reading.stateError !== null ? stateErrorId : undefined}
                rows={draft.state.mode === "json" ? 12 : 6}
                className={`input mt-2 resize-y p-3 text-xs leading-relaxed ${
                  draft.state.mode === "json" ? "font-mono" : ""
                }`}
              />
              {reading.stateError !== null ? (
                <div
                  id={stateErrorId}
                  data-testid="state-errors"
                  role="alert"
                  className="mt-2 border-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3"
                >
                  <p className="text-sm font-semibold text-[var(--color-danger)]">
                    This State is not valid JSON, so it cannot be submitted.
                  </p>
                  <p className="mt-1 font-mono text-xs text-[var(--color-ink)]">
                    {reading.stateError}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    Your text has been kept exactly as you typed it. Fix the
                    syntax — usually a missing comma, quote, or brace — switch
                    to Text to send it as a literal string, or press Reset to
                    preset.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <p data-testid="state-in-json-note" className="mt-4 text-xs text-[var(--color-ink-soft)]">
              {draft.view === "json"
                ? "State is edited as the \"state\" field of the whole-request JSON below."
                : "State is part of the invalid whole-request JSON; fix it there or reset."}
            </p>
          )}
        </section>

        {/* Questions, the whole-request JSON, or the locked notice -------- */}
        {draft.view === "json" ? (
          <div className="mt-10 border-t-4 border-[var(--color-line)] pt-6">
            <div className="hard-card p-4">
              <label htmlFor={jsonTextareaId} className="text-lg font-extrabold">
                Whole request JSON
              </label>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                Exactly <code>{"{ state, questions }"}</code> — the one request the
                Form edits too. A valid edit is reflected in the Form; an invalid
                one is kept as typed. There is no <code>model</code> field: the
                server chooses the model and holds the key, and rejects any request
                that names either.
              </p>
              <textarea
                id={jsonTextareaId}
                data-testid="request-json-editor"
                value={draft.requestJson ?? ""}
                spellCheck={false}
                rows={22}
                onChange={(event) => onRequestJsonChange(event.target.value)}
                aria-invalid={reading.errors.length > 0}
                aria-describedby={hasProblems ? problemsId : undefined}
                className="input mt-3 resize-y p-3 font-mono text-[11px] leading-relaxed"
              />
            </div>
          </div>
        ) : formLocked ? (
          <div className="mt-10 border-t-4 border-[var(--color-line)] pt-6">
            <div
              data-testid="form-locked"
              role="status"
              className="border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3 text-xs"
            >
              <p className="font-semibold">
                The Form is read-only while the whole-request JSON is invalid.
              </p>
              <p className="mt-1 text-[var(--color-ink-soft)]">
                Your JSON is kept exactly as typed and has not been replaced by an
                earlier valid version. Return to it to fix the problems below, or
                reset this scenario to its preset.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="return-to-json"
                  onClick={() => onViewChange("json")}
                  className="btn"
                >
                  Return to JSON
                </button>
                <button
                  type="button"
                  data-testid="locked-reset"
                  onClick={onReset}
                  className="btn btn-danger"
                >
                  Reset to preset
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-10 border-t-4 border-[var(--color-line)] pt-6">
            <QuestionEditor rows={draft.rows} onChange={onRowsChange} />
          </div>
        )}

        {hasProblems ? (
          <div
            id={problemsId}
            data-testid="request-errors"
            role="alert"
            className="mt-4 border-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3"
          >
            <p className="text-sm font-semibold text-[var(--color-danger)]">
              {reading.errors.length > 0
                ? reading.source === "json"
                  ? "This request JSON cannot be used yet, so it cannot be submitted."
                  : "The Form cannot be turned into a request yet, so it cannot be submitted."
                : "This request does not match the expected shape, so it cannot be submitted."}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-[var(--color-ink)]">
              {problems.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
              Nothing you typed has been discarded or rewritten.
            </p>
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div
            data-testid="request-warnings"
            role="status"
            className="mt-4 border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-3 text-xs"
          >
            <p className="font-semibold">Valid, but check this before submitting</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What the server said about its own configuration, in words a reader can act
 * on. Deliberately says nothing about the key itself — not its value, not its
 * length, not its prefix — and never claims the key works.
 */
function ConfigNotice({
  status,
  onRecheck,
}: {
  status: ConfigStatus;
  onRecheck: () => void;
}) {
  const text: Record<ConfigStatus, string> = {
    unknown:
      "Checking whether this server has a TypeSafe API key. Live mode stays disabled until the check answers.",
    configured:
      "This server has an API key. That means a key is present — not that it is valid, funded, or accepted: only a real call can show that, and this check does not make one.",
    missing:
      "This server has no TypeSafe API key, so Live mode is disabled. Put TYPESAFE_API_KEY in .env.local, restart the dev server, then re-check. Fixture mode needs no key.",
    unavailable:
      "The configuration check itself failed, so Live mode is disabled. Fixture mode is unaffected.",
  };

  return (
    <div
      data-testid="config-status"
      data-status={status}
      className={`mt-2 border-2 p-2.5 text-xs ${
        status === "configured"
          ? "border-[var(--color-line-soft)] text-[var(--color-ink-soft)]"
          : "border-[var(--color-warn)] bg-[var(--color-warn-soft)] text-[var(--color-ink)]"
      }`}
    >
      <p>{text[status]}</p>
      {status === "configured" ? null : (
        <button
          type="button"
          data-testid="config-recheck"
          onClick={onRecheck}
          className="btn mt-2"
        >
          Re-check configuration
        </button>
      )}
    </div>
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
      className="mt-3 border-2 border-dashed border-[var(--color-line)] bg-[var(--color-canvas)] p-3"
    >
      <h4 className="field-label text-[var(--color-ink-soft)]">
        Sample metadata — not submitted
      </h4>
      <p className="mt-1 text-xs text-[var(--color-ink)]">
        <span className="font-semibold">Proposed expected outcome:</span>{" "}
        {sample.expected}
      </p>
      <details className="disclosure mt-1 text-xs text-[var(--color-ink-soft)]">
        <summary className="font-semibold text-[var(--color-ink)]">About this sample</summary>
        {sample.note ? <p className="mt-1">{sample.note}</p> : null}
        <p className="mt-1">
          This expectation is a proposal for review, not measured Jev
          performance. It is held outside State and is never sent.
        </p>
      </details>
    </div>
  );
}

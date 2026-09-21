"use client";

/**
 * Panel 2 of 3: the request.
 *
 * What is editable: the whole `{ state, questions }` request, in either of two
 * equivalent views.
 *
 *  - **Form** — State as JSON, or as Text focused on the scenario's primary
 *    message (the rest of the State object is kept and sent unchanged), and
 *    every question's id, type, instructions, and criteria (see
 *    `question-editor.tsx`).
 *  - **Whole-request JSON** — exactly `{ state, questions }` as one text box.
 *    A valid edit carries over to the Form; an invalid one is kept verbatim,
 *    blocks submission, and leaves the Form read-only until it is fixed or the
 *    preset is explicitly reset.
 *
 * Sample buttons replace State only and keep the questions; Reset restores the
 * whole preset. Three actions sit in the submit area: Evaluate with Jev,
 * Evaluate with LLM, and Evaluate with both. Beside them this panel shows only
 * what blocks them (TypeSafe configuration, a missing Moonshot key, an invalid
 * request). Nothing here submits anything on its own — typing, choosing a
 * sample, resetting, and switching State format or view never trigger a call.
 * Cmd/Ctrl+Enter is handled by the page and obeys the same guards as Evaluate
 * with Jev.
 */

import { useEffect, useId, useRef } from "react";
import type {
  DraftReading,
  QuestionRow,
  RequestDraft,
  RequestView,
  StateMode,
} from "@/lib/request-draft";
import { stateEditorText, stateTextAvailability } from "@/lib/request-draft";
import type { Scenario } from "@/lib/scenarios";
import { sampleGroups } from "@/lib/scenarios";
import type { ConfigStatus } from "@/lib/types";
import { QuestionEditor } from "./question-editor";

export type EvaluateAction = "jev" | "llm" | "both";

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
  matchedSampleId,
  onStateModeChange,
  onStateTextChange,
  onRowsChange,
  onViewChange,
  onRequestJsonChange,
  onLoadSample,
  onReset,
  configStatus,
  llmConfigured,
  onRecheckConfig,
  pendingAction,
  canSubmitJev,
  canSubmitLlm,
  canSubmitBoth,
  onSubmit,
  passwordOpen,
  passwordError,
  passwordUnlocking,
  onPasswordSubmit,
  onPasswordCancel,
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
  /** The sample whose State the current draft exactly matches, if any. */
  matchedSampleId: string | null;
  onStateModeChange: (mode: StateMode) => void;
  onStateTextChange: (text: string) => void;
  onRowsChange: (rows: QuestionRow[]) => void;
  onViewChange: (view: RequestView) => void;
  onRequestJsonChange: (text: string) => void;
  onLoadSample: (sampleId: string) => void;
  onReset: () => void;
  /** What the server said about its TypeSafe configuration. Never a key or a fragment. */
  configStatus: ConfigStatus;
  /** Moonshot key presence. Missing or non-boolean config is treated as false by the page. */
  llmConfigured: boolean;
  onRecheckConfig: () => void;
  /** Which button started the in-flight submission, if any. */
  pendingAction: EvaluateAction | null;
  canSubmitJev: boolean;
  canSubmitLlm: boolean;
  canSubmitBoth: boolean;
  onSubmit: (action: EvaluateAction) => void;
  passwordOpen: boolean;
  passwordError: string | null;
  passwordUnlocking: boolean;
  onPasswordSubmit: (password: string) => void;
  onPasswordCancel: () => void;
}) {
  const stateTextareaId = useId();
  const stateErrorId = useId();
  const jsonTextareaId = useId();
  const problemsId = useId();
  const submitStatusId = useId();
  const textRefusedId = useId();

  // The Form can be serialized to JSON only when it converts; duplicate ids,
  // for instance, have no faithful JSON object form.
  const canOpenJson = draft.requestJson !== null || reading.request !== null;
  const problems = [...reading.errors, ...validationErrors];
  const hasProblems = problems.length > 0;
  const textAvailability = stateTextAvailability(draft.state);
  const stateIsString =
    draft.state.mode === "text" && reading.request !== null && typeof reading.request.state === "string";
  // TypeSafe config-status is hidden once that check says configured. A missing
  // Moonshot key is a separate note and does not replace it.
  const blocker = submitBlocker(configStatus, isRequestValid, hasProblems);
  const showLlmConfigNote = configStatus !== "unknown" && !llmConfigured;

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

      {/* The three actions ------------------------------------------------- */}
      <div data-testid="submit-area" className="hard-card mt-4 p-4">
        <div className="submit-actions">
          <button
            type="button"
            data-testid="evaluate-live"
            disabled={!canSubmitJev}
            aria-busy={pendingAction === "jev"}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            aria-describedby={
              [blocker ? submitStatusId : null, hasProblems ? problemsId : null]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onClick={() => onSubmit("jev")}
            className="btn-primary"
          >
            {pendingAction === "jev" ? "Evaluating with Jev…" : "Evaluate with Jev"}
          </button>
          <button
            type="button"
            data-testid="evaluate-llm"
            disabled={!canSubmitLlm}
            aria-busy={pendingAction === "llm"}
            onClick={() => onSubmit("llm")}
            className="btn"
          >
            {pendingAction === "llm" ? "Evaluating with LLM…" : "Evaluate with LLM"}
          </button>
          <button
            type="button"
            data-testid="evaluate-both"
            disabled={!canSubmitBoth}
            aria-busy={pendingAction === "both"}
            onClick={() => onSubmit("both")}
            className="btn"
          >
            {pendingAction === "both" ? "Evaluating with both…" : "Evaluate with both"}
          </button>
        </div>
        {passwordOpen ? (
          <PasswordPrompt
            error={passwordError}
            unlocking={passwordUnlocking}
            onSubmit={onPasswordSubmit}
            onCancel={onPasswordCancel}
          />
        ) : null}
        {blocker ? (
          <div
            id={submitStatusId}
            data-testid={blocker.kind === "config" ? "config-status" : "submit-blocked"}
            data-status={blocker.kind === "config" ? configStatus : undefined}
            role={blocker.kind === "config" && configStatus !== "unknown" ? "alert" : "status"}
            className={`mt-3 border-2 p-2.5 text-xs ${
              blocker.tone === "danger"
                ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)]"
                : "border-[var(--color-warn)] bg-[var(--color-warn-soft)]"
            }`}
          >
            <p>{blocker.message}</p>
            {blocker.kind === "config" &&
            (configStatus === "missing" || configStatus === "unavailable") ? (
              <button
                type="button"
                data-testid="config-recheck"
                onClick={onRecheckConfig}
                className="btn mt-2"
              >
                Re-check configuration
              </button>
            ) : null}
          </div>
        ) : null}
        {showLlmConfigNote ? (
          <p
            data-testid="llm-config-status"
            role="status"
            className="mt-3 border-2 border-[var(--color-warn)] bg-[var(--color-warn-soft)] p-2.5 text-xs"
          >
            The language-model button needs a Moonshot key on the server.
          </p>
        ) : null}
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
                    disabled={!textAvailability.ok}
                    aria-describedby={!textAvailability.ok ? textRefusedId : undefined}
                    onClick={() => onStateModeChange("text")}
                    className={`${segmentClass(draft.state.mode === "text")} border-l-2 border-[var(--color-line)]`}
                  >
                    Text
                  </button>
                </div>
              </div>
              <p data-testid="state-mode-note" className="mt-1 text-xs text-[var(--color-ink-soft)]">
                {draft.state.mode === "json"
                  ? "The full State, as JSON."
                  : stateIsString
                    ? "The State is this one string, sent exactly as typed."
                    : `Only ${draft.state.primaryField ?? "the message"} is shown; the rest of the State is kept and sent unchanged.`}
              </p>
              {!textAvailability.ok ? (
                <p
                  id={textRefusedId}
                  data-testid="state-text-unavailable"
                  className="mt-1 text-xs font-semibold text-[var(--color-ink-soft)]"
                >
                  Text is unavailable: {textAvailability.reason}
                </p>
              ) : null}
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
                    syntax — usually a missing comma, quote, or brace — or
                    press Reset to preset.
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

/** What blocks Evaluate right now, in a line a reader can act on. Null when nothing does. */
function submitBlocker(
  status: ConfigStatus,
  isRequestValid: boolean,
  hasProblems: boolean,
): { kind: "config" | "request"; tone: "warn" | "danger"; message: string } | null {
  // Deliberately says nothing about the key itself — not its value, length, or
  // prefix — and never claims a present key works.
  if (status === "unknown") {
    return { kind: "config", tone: "warn", message: "Checking server configuration…" };
  }
  if (status === "missing") {
    return {
      kind: "config",
      tone: "danger",
      message:
        "This server has no TypeSafe API key. Put TYPESAFE_API_KEY in .env.local, restart the server, then re-check.",
    };
  }
  if (status === "unavailable") {
    return {
      kind: "config",
      tone: "danger",
      message: "The server configuration check failed, so Evaluate is unavailable.",
    };
  }
  if (!isRequestValid) {
    return {
      kind: "request",
      tone: "danger",
      message: hasProblems
        ? "Fix the problems listed below the request to evaluate it."
        : "Fix the State above to evaluate this request.",
    };
  }
  return null;
}

function PasswordPrompt({
  error,
  unlocking,
  onSubmit,
  onCancel,
}: {
  error: string | null;
  unlocking: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (!node.open) node.showModal();
    inputRef.current?.focus();
    const onNativeCancel = (event: Event) => {
      event.preventDefault();
      if (!unlocking) onCancel();
    };
    node.addEventListener("cancel", onNativeCancel);
    return () => {
      node.removeEventListener("cancel", onNativeCancel);
      if (node.open) node.close();
    };
  }, [onCancel, unlocking]);

  return (
    <dialog
      ref={dialogRef}
      data-testid="evaluate-password-dialog"
      className="password-dialog"
      aria-labelledby={inputId}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.stopPropagation();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (unlocking) return;
          onSubmit(inputRef.current?.value ?? "");
        }}
      >
        <p className="text-sm font-extrabold">Enter the playground password to evaluate with Jev.</p>
        <label htmlFor={inputId} className="field-label mt-3 block">
          Playground password
        </label>
        <input
          ref={inputRef}
          id={inputId}
          data-testid="evaluate-password-input"
          type="password"
          name="password"
          autoComplete="off"
          disabled={unlocking}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          className="input mt-1 p-2"
        />
        {error !== null ? (
          <p
            id={errorId}
            data-testid="evaluate-password-error"
            role="alert"
            className="mt-2 border-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-2 text-xs"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="submit"
            data-testid="evaluate-password-submit"
            disabled={unlocking}
            className="btn"
          >
            {unlocking ? "Checking…" : "Continue"}
          </button>
          <button
            type="button"
            disabled={unlocking}
            onClick={onCancel}
            className="btn"
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

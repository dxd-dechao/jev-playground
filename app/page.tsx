"use client";

/**
 * The three-panel shell: Scenarios → Request → Response.
 *
 * All state lives here so the panels stay presentational. The rules this file
 * exists to hold:
 *
 *  - One request draft *per scenario* — State, questions, the chosen view, and
 *    any pending raw JSON — preserved across switches (`lib/request-draft.ts`).
 *  - One live result per scenario, so switching scenario and back never shows
 *    one scenario's answers beside another's request. Every result is a live
 *    Jev response; the playground has no fixture mode.
 *  - A result carries the exact request (State *and* questions) it was produced
 *    from, and the question order it was displayed in. Staleness is derived by
 *    comparing that snapshot's values against the current draft, so editing
 *    either half marks it stale and it is never re-attached to new input.
 *  - A live response is stored under the scenario and snapshot it was
 *    requested for, whenever it arrives. If the user has since edited or moved
 *    elsewhere, it stays in its own slot and is labelled stale. If a newer
 *    request for the same slot has started, the older response is discarded.
 *  - Exactly one live request per explicit submission — a press or
 *    Cmd/Ctrl+Enter. A synchronous in-flight guard refuses a second one, so a
 *    repeated key or a double press cannot start a second paid call.
 *  - Nothing but an explicit submission causes inference. Typing, loading a
 *    sample, resetting, switching scenario, State format, or view, and checking
 *    configuration never call the model.
 *  - A live failure stays a failure. Nothing is substituted for it.
 *  - A locked server asks for the playground password on the first Evaluate
 *    press. A 401 from evaluate re-prompts; it is not shown as a Jev error.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RequestEditor } from "@/components/request-editor";
import type {
  PlaygroundError,
  PlaygroundResult,
  ResponseView,
} from "@/components/response-panel";
import { ResponsePanel } from "@/components/response-panel";
import { ScenarioPicker } from "@/components/scenario-picker";
import { matchSampleId, questionsMatchPreset } from "@/lib/fixtures";
import type { QuestionRow, RequestDraft, RequestView, StateMode } from "@/lib/request-draft";
import {
  applySampleState,
  editStateText,
  initialDraft,
  isFormLocked,
  openFormView,
  openJsonView,
  readDraft,
  sameRequest,
  setRequestJson,
  textStateMeetsPresetQuestions,
  toggleStateMode,
} from "@/lib/request-draft";
import type { ScenarioId } from "@/lib/scenarios";
import { DEFAULT_SCENARIO_ID, SCENARIOS, getSample, getScenario } from "@/lib/scenarios";
import type { ValidationResult } from "@/lib/schemas";
import { presetStateIssues, validatePlaygroundRequest } from "@/lib/schemas";
import type {
  ConfigStatus,
  EvaluationRequest,
  LiveEvaluationPayload,
  PlaygroundAccess,
} from "@/lib/types";
import { playgroundAccessFromConfig } from "@/lib/types";

/** One live result slot per scenario. */
type ResultSlots = Record<ScenarioId, PlaygroundResult | null>;

function perScenario<T>(make: (scenarioId: ScenarioId) => T): Record<ScenarioId, T> {
  const record = {} as Record<ScenarioId, T>;
  for (const scenario of SCENARIOS) record[scenario.id] = make(scenario.id);
  return record;
}

function initialDrafts(): Record<ScenarioId, RequestDraft> {
  return perScenario((id) => initialDraft(getScenario(id)));
}

/** A failure to show when the route's own error payload cannot be read. */
const UNREADABLE_ERROR = {
  code: "client_unreadable_response",
  message:
    "The evaluation endpoint returned something this page could not read, so no " +
    "answer is shown. Nothing was substituted for it.",
};

const WRONG_PASSWORD_MESSAGE = "That password was not accepted. Try again.";

/** The shape we require of our own route's success payload before rendering it. */
function isLivePayload(value: unknown): value is LiveEvaluationPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LiveEvaluationPayload>;
  return (
    candidate.source === "live" &&
    typeof candidate.requestedModel === "string" &&
    typeof candidate.durationMs === "number" &&
    typeof candidate.response === "object" &&
    candidate.response !== null &&
    typeof candidate.response.model === "string" &&
    typeof candidate.response.answers === "object" &&
    candidate.response.answers !== null
  );
}

/** A result or failure no longer describes what the editor currently asks. */
function isOutdated(
  snapshot: EvaluationRequest,
  current: EvaluationRequest | null,
): boolean {
  return current === null || !sameRequest(current, snapshot);
}

export default function PlaygroundPage() {
  const [activeScenarioId, setActiveScenarioId] =
    useState<ScenarioId>(DEFAULT_SCENARIO_ID);
  const [drafts, setDrafts] = useState<Record<ScenarioId, RequestDraft>>(initialDrafts);
  const [results, setResults] = useState<ResultSlots>(() => perScenario(() => null));
  const [errors, setErrors] = useState<Record<ScenarioId, PlaygroundError | null>>(() =>
    perScenario(() => null),
  );
  const [pending, setPending] = useState<Record<ScenarioId, boolean>>(() =>
    perScenario(() => false),
  );
  const [configStatus, setConfigStatus] = useState<ConfigStatus>("unknown");
  const [access, setAccess] = useState<PlaygroundAccess>("open");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [view, setView] = useState<ResponseView>("cards");

  /**
   * The latest request token per scenario. A response whose token is no longer
   * current has been superseded and is dropped rather than displayed.
   */
  const tokens = useRef<Record<ScenarioId, number>>(perScenario(() => 0));
  /**
   * Set synchronously when a live call starts. React state updates are not
   * visible to a second event in the same frame (a repeated Cmd+Enter, a
   * double press), so this ref is the real one-call-at-a-time guard.
   */
  const inFlight = useRef<Record<ScenarioId, boolean>>(perScenario(() => false));
  const unlockingRef = useRef(false);

  const scenario = getScenario(activeScenarioId);
  const draft = drafts[activeScenarioId];

  const reading = useMemo(() => readDraft(draft), [draft]);
  const formLocked = useMemo(() => isFormLocked(draft), [draft]);

  const validation = useMemo<ValidationResult<EvaluationRequest>>(() => {
    // A draft that cannot be converted reports its own problems in
    // `reading.errors`; there is nothing to schema-check, and the typed text is
    // left untouched.
    if (reading.request === null) return { ok: false, errors: [] };
    return validatePlaygroundRequest(reading.request.state, reading.request.questions);
  }, [reading]);

  const isRequestValid =
    reading.request !== null && reading.errors.length === 0 && validation.ok;

  const questionsAreDefault = useMemo(
    () =>
      reading.request !== null &&
      questionsMatchPreset(scenario.id, reading.request.questions),
    [reading, scenario.id],
  );

  const matchedSampleId = useMemo(() => {
    if (reading.request === null) return null;
    return matchSampleId(scenario.id, reading.request.state);
  }, [reading, scenario.id]);

  /** Non-blocking notes: the request is valid, but may not mean what it looks like. */
  const warnings = useMemo(() => {
    const notes: string[] = [];
    const request = reading.request;
    if (request === null) return notes;
    if (textStateMeetsPresetQuestions(scenario, request)) {
      notes.push(
        "The State is plain text, but one or more questions are this preset's, " +
          "and they refer to named State fields such as `" +
          (scenario.id === "safety" ? "student_message" : "feedback") +
          "` that plain text does not have. The text is sent exactly as written; " +
          "nothing is wrapped or rewritten.",
      );
    }
    if (typeof request.state !== "string" && questionsAreDefault) {
      const issues = presetStateIssues(scenario.stateSchemaId, request.state);
      if (issues.length > 0) {
        notes.push(
          `This State does not have the shape the preset questions refer to: ${issues.join("; ")}.`,
        );
      }
    }
    return notes;
  }, [questionsAreDefault, reading, scenario]);

  const result = results[activeScenarioId];
  const isStale = result !== null && isOutdated(result.requestSnapshot, reading.request);

  const error = errors[activeScenarioId];
  const isErrorStale = error !== null && isOutdated(error.requestSnapshot, reading.request);
  const isPending = pending[activeScenarioId];

  const canSubmit = isRequestValid && configStatus === "configured" && !isPending && !unlocking;

  /**
   * Ask the server whether evaluation is possible at all. This is a plain GET
   * that returns key presence and password-gate state; it makes no model call
   * and costs nothing, so it is safe on mount and on demand. Until it answers
   * "configured", Evaluate stays disabled. Missing `access` is treated as open.
   */
  const checkConfig = useCallback(async () => {
    setConfigStatus("unknown");
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) {
        setConfigStatus("unavailable");
        return;
      }
      const payload = (await response.json()) as unknown;
      const configured =
        typeof payload === "object" &&
        payload !== null &&
        (payload as { configured?: unknown }).configured === true;
      setAccess(playgroundAccessFromConfig(payload));
      setConfigStatus(configured ? "configured" : "missing");
    } catch {
      // The failure is recorded and shown beside the disabled button; nothing
      // else about the page changes.
      setConfigStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    void checkConfig();
  }, [checkConfig]);

  const updateDraft = useCallback(
    (change: (previous: RequestDraft) => RequestDraft) => {
      setDrafts((previous) => ({
        ...previous,
        [activeScenarioId]: change(previous[activeScenarioId]),
      }));
    },
    [activeScenarioId],
  );

  const setStateMode = useCallback(
    (next: StateMode) =>
      updateDraft((previous) => ({
        ...previous,
        state: toggleStateMode(previous.state, next),
      })),
    [updateDraft],
  );

  const setStateText = useCallback(
    (text: string) =>
      updateDraft((previous) => ({
        ...previous,
        state: editStateText(previous.state, text),
      })),
    [updateDraft],
  );

  const setRows = useCallback(
    (rows: QuestionRow[]) => updateDraft((previous) => ({ ...previous, rows })),
    [updateDraft],
  );

  const setRequestView = useCallback(
    (next: RequestView) =>
      updateDraft((previous) =>
        next === "json" ? openJsonView(previous) : openFormView(previous),
      ),
    [updateDraft],
  );

  const setRawJson = useCallback(
    (text: string) => updateDraft((previous) => setRequestJson(previous, text)),
    [updateDraft],
  );

  const loadSample = useCallback(
    (sampleId: string) => {
      // A sample replaces State only; the current (possibly edited) questions stay.
      const state = getSample(scenario, sampleId).state;
      updateDraft((previous) => applySampleState(previous, state));
    },
    [scenario, updateDraft],
  );

  const resetPreset = useCallback(() => {
    // Explicit, and the only thing that discards an invalid draft.
    updateDraft(() => initialDraft(scenario));
  }, [scenario, updateDraft]);

  const evaluateLive = useCallback(async () => {
    const request = reading.request;
    if (!isRequestValid || request === null) return;
    if (configStatus !== "configured") return;
    // The disabled button is the visible guard; this is the real one. A second
    // press, a repeated shortcut, or a replayed event cannot start a second
    // paid call while one is in flight.
    if (inFlight.current[scenario.id] || pending[scenario.id]) return;

    // Everything the response will be filed under is captured *now*, before the
    // await, so a later switch or edit cannot change where it lands.
    const scenarioId = scenario.id;
    const requestSnapshot = request;
    const questionOrder = reading.order;
    const token = tokens.current[scenarioId] + 1;
    tokens.current[scenarioId] = token;
    inFlight.current[scenarioId] = true;

    setPending((previous) => ({ ...previous, [scenarioId]: true }));

    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        // Exactly the request on screen. The model and the key are the server's.
        body: JSON.stringify({
          scenarioId,
          state: requestSnapshot.state,
          questions: requestSnapshot.questions,
        }),
      });

      let payload: unknown = null;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        payload = null;
      }

      // A newer request for this slot has started; this answer is no longer the
      // one being waited for, and showing it would misrepresent which request
      // it answers.
      if (tokens.current[scenarioId] !== token) return;

      if (response.status === 401) {
        // Expired or missing cookie: re-prompt. This is not a Jev/model failure.
        setAccess("required");
        setPasswordError(null);
        setPasswordOpen(true);
        return;
      }

      if (response.ok && isLivePayload(payload)) {
        const live: PlaygroundResult = {
          source: "live",
          scenarioId,
          live: payload,
          requestSnapshot,
          questionOrder,
        };
        setResults((previous) => ({ ...previous, [scenarioId]: live }));
        setErrors((previous) => ({ ...previous, [scenarioId]: null }));
        return;
      }

      const failure =
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { error?: { code?: unknown; message?: unknown } }).error ===
          "object" &&
        (payload as { error: { code?: unknown; message?: unknown } }).error !== null &&
        typeof (payload as { error: { code?: unknown } }).error.code === "string" &&
        typeof (payload as { error: { message?: unknown } }).error.message === "string"
          ? (payload as { error: { code: string; message: string } }).error
          : UNREADABLE_ERROR;

      // The previous successful live result, if any, stays exactly as it was —
      // with its own snapshot — and this failure stays visible above it.
      setErrors((previous) => ({
        ...previous,
        [scenarioId]: {
          source: "live",
          scenarioId,
          requestSnapshot,
          questionOrder,
          code: failure.code,
          message: failure.message,
        },
      }));
    } catch {
      if (tokens.current[scenarioId] !== token) return;
      setErrors((previous) => ({
        ...previous,
        [scenarioId]: {
          source: "live",
          scenarioId,
          requestSnapshot,
          questionOrder,
          code: "client_network_error",
          message:
            "The browser could not reach the evaluation endpoint, so there is no " +
            "answer to show. Nothing was substituted for it.",
        },
      }));
    } finally {
      // Only the request that still owns this slot may release it.
      if (tokens.current[scenarioId] === token) {
        inFlight.current[scenarioId] = false;
        setPending((previous) => ({ ...previous, [scenarioId]: false }));
      }
    }
  }, [configStatus, isRequestValid, pending, reading, scenario.id]);

  const submitPassword = useCallback(
    async (password: string) => {
      if (unlockingRef.current || isPending) return;
      unlockingRef.current = true;
      setUnlocking(true);
      setPasswordError(null);
      try {
        const response = await fetch("/api/unlock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ password }),
        });
        let payload: unknown = null;
        try {
          payload = (await response.json()) as unknown;
        } catch {
          payload = null;
        }
        if (!response.ok) {
          if (response.status === 401) {
            setPasswordError(WRONG_PASSWORD_MESSAGE);
            return;
          }
          const message =
            typeof payload === "object" &&
            payload !== null &&
            typeof (payload as { error?: { message?: unknown } }).error === "object" &&
            (payload as { error: { message?: unknown } }).error !== null &&
            typeof (payload as { error: { message?: unknown } }).error.message === "string"
              ? (payload as { error: { message: string } }).error.message
              : WRONG_PASSWORD_MESSAGE;
          setPasswordError(message);
          return;
        }
        setAccess("granted");
        setPasswordOpen(false);
        setPasswordError(null);
        void evaluateLive();
      } catch {
        setPasswordError(WRONG_PASSWORD_MESSAGE);
      } finally {
        unlockingRef.current = false;
        setUnlocking(false);
      }
    },
    [evaluateLive, isPending],
  );

  const cancelPassword = useCallback(() => {
    if (unlockingRef.current) return;
    setPasswordOpen(false);
    setPasswordError(null);
  }, []);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    if (access === "required") {
      setPasswordError(null);
      setPasswordOpen(true);
      return;
    }
    void evaluateLive();
  }, [access, canSubmit, evaluateLive]);

  /**
   * Cmd/Ctrl+Enter submits, with every guard the button
   * has. The listener reads the latest `submit` through a ref so it never acts
   * on a stale request, and ignores auto-repeat so holding the keys is one
   * submission, not many.
   */
  const submitRef = useRef(submit);
  const passwordOpenRef = useRef(passwordOpen);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);
  useEffect(() => {
    passwordOpenRef.current = passwordOpen;
  }, [passwordOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      if (event.isComposing) return;
      event.preventDefault();
      if (event.repeat) return;
      if (passwordOpenRef.current) return;
      submitRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="mx-auto w-full max-w-[100rem] px-4 py-8 sm:px-6">
      <header className="mb-8 border-b-4 border-[var(--color-line)] pb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight">Jev playground</h1>
          <p className="border-2 border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1 text-xs font-semibold">
            Each Evaluate calls TypeSafe Jev once, from the server.
          </p>
        </div>
        <p className="mt-3 max-w-4xl text-sm text-[var(--color-ink-soft)]">
          Pick a scenario, edit its State and questions, then evaluate the
          request with Jev. Answers are one model&rsquo;s judgment of one
          request: they show what the API returns, not how well it performs.
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,17rem)_minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-8">
        <div className="min-w-0">
          <ScenarioPicker
            scenarios={SCENARIOS}
            activeId={activeScenarioId}
            onSelect={setActiveScenarioId}
          />
        </div>

        <div className="min-w-0">
          <RequestEditor
            scenario={scenario}
            draft={draft}
            reading={reading}
            formLocked={formLocked}
            validationErrors={validation.errors}
            warnings={warnings}
            isRequestValid={isRequestValid}
            matchedSampleId={matchedSampleId}
            onStateModeChange={setStateMode}
            onStateTextChange={setStateText}
            onRowsChange={setRows}
            onViewChange={setRequestView}
            onRequestJsonChange={setRawJson}
            onLoadSample={loadSample}
            onReset={resetPreset}
            configStatus={configStatus}
            onRecheckConfig={() => void checkConfig()}
            isPending={isPending}
            canSubmit={canSubmit}
            onSubmit={submit}
            passwordOpen={passwordOpen}
            passwordError={passwordError}
            passwordUnlocking={unlocking}
            onPasswordSubmit={(password) => void submitPassword(password)}
            onPasswordCancel={cancelPassword}
          />
        </div>

        <div className="min-w-0">
          <ResponsePanel
            scenario={scenario}
            result={result}
            error={error}
            isStale={isStale}
            isErrorStale={isErrorStale}
            isPending={isPending}
            view={view}
            onViewChange={setView}
          />
        </div>
      </div>
    </main>
  );
}

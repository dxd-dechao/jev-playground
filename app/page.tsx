"use client";

/**
 * The three-panel shell: Scenarios → Request → Response.
 *
 * All state lives here so the panels stay presentational. The rules this file
 * exists to hold:
 *
 *  - One request draft *per scenario* — State, questions, the chosen view, and
 *    any pending raw JSON — preserved across switches (`lib/request-draft.ts`).
 *  - Two live result slots per scenario (Jev and LLM), so switching scenario
 *    and back never shows one scenario's answers beside another's request.
 *    A Jev press replaces only the Jev slot; an LLM press replaces only the
 *    LLM slot; Evaluate with both replaces both for the snapshot captured
 *    at press time. A per-scenario comparison flag is set on a Both press
 *    and cleared on a single-engine press, so Measurement moves to the top
 *    only for that pair — not when two separate presses happen to fill both
 *    slots. A 401 resume of a Both press keeps the flag.
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
 *  - A locked server asks for the playground password on the first press of
 *    any of the three actions. A 401 from either evaluate route re-prompts;
 *    it is not shown as a model error. If Evaluate with both already kept a
 *    success from one engine, only the 401 engine is retried after unlock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RequestEditor } from "@/components/request-editor";
import type { EvaluateAction } from "@/components/request-editor";
import type {
  EngineId,
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
import { playgroundAccessFromConfig, llmConfiguredFromConfig } from "@/lib/types";

/** One Jev slot and one LLM slot per scenario. */
type EnginePair<T> = { jev: T; llm: T };
type ResultSlots = Record<ScenarioId, EnginePair<PlaygroundResult | null>>;
type ErrorSlots = Record<ScenarioId, EnginePair<PlaygroundError | null>>;

function emptyPair<T>(value: T): EnginePair<T> {
  return { jev: value, llm: value };
}

const ENGINE_ROUTE: Record<EngineId, "/api/evaluate" | "/api/evaluate-llm"> = {
  jev: "/api/evaluate",
  llm: "/api/evaluate-llm",
};

function enginesFor(action: EvaluateAction, only?: EngineId[]): EngineId[] {
  if (only !== undefined && only.length > 0) return only;
  return action === "both" ? ["jev", "llm"] : [action];
}

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
  const [results, setResults] = useState<ResultSlots>(() => perScenario(() => emptyPair(null)));
  const [errors, setErrors] = useState<ErrorSlots>(() => perScenario(() => emptyPair(null)));
  const [pendingAction, setPendingAction] = useState<Record<ScenarioId, EvaluateAction | null>>(
    () => perScenario(() => null),
  );
  const [waitingEngines, setWaitingEngines] = useState<Record<ScenarioId, EngineId[]>>(() =>
    perScenario(() => []),
  );
  const [comparisonByScenario, setComparisonByScenario] = useState<
    Record<ScenarioId, boolean>
  >(() => perScenario(() => false));
  const [configStatus, setConfigStatus] = useState<ConfigStatus>("unknown");
  const [llmConfigured, setLlmConfigured] = useState(false);
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
  const resumeRef = useRef<{ action: EvaluateAction; engines: EngineId[] } | null>(null);

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

  const jevResult = results[activeScenarioId].jev;
  const llmResult = results[activeScenarioId].llm;
  const jevStale = jevResult !== null && isOutdated(jevResult.requestSnapshot, reading.request);
  const llmStale = llmResult !== null && isOutdated(llmResult.requestSnapshot, reading.request);

  const jevError = errors[activeScenarioId].jev;
  const llmError = errors[activeScenarioId].llm;
  const jevErrorStale =
    jevError !== null && isOutdated(jevError.requestSnapshot, reading.request);
  const llmErrorStale =
    llmError !== null && isOutdated(llmError.requestSnapshot, reading.request);
  const currentPendingAction = pendingAction[activeScenarioId];
  const isPending = currentPendingAction !== null;
  const currentWaiting = waitingEngines[activeScenarioId];
  const comparison = comparisonByScenario[activeScenarioId];

  const canSubmitJev =
    isRequestValid && configStatus === "configured" && !isPending && !unlocking;
  const canSubmitLlm =
    isRequestValid &&
    llmConfigured &&
    configStatus !== "unknown" &&
    !isPending &&
    !unlocking;
  const canSubmitBoth = canSubmitJev && canSubmitLlm;

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
      setLlmConfigured(llmConfiguredFromConfig(payload));
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

  const evaluate = useCallback(
    async (action: EvaluateAction, onlyEngines?: EngineId[]) => {
      const request = reading.request;
      if (!isRequestValid || request === null) return;
      const engines = enginesFor(action, onlyEngines);
      if (engines.includes("jev") && configStatus !== "configured") return;
      if (engines.includes("llm") && !llmConfigured) return;
      // The disabled buttons are the visible guard; this is the real one. A
      // second press, a repeated shortcut, or the other buttons cannot start
      // another paid call while one is in flight.
      if (inFlight.current[scenario.id] || pendingAction[scenario.id] !== null) return;

      const scenarioId = scenario.id;
      const requestSnapshot = request;
      const questionOrder = reading.order;
      const token = tokens.current[scenarioId] + 1;
      tokens.current[scenarioId] = token;
      inFlight.current[scenarioId] = true;
      const unauthorized: EngineId[] = [];

      setPendingAction((previous) => ({ ...previous, [scenarioId]: action }));
      setWaitingEngines((previous) => ({ ...previous, [scenarioId]: [...engines] }));
      setComparisonByScenario((previous) => ({
        ...previous,
        [scenarioId]: action === "both",
      }));

      const runEngine = async (engine: EngineId) => {
        try {
          const response = await fetch(ENGINE_ROUTE[engine], {
            method: "POST",
            headers: { "content-type": "application/json" },
            cache: "no-store",
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

          if (tokens.current[scenarioId] !== token) return;

          if (response.status === 401) {
            unauthorized.push(engine);
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
            setResults((previous) => ({
              ...previous,
              [scenarioId]: { ...previous[scenarioId], [engine]: live },
            }));
            setErrors((previous) => ({
              ...previous,
              [scenarioId]: { ...previous[scenarioId], [engine]: null },
            }));
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

          setErrors((previous) => ({
            ...previous,
            [scenarioId]: {
              ...previous[scenarioId],
              [engine]: {
                source: "live",
                scenarioId,
                requestSnapshot,
                questionOrder,
                code: failure.code,
                message: failure.message,
              },
            },
          }));
        } catch {
          if (tokens.current[scenarioId] !== token) return;
          setErrors((previous) => ({
            ...previous,
            [scenarioId]: {
              ...previous[scenarioId],
              [engine]: {
                source: "live",
                scenarioId,
                requestSnapshot,
                questionOrder,
                code: "client_network_error",
                message:
                  "The browser could not reach the evaluation endpoint, so there is no " +
                  "answer to show. Nothing was substituted for it.",
              },
            },
          }));
        } finally {
          if (tokens.current[scenarioId] === token) {
            setWaitingEngines((previous) => ({
              ...previous,
              [scenarioId]: previous[scenarioId].filter((id) => id !== engine),
            }));
          }
        }
      };

      await Promise.all(engines.map((engine) => runEngine(engine)));

      if (tokens.current[scenarioId] !== token) return;
      inFlight.current[scenarioId] = false;
      setPendingAction((previous) => ({ ...previous, [scenarioId]: null }));
      setWaitingEngines((previous) => ({ ...previous, [scenarioId]: [] }));

      if (unauthorized.length > 0) {
        setAccess("required");
        resumeRef.current = { action, engines: unauthorized };
        setPasswordError(null);
        setPasswordOpen(true);
      }
    },
    [configStatus, isRequestValid, llmConfigured, pendingAction, reading, scenario.id],
  );

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
        const resume = resumeRef.current;
        resumeRef.current = null;
        if (resume) void evaluate(resume.action, resume.engines);
      } catch {
        setPasswordError(WRONG_PASSWORD_MESSAGE);
      } finally {
        unlockingRef.current = false;
        setUnlocking(false);
      }
    },
    [evaluate, isPending],
  );

  const cancelPassword = useCallback(() => {
    if (unlockingRef.current) return;
    resumeRef.current = null;
    setPasswordOpen(false);
    setPasswordError(null);
  }, []);

  const submit = useCallback(
    (action: EvaluateAction) => {
      const allowed =
        action === "jev" ? canSubmitJev : action === "llm" ? canSubmitLlm : canSubmitBoth;
      if (!allowed) return;
      if (access === "required") {
        resumeRef.current = { action, engines: enginesFor(action) };
        setPasswordError(null);
        setPasswordOpen(true);
        return;
      }
      void evaluate(action);
    },
    [access, canSubmitBoth, canSubmitJev, canSubmitLlm, evaluate],
  );

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
      submitRef.current("jev");
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
            Jev calls TypeSafe, LLM calls the language model, and Both calls each once.
          </p>
        </div>
        <p className="mt-3 max-w-4xl text-sm text-[var(--color-ink-soft)]">
          Pick a scenario, edit its State and questions, then evaluate the
          request with Jev, the language model, or both. Answers are one
          model&rsquo;s judgment of one request: they show what the API returns,
          not how well it performs.
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
            llmConfigured={llmConfigured}
            onRecheckConfig={() => void checkConfig()}
            pendingAction={currentPendingAction}
            canSubmitJev={canSubmitJev}
            canSubmitLlm={canSubmitLlm}
            canSubmitBoth={canSubmitBoth}
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
            jevResult={jevResult}
            llmResult={llmResult}
            jevError={jevError}
            llmError={llmError}
            jevStale={jevStale}
            llmStale={llmStale}
            jevErrorStale={jevErrorStale}
            llmErrorStale={llmErrorStale}
            waitingEngines={currentWaiting}
            comparison={comparison}
            view={view}
            onViewChange={setView}
          />
        </div>
      </div>
    </main>
  );
}

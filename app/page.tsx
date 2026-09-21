"use client";

/**
 * The three-panel shell: Scenarios → Request → Response.
 *
 * All state lives here so the panels stay presentational. The rules this file
 * exists to hold:
 *
 *  - One State draft *per scenario*, preserved across switches.
 *  - One result per *scenario and mode*. A fixture and a live answer occupy
 *    different slots, so switching mode or scenario and back can never show a
 *    fixture where a live result was, or the other way round.
 *  - A result carries the exact State text it was produced from. Staleness is
 *    derived by comparing that text against the current draft, so a displayed
 *    result is never silently re-attached to edited input.
 *  - A live response is stored under the scenario, mode, and snapshot it was
 *    requested for, whenever it arrives. If the user has since edited or moved
 *    elsewhere, it stays in its own slot and is labelled stale — it never
 *    appears to be an answer to the new input. If a newer request for the same
 *    slot has started, the older response is discarded outright.
 *  - Exactly one live request per explicit press: the button is disabled while
 *    one is in flight and the handler refuses to start a second.
 *  - Nothing but pressing "Evaluate with Jev" causes inference. Typing, loading
 *    a sample, resetting, switching scenario or mode, and checking configuration
 *    never call the model.
 *  - A live failure is never replaced by a fixture.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RequestEditor } from "@/components/request-editor";
import type {
  PlaygroundError,
  PlaygroundMode,
  PlaygroundResult,
  ResponseView,
} from "@/components/response-panel";
import { ResponsePanel } from "@/components/response-panel";
import { ScenarioPicker } from "@/components/scenario-picker";
import { matchSampleId, resolveFixture } from "@/lib/fixtures";
import type { ScenarioId } from "@/lib/scenarios";
import {
  DEFAULT_SCENARIO_ID,
  SCENARIOS,
  getDefaultSample,
  getSample,
  getScenario,
} from "@/lib/scenarios";
import type { ValidationResult } from "@/lib/schemas";
import { validateRequest } from "@/lib/schemas";
import type {
  ConfigStatus,
  EvaluationRequest,
  LiveEvaluationPayload,
  State,
} from "@/lib/types";

function formatState(state: unknown): string {
  return JSON.stringify(state, null, 2);
}

/** One result slot per scenario *and* mode. The pair is the identity. */
type ResultSlots = Record<ScenarioId, Record<PlaygroundMode, PlaygroundResult | null>>;

function initialDrafts(): Record<ScenarioId, string> {
  const drafts = {} as Record<ScenarioId, string>;
  for (const scenario of SCENARIOS) {
    drafts[scenario.id] = formatState(getDefaultSample(scenario).state);
  }
  return drafts;
}

function initialResults(): ResultSlots {
  const results = {} as ResultSlots;
  for (const scenario of SCENARIOS) {
    results[scenario.id] = { fixture: null, live: null };
  }
  return results;
}

function initialErrors(): Record<ScenarioId, PlaygroundError | null> {
  const errors = {} as Record<ScenarioId, PlaygroundError | null>;
  for (const scenario of SCENARIOS) errors[scenario.id] = null;
  return errors;
}

function initialPending(): Record<ScenarioId, boolean> {
  const pending = {} as Record<ScenarioId, boolean>;
  for (const scenario of SCENARIOS) pending[scenario.id] = false;
  return pending;
}

function initialTokens(): Record<ScenarioId, number> {
  const tokens = {} as Record<ScenarioId, number>;
  for (const scenario of SCENARIOS) tokens[scenario.id] = 0;
  return tokens;
}

/** A failure to show when the route's own error payload cannot be read. */
const UNREADABLE_ERROR = {
  code: "client_unreadable_response",
  message:
    "The evaluation endpoint returned something this page could not read, so no " +
    "answer is shown. Nothing was substituted for it.",
};

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

export default function PlaygroundPage() {
  const [activeScenarioId, setActiveScenarioId] =
    useState<ScenarioId>(DEFAULT_SCENARIO_ID);
  const [mode, setMode] = useState<PlaygroundMode>("fixture");
  const [drafts, setDrafts] = useState<Record<ScenarioId, string>>(initialDrafts);
  const [results, setResults] = useState<ResultSlots>(initialResults);
  const [errors, setErrors] =
    useState<Record<ScenarioId, PlaygroundError | null>>(initialErrors);
  const [pending, setPending] =
    useState<Record<ScenarioId, boolean>>(initialPending);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>("unknown");
  const [view, setView] = useState<ResponseView>("cards");

  /**
   * The latest request token per scenario. A response whose token is no longer
   * current has been superseded and is dropped rather than displayed.
   */
  const tokens = useRef<Record<ScenarioId, number>>(initialTokens());

  const scenario = getScenario(activeScenarioId);
  const stateText = drafts[activeScenarioId];

  /** Parse once; validation, fixture lookup, and submission all need the value. */
  const parsed = useMemo<{ value: unknown; error: string | null }>(() => {
    try {
      return { value: JSON.parse(stateText) as unknown, error: null };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [stateText]);

  const validation = useMemo<ValidationResult<EvaluationRequest>>(() => {
    // A draft that does not parse is reported by `parsed.error`; there is
    // nothing to schema-check, and the raw text is left untouched.
    if (parsed.error !== null) return { ok: false, errors: [] };
    return validateRequest(
      scenario.stateSchemaId,
      parsed.value,
      scenario.questions,
    );
  }, [parsed, scenario]);

  const isRequestValid = parsed.error === null && validation.ok;

  const matchedSampleId = useMemo(() => {
    if (parsed.error !== null) return null;
    return matchSampleId(scenario.id, parsed.value as State);
  }, [parsed, scenario.id]);

  const result = results[activeScenarioId][mode];
  const isStale = result !== null && result.submittedStateText !== stateText;

  // A failure belongs to the live path; it is never shown next to a fixture.
  const error = mode === "live" ? errors[activeScenarioId] : null;
  const isErrorStale = error !== null && error.submittedStateText !== stateText;
  const isPending = pending[activeScenarioId];

  /**
   * Ask the server whether Live mode is possible at all. This is a plain GET
   * that returns one boolean; it makes no model call and costs nothing, so it
   * is safe on mount and on demand.
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
      setConfigStatus(configured ? "configured" : "missing");
    } catch {
      // Fixture mode must stay fully usable when the check fails, so the
      // failure is recorded and nothing else about the page changes.
      setConfigStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    void checkConfig();
  }, [checkConfig]);

  const setDraft = useCallback(
    (text: string) => {
      setDrafts((previous) => ({ ...previous, [activeScenarioId]: text }));
    },
    [activeScenarioId],
  );

  const loadSample = useCallback(
    (sampleId: string) => {
      // A sample button replaces State only. Questions come from the preset.
      setDraft(formatState(getSample(scenario, sampleId).state));
    },
    [scenario, setDraft],
  );

  const resetPreset = useCallback(() => {
    setDraft(formatState(getDefaultSample(scenario).state));
  }, [scenario, setDraft]);

  const previewFixture = useCallback(() => {
    const request = validation.value;
    if (!isRequestValid || request === undefined) return;
    const fixture = resolveFixture(scenario.id, request.state);
    const preview: PlaygroundResult = {
      source: "fixture",
      scenarioId: scenario.id,
      fixture,
      requestSnapshot: request,
      submittedStateText: stateText,
    };
    setResults((previous) => ({
      ...previous,
      [scenario.id]: { ...previous[scenario.id], fixture: preview },
    }));
  }, [isRequestValid, scenario.id, stateText, validation.value]);

  const evaluateLive = useCallback(async () => {
    const request = validation.value;
    if (!isRequestValid || request === undefined) return;
    if (configStatus !== "configured") return;
    // The disabled button is the visible guard; this is the real one. A second
    // press, a stray keyboard activation, or a replayed event cannot start a
    // second paid call while one is in flight.
    if (pending[scenario.id]) return;

    // Everything the response will be filed under is captured *now*, before the
    // await, so a later switch or edit cannot change where it lands.
    const scenarioId = scenario.id;
    const submittedStateText = stateText;
    const requestSnapshot = request;
    const token = tokens.current[scenarioId] + 1;
    tokens.current[scenarioId] = token;

    setPending((previous) => ({ ...previous, [scenarioId]: true }));

    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        // Only these two fields. The questions and the model are the server's.
        body: JSON.stringify({ scenarioId, state: requestSnapshot.state }),
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

      if (response.ok && isLivePayload(payload)) {
        const live: PlaygroundResult = {
          source: "live",
          scenarioId,
          live: payload,
          requestSnapshot,
          submittedStateText,
        };
        setResults((previous) => ({
          ...previous,
          [scenarioId]: { ...previous[scenarioId], live },
        }));
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
      // with its own snapshot — and this failure stays visible above it. No
      // fixture is substituted.
      setErrors((previous) => ({
        ...previous,
        [scenarioId]: {
          source: "live",
          scenarioId,
          requestSnapshot,
          submittedStateText,
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
          submittedStateText,
          code: "client_network_error",
          message:
            "The browser could not reach the evaluation endpoint, so there is no " +
            "answer to show. Nothing was substituted for it.",
        },
      }));
    } finally {
      // Only the request that still owns this slot may release it.
      if (tokens.current[scenarioId] === token) {
        setPending((previous) => ({ ...previous, [scenarioId]: false }));
      }
    }
  }, [
    configStatus,
    isRequestValid,
    pending,
    scenario.id,
    stateText,
    validation.value,
  ]);

  const submit = useCallback(() => {
    if (mode === "fixture") {
      previewFixture();
      return;
    }
    void evaluateLive();
  }, [evaluateLive, mode, previewFixture]);

  return (
    <main className="mx-auto w-full max-w-[100rem] px-4 py-6 sm:px-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold">Jev playground</h1>
          <p className="text-xs text-[var(--color-ink-soft)]">
            Fixture mode is offline and needs no key. Live mode calls TypeSafe
            Jev once per press, from the server.
          </p>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-[var(--color-ink-soft)]">
          Pick a scenario, load or edit its State, then either preview the fixed
          fixture response or evaluate the request with Jev. Fixture answers were
          written by hand to illustrate the response shape and are not measured
          Jev output. Live answers are one model&rsquo;s judgment of one request:
          they show what the API returns, not how well it performs.
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1.15fr)_minmax(0,1fr)]">
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
            stateText={stateText}
            onStateTextChange={setDraft}
            onLoadSample={loadSample}
            onReset={resetPreset}
            matchedSampleId={matchedSampleId}
            parseError={parsed.error}
            validationErrors={validation.errors}
            isRequestValid={isRequestValid}
            mode={mode}
            onModeChange={setMode}
            configStatus={configStatus}
            onRecheckConfig={() => void checkConfig()}
            isPending={isPending}
            onSubmit={submit}
          />
        </div>

        <div className="min-w-0">
          <ResponsePanel
            scenario={scenario}
            mode={mode}
            result={result}
            error={error}
            isStale={isStale}
            isErrorStale={isErrorStale}
            isPending={isPending && mode === "live"}
            view={view}
            onViewChange={setView}
          />
        </div>
      </div>
    </main>
  );
}

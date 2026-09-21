"use client";

/**
 * The three-panel shell: Scenarios → Request → Response.
 *
 * All state lives here so the panels stay presentational:
 *  - One State draft *per scenario*, preserved across switches.
 *  - One result *per scenario*, so switching scenarios can never display
 *    another scenario's answers.
 *  - Staleness is derived by comparing the current draft text against the text
 *    captured when the fixture was shown. A displayed result is never silently
 *    re-attached to edited input.
 */

import { useCallback, useMemo, useState } from "react";
import { RequestEditor } from "@/components/request-editor";
import type { PreviewResult, ResponseView } from "@/components/response-panel";
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
import type { EvaluationRequest, State } from "@/lib/types";

function formatState(state: unknown): string {
  return JSON.stringify(state, null, 2);
}

function initialDrafts(): Record<ScenarioId, string> {
  const drafts = {} as Record<ScenarioId, string>;
  for (const scenario of SCENARIOS) {
    drafts[scenario.id] = formatState(getDefaultSample(scenario).state);
  }
  return drafts;
}

function initialResults(): Record<ScenarioId, PreviewResult | null> {
  const results = {} as Record<ScenarioId, PreviewResult | null>;
  for (const scenario of SCENARIOS) results[scenario.id] = null;
  return results;
}

export default function PlaygroundPage() {
  const [activeScenarioId, setActiveScenarioId] =
    useState<ScenarioId>(DEFAULT_SCENARIO_ID);
  const [drafts, setDrafts] = useState<Record<ScenarioId, string>>(initialDrafts);
  const [results, setResults] =
    useState<Record<ScenarioId, PreviewResult | null>>(initialResults);
  const [view, setView] = useState<ResponseView>("cards");

  const scenario = getScenario(activeScenarioId);
  const stateText = drafts[activeScenarioId];

  /** Parse once; both validation and fixture lookup need the parsed value. */
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

  const canPreview = parsed.error === null && validation.ok;

  const matchedSampleId = useMemo(() => {
    if (parsed.error !== null) return null;
    return matchSampleId(scenario.id, parsed.value as State);
  }, [parsed, scenario.id]);

  const result = results[activeScenarioId];
  const isStale = result !== null && result.submittedStateText !== stateText;

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
    if (!canPreview || request === undefined) return;
    const fixture = resolveFixture(scenario.id, request.state);
    const preview: PreviewResult = {
      scenarioId: scenario.id,
      fixture,
      requestSnapshot: request,
      submittedStateText: stateText,
    };
    setResults((previous) => ({ ...previous, [scenario.id]: preview }));
  }, [canPreview, scenario.id, stateText, validation.value]);

  return (
    <main className="mx-auto w-full max-w-[100rem] px-4 py-6 sm:px-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold">Jev playground</h1>
          <p className="text-xs text-[var(--color-ink-soft)]">
            Local, offline, fixture-only. No API key, no model call, no request
            leaves the browser.
          </p>
        </div>
        <p className="mt-2 max-w-4xl text-sm text-[var(--color-ink-soft)]">
          Pick a scenario, load or edit its State, then preview the fixed
          fixture response for that request. Answers shown here were written by
          hand to illustrate the response shape; they are not measured Jev
          output and say nothing about how Jev performs.
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
            canPreview={canPreview}
            onPreview={previewFixture}
          />
        </div>

        <div className="min-w-0">
          <ResponsePanel
            scenario={scenario}
            result={result}
            isStale={isStale}
            view={view}
            onViewChange={setView}
          />
        </div>
      </div>
    </main>
  );
}

"use client";

/** Panel 1 of 3: choose a scenario. */

import type { Scenario, ScenarioId } from "@/lib/scenarios";

export function ScenarioPicker({
  scenarios,
  activeId,
  onSelect,
}: {
  scenarios: Scenario[];
  activeId: ScenarioId;
  onSelect: (id: ScenarioId) => void;
}) {
  return (
    <section
      aria-labelledby="scenarios-heading"
      className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5"
    >
      <h2
        id="scenarios-heading"
        className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]"
      >
        Scenarios
      </h2>

      <ul role="list" className="mt-4 space-y-3">
        {scenarios.map((scenario) => {
          const isActive = scenario.id === activeId;
          return (
            <li key={scenario.id}>
              <button
                type="button"
                aria-current={isActive ? "true" : undefined}
                data-testid={`scenario-${scenario.id}`}
                onClick={() => onSelect(scenario.id)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  isActive
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-line)] bg-[var(--color-panel)] hover:border-[var(--color-ink-soft)]"
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{scenario.name}</span>
                  {isActive ? (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">
                      Selected
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs text-[var(--color-ink-soft)]">
                  {scenario.questionOrder.length} questions,{" "}
                  {scenario.samples.length} samples
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-5 border-t border-[var(--color-line)] pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
          About this scenario
        </h3>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          {scenarios.find((scenario) => scenario.id === activeId)?.purpose}
        </p>
        <p
          data-testid="scenario-caveat"
          className="mt-3 rounded-lg bg-[var(--color-warn-soft)] p-3 text-xs text-[var(--color-ink)]"
        >
          {scenarios.find((scenario) => scenario.id === activeId)?.caveat}
        </p>
      </div>
    </section>
  );
}

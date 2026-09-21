"use client";

/**
 * Panel 1 of 3: choose a scenario.
 *
 * Each scenario is one full-card button: its name, the distinct question types
 * its preset asks, and a one-sentence purpose. The full purpose and the
 * scenario's caveat live in the "About this scenario" disclosure beside the
 * request heading.
 */

import type { Scenario, ScenarioId } from "@/lib/scenarios";

/** One sentence per preset, for the card. The full purpose is in the disclosure. */
const CARD_SUMMARIES: Record<ScenarioId, string> = {
  safety:
    "Screen a student's message for self-harm concerns and targeted insults, and pick a handling path.",
  municipal:
    "Pick the best agency and the next routing step for one piece of resident feedback.",
};

/** The preset's distinct question types, in the order its questions appear. */
function presetTypes(scenario: Scenario): string[] {
  const types: string[] = [];
  for (const id of scenario.questionOrder) {
    const type = scenario.questions[id]?.type;
    if (type && !types.includes(type)) types.push(type);
  }
  return types;
}

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
    <section aria-labelledby="scenarios-heading">
      <h2 id="scenarios-heading" className="tag-heading">
        Scenarios
      </h2>

      <ul role="list" className="mt-5 space-y-5">
        {scenarios.map((scenario) => {
          const isActive = scenario.id === activeId;
          return (
            <li key={scenario.id}>
              <button
                type="button"
                aria-current={isActive ? "true" : undefined}
                data-testid={`scenario-${scenario.id}`}
                onClick={() => onSelect(scenario.id)}
                className={`hard-card block w-full p-4 text-left transition-transform hover:-translate-x-px hover:-translate-y-px ${
                  isActive ? "!bg-[var(--color-highlight)]" : ""
                }`}
              >
                <span className="block text-lg font-extrabold leading-snug">
                  {scenario.name}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="badge" data-testid={`scenario-types-${scenario.id}`}>
                    {presetTypes(scenario).join(" · ")}
                  </span>
                  {isActive ? (
                    <span className="text-[10px] font-extrabold uppercase tracking-widest">
                      Selected
                    </span>
                  ) : null}
                </span>
                <span className="mt-2 block text-sm leading-relaxed">
                  {CARD_SUMMARIES[scenario.id]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

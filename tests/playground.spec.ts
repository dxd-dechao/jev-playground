/**
 * Browser tests for the three-panel shell (JEV-08: live-only).
 *
 * These check interaction and honesty properties of the UI, not model quality:
 * the default view, the single Evaluate action, scenario switching and reset,
 * per-scenario draft preservation, a retained malformed draft with Evaluate
 * disabled, staleness after an edit, no cross-scenario result leakage, and the
 * live badge in both result views. Two viewport projects (1440px and 390px)
 * also assert no horizontal overflow and save screenshots as test evidence.
 *
 * ================================================================
 * MOCKED ENDPOINTS ONLY — NOT PROVIDER VERIFICATION
 * ----------------------------------------------------------------
 * `/api/config` and `/api/evaluate` are fulfilled with `page.route`. The mocked
 * answers are taken from the offline fixture library for the submitted State
 * and questions, so the composition and label assertions have fixed values to
 * check. They are test scaffolding, not model output; nothing reaches
 * TypeSafe, and the Playwright server runs with an empty key.
 * ================================================================
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import { resolveFixtureForRequest } from "../lib/fixtures";
import type { ScenarioId } from "../lib/scenarios";
import type { EvaluationRequest } from "../lib/types";

const SAFETY_DEFAULT_MESSAGE =
  "In this novel, why does the character talk about hurting herself?";

async function stateText(page: Page): Promise<string> {
  return page.getByTestId("state-editor").inputValue();
}

async function setStateText(page: Page, text: string) {
  await page.getByTestId("state-editor").fill(text);
}

/** One question in the Form, found by its current id. */
function questionRow(page: Page, id: string) {
  return page.locator(`[data-testid="question-row"][data-question-id="${id}"]`);
}

/** The sample buttons only — the `<button>` elements inside the sample groups. */
function sampleButtons(page: Page) {
  return page.locator('button[data-testid^="sample-"]');
}

function evaluateButton(page: Page) {
  return page.getByTestId("evaluate-live");
}

/** Every `/api/evaluate` body the page sent, in order. */
let evaluateBodies: Array<Record<string, unknown>> = [];

async function mockEndpoints(page: Page) {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true }),
    }),
  );
  await page.route("**/api/evaluate", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    evaluateBodies.push(body);
    const fixture = resolveFixtureForRequest(body.scenarioId as ScenarioId, {
      state: body.state,
      questions: body.questions,
    } as EvaluationRequest);
    if (fixture === null) {
      await route.fulfill({ status: 500, body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "live",
        requestedModel: "jev-latest",
        response: {
          model: "jev-1-mocked",
          answers: fixture.response.answers,
          usage: { input_tokens: 400, output_tokens: 20 },
        },
        durationMs: 512,
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  test.info().annotations.push({
    type: "evidence",
    description: "Mocked /api/config and /api/evaluate. No real provider call was made.",
  });
  evaluateBodies = [];
  await mockEndpoints(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Jev playground" })).toBeVisible();
  await expect(evaluateButton(page)).toBeEnabled();
});

test("defaults to the safety scenario with its default sample loaded", async ({
  page,
}) => {
  await expect(page.getByTestId("scenario-safety")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByTestId("scenario-municipal")).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(await stateText(page)).toContain(SAFETY_DEFAULT_MESSAGE);

  // All nine safety samples and all three safety questions are present.
  await expect(sampleButtons(page)).toHaveCount(9);
  await expect(questionRow(page, "self_harm_context")).toBeVisible();
  await expect(questionRow(page, "targeted_insult")).toBeVisible();
  await expect(questionRow(page, "handling")).toBeVisible();
  await expect(page.getByTestId("question-count")).toContainText("Questions (3");

  // Nothing is shown in the response panel until the request is evaluated.
  await expect(page.getByTestId("response-empty")).toBeVisible();
  expect(evaluateBodies).toEqual([]);
});

test("offers one live action: no mode selector, fixture preview, or extra copy", async ({
  page,
}) => {
  for (const removed of [
    "mode-fixture",
    "mode-live",
    "mode-description",
    "preview-fixture",
    "fixture-badge",
    "fixture-unavailable",
    "request-summary",
    "shortcut-hint",
    "config-status",
  ]) {
    await expect(page.getByTestId(removed), removed).toHaveCount(0);
  }
  await expect(page.getByText("Preview fixture")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Evaluation mode" })).toHaveCount(0);

  // Configured and valid: the action area holds exactly the one button.
  const area = page.getByTestId("submit-area");
  await expect(area.locator("button")).toHaveCount(1);
  expect((await area.innerText()).trim()).toBe("Evaluate with Jev");
  await expect(evaluateButton(page)).toHaveAccessibleName("Evaluate with Jev");
  await expect(evaluateButton(page)).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Enter Control+Enter",
  );
});

test("loads every sample in both scenarios, with no sample metadata shown", async ({
  page,
}) => {
  const noMetadata = async () => {
    await expect(page.getByTestId("selected-sample-info")).toHaveCount(0);
    await expect(page.getByTestId("custom-state-note")).toHaveCount(0);
    await expect(page.getByText("Sample metadata")).toHaveCount(0);
    await expect(page.getByText("Proposed expected outcome")).toHaveCount(0);
    await expect(page.getByText("About this sample")).toHaveCount(0);
  };

  const safetySamples = sampleButtons(page);
  await expect(safetySamples).toHaveCount(9);
  for (const sample of await safetySamples.all()) {
    await sample.click();
    await expect(sample).toHaveAttribute("aria-pressed", "true");
    await expect(evaluateButton(page)).toBeEnabled();
    await noMetadata();
  }

  await page.getByTestId("scenario-municipal").click();
  const municipalSamples = sampleButtons(page);
  await expect(municipalSamples).toHaveCount(3);
  for (const sample of await municipalSamples.all()) {
    await sample.click();
    await expect(sample).toHaveAttribute("aria-pressed", "true");
    await expect(evaluateButton(page)).toBeEnabled();
    await noMetadata();
  }

  // Nothing about the sample's expected outcome reaches State.
  expect(await stateText(page)).not.toContain("expected");
  await setStateText(page, '{ "feedback": "A custom State that matches no sample." }');
  await noMetadata();
  expect(evaluateBodies).toEqual([]);
});

test("a sample button replaces State, and Reset restores the preset", async ({
  page,
}) => {
  await page.getByTestId("sample-allow-idiom").click();
  expect(await stateText(page)).toContain("This homework is killing me!");
  // The questions are the preset's and did not change with the sample.
  await expect(questionRow(page, "handling")).toBeVisible();

  await page.getByTestId("reset-preset").click();
  expect(await stateText(page)).toContain(SAFETY_DEFAULT_MESSAGE);
});

test("preserves a separate draft per scenario across switches", async ({
  page,
}) => {
  const safetyEdit = JSON.stringify(
    {
      student_message: "A safety draft that only this scenario should keep.",
      conversation_history: [],
      learning_context: "Student learning assistant.",
    },
    null,
    2,
  );
  await setStateText(page, safetyEdit);

  await page.getByTestId("scenario-municipal").click();
  expect(await stateText(page)).toContain("traffic light");
  expect(await stateText(page)).not.toContain("only this scenario should keep");

  const municipalEdit = (await stateText(page)).replace(
    "has stopped working",
    "has been dark for two nights",
  );
  await setStateText(page, municipalEdit);

  await page.getByTestId("scenario-safety").click();
  expect(await stateText(page)).toContain("only this scenario should keep");

  await page.getByTestId("scenario-municipal").click();
  expect(await stateText(page)).toContain("has been dark for two nights");
});

test("keeps a malformed JSON draft and disables Evaluate with an actionable error", async ({
  page,
}) => {
  const broken = '{ "student_message": "Missing a brace"';
  await setStateText(page, broken);

  // The exact text the reviewer typed is retained.
  expect(await stateText(page)).toBe(broken);
  await expect(page.getByTestId("state-errors")).toBeVisible();
  await expect(page.getByTestId("state-errors")).toContainText("not valid JSON");
  await expect(page.getByTestId("state-errors")).toContainText("kept exactly");
  await expect(evaluateButton(page)).toBeDisabled();
  await expect(page.getByTestId("state-editor")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  // The disabled button says why, through its description.
  await expect(page.getByTestId("submit-blocked")).toBeVisible();
  await expect(evaluateButton(page)).toHaveAccessibleDescription(/Fix the State/);
  // Text cannot be used to paper over it: the lossy switch is refused.
  await expect(page.getByTestId("state-mode-text")).toBeDisabled();
  await expect(page.getByTestId("state-text-unavailable")).toContainText("not valid JSON");

  // A schema-valid shape re-enables Evaluate and removes the notice.
  await page.getByTestId("reset-preset").click();
  await expect(page.getByTestId("state-errors")).toHaveCount(0);
  await expect(evaluateButton(page)).toBeEnabled();
  await expect(page.getByTestId("submit-blocked")).toHaveCount(0);
  expect(evaluateBodies).toEqual([]);
});

test("warns, without blocking, when State lacks the fields the preset questions read", async ({
  page,
}) => {
  // Since JEV-03 the preset State schema is advice: a differently shaped State
  // is a valid request, it just gives the default questions less to read.
  await setStateText(page, JSON.stringify({ student_message: "Only this" }, null, 2));
  await expect(page.getByTestId("request-warnings")).toContainText(
    "shape the preset questions refer to",
  );
  await expect(page.getByTestId("request-warnings")).toContainText("learning_context");
  await expect(page.getByTestId("request-errors")).toHaveCount(0);
  await expect(evaluateButton(page)).toBeEnabled();
});

test("disables submission for a State the API does not accept", async ({ page }) => {
  for (const text of ["null", "42", "true", "{}"]) {
    await setStateText(page, text);
    await expect(page.getByTestId("request-errors"), text).toContainText(
      "does not match the expected shape",
    );
    await expect(evaluateButton(page)).toBeDisabled();
    await expect(evaluateButton(page)).toHaveAccessibleDescription(/does not match the expected shape/);
  }
});

test("refuses a State that carries an expected label", async ({ page }) => {
  await setStateText(
    page,
    JSON.stringify(
      {
        student_message: "Hello",
        conversation_history: [],
        learning_context: "Student learning assistant.",
        expected_handling: "allow",
      },
      null,
      2,
    ),
  );
  await expect(page.getByTestId("request-errors")).toContainText(
    "must not contain expected labels",
  );
  await expect(evaluateButton(page)).toBeDisabled();
});

test("shows the live badge in both Cards and JSON views", async ({ page }) => {
  await evaluateButton(page).click();

  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("live-badge")).toContainText("real model call");
  await expect(page.getByTestId("result-model")).toHaveText("Model: jev-1-mocked");
  await expect(page.getByTestId("fixture-badge")).toHaveCount(0);
  await expect(page.getByTestId("composed-outcome")).toBeVisible();
  await expect(page.getByTestId("answer-self_harm_context")).toBeVisible();
  await expect(page.getByTestId("measurement-block")).toContainText("jev-1-mocked");
  await expect(page.getByTestId("measurement-block")).toContainText("512 ms");

  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("response-json")).toContainText('"model": "jev-1-mocked"');
  await expect(page.getByTestId("json-measurement")).toBeVisible();

  await page.getByTestId("view-cards").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  expect(evaluateBodies).toHaveLength(1);
});

test("cards agree with the response JSON and keep the full distribution", async ({
  page,
}) => {
  await page.getByTestId("sample-self-harm-immediate").click();
  await evaluateButton(page).click();

  await expect(page.getByTestId("safety-recommendation")).toHaveText("Support");
  const selfHarmCard = page.getByTestId("answer-self_harm_context");
  await expect(selfHarmCard).toContainText("Urgent support");
  // Every one of the five options is listed as readable text, not just the winner.
  for (const label of [
    "No self-harm signal",
    "Contextual reference",
    "Support needed",
    "Urgent support",
    "Harmful request",
  ]) {
    await expect(selfHarmCard).toContainText(label);
  }
  await expect(selfHarmCard).toContainText("93.0%");
  await expect(selfHarmCard).toContainText("Confidence");

  // The Noul is presented as a probability of targeted insult, not accuracy.
  const insultCard = page.getByTestId("answer-targeted_insult");
  await expect(insultCard).toContainText("Probability that the student is using");
  await expect(insultCard).toContainText("2.0%");
  await expect(insultCard).toContainText("not a measure of accuracy");

  await page.getByTestId("view-json").click();
  const json = await page.getByTestId("response-json").innerText();
  expect(json).toContain('"urgent_support": 0.93');
  expect(json).toContain('"noul": 0.02');
});

test("marks a displayed result stale after State is edited", async ({ page }) => {
  await evaluateButton(page).click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);

  const edited = (await stateText(page)).replace(
    "Secondary-school literature discussion.",
    "Secondary-school literature discussion, week 4.",
  );
  await setStateText(page, edited);

  await expect(page.getByTestId("stale-warning")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toContainText(
    "earlier request snapshot",
  );
  expect(evaluateBodies).toHaveLength(1);

  // Evaluating again answers the edited request and clears the staleness.
  await evaluateButton(page).click();
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);
  expect(evaluateBodies).toHaveLength(2);
  expect((evaluateBodies[1]!.state as { learning_context: string }).learning_context).toBe(
    "Secondary-school literature discussion, week 4.",
  );
});

test("never attaches one scenario's result to another scenario", async ({
  page,
}) => {
  await page.getByTestId("sample-self-harm-immediate").click();
  await evaluateButton(page).click();
  await expect(page.getByTestId("safety-recommendation")).toHaveText("Support");

  // Switching scenarios shows that scenario's own empty state, not this result.
  await page.getByTestId("scenario-municipal").click();
  await expect(page.getByTestId("response-empty")).toBeVisible();
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  await expect(page.getByTestId("safety-recommendation")).toHaveCount(0);

  // The municipal evaluation shows municipal answers only.
  await evaluateButton(page).click();
  await expect(page.getByTestId("municipal-status")).toHaveText("Recommended agency");
  await expect(page.getByTestId("municipal-agency")).toHaveText("LTA");
  await expect(page.getByTestId("answer-primary_agency")).toBeVisible();
  await expect(page.getByTestId("answer-self_harm_context")).toHaveCount(0);

  // Switching back restores the safety result, unchanged.
  await page.getByTestId("scenario-safety").click();
  await expect(page.getByTestId("safety-recommendation")).toHaveText("Support");
  await expect(page.getByTestId("municipal-status")).toHaveCount(0);
});

test("suppresses routing for the clearly unrelated municipal sample", async ({
  page,
}) => {
  await page.getByTestId("scenario-municipal").click();
  await page.getByTestId("sample-municipal-unrelated").click();
  await evaluateButton(page).click();

  await expect(page.getByTestId("municipal-status")).toHaveText(
    "No routing recommendation",
  );
  await expect(page.getByTestId("municipal-agency")).toHaveText("None shown");
  // The raw answer is still visible with its full distribution.
  await expect(page.getByTestId("answer-primary_agency")).toContainText("Unclear");
  await expect(page.getByTestId("answer-primary_agency")).toContainText("LTA");
});

test("makes no external request, and evaluates only on an explicit press", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!/^https?:\/\/127\.0\.0\.1:3100\//.test(url) && !url.startsWith("data:")) {
      external.push(url);
    }
  });

  await page.reload();
  await expect(evaluateButton(page)).toBeEnabled();

  // Typing, samples, Text/JSON, Form/JSON view, response view, Reset and
  // scenario switches are never enough to start a call.
  await page.getByTestId("sample-self-harm-harmful-request").click();
  await page.getByTestId("state-mode-text").click();
  await setStateText(page, "typing in Text");
  await page.getByTestId("state-mode-json").click();
  await page.getByTestId("request-view-json").click();
  await page.getByTestId("request-view-form").click();
  await page.getByTestId("view-json").click();
  await page.getByTestId("view-cards").click();
  await page.getByTestId("reset-preset").click();
  await page.getByTestId("scenario-municipal").click();
  await page.getByTestId("scenario-safety").click();
  await page.waitForTimeout(300);
  expect(evaluateBodies, "no evaluation may start without a press").toEqual([]);

  await evaluateButton(page).click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  expect(evaluateBodies).toHaveLength(1);

  expect(external, `unexpected external requests: ${external.join(", ")}`).toEqual([]);
});

test("labels every control and gives each a visible keyboard focus", async ({
  page,
}) => {
  // The State editor is associated with a real label element.
  const editor = page.getByTestId("state-editor");
  const editorId = await editor.getAttribute("id");
  expect(editorId).toBeTruthy();
  await expect(page.locator(`label[for="${editorId}"]`)).toHaveText("State");

  // Every button has an accessible name.
  for (const button of await page.getByRole("button").all()) {
    const name = ((await button.textContent()) ?? "").trim();
    expect(name.length).toBeGreaterThan(0);
  }

  // The three panels are landmark-labelled regions.
  for (const heading of ["Scenarios", "Request", "Response"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  // Keyboard focus reaches the Evaluate button and activates it.
  await editor.focus();
  await expect(editor).toBeFocused();
  await evaluateButton(page).focus();
  await expect(evaluateButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("live-badge")).toBeVisible();
  expect(evaluateBodies).toHaveLength(1);
});

test("lays out without horizontal overflow and saves screenshot evidence", async ({
  page,
}, testInfo) => {
  await evaluateButton(page).click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // Allow a single pixel for sub-pixel rounding.
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(1);

  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-safety-cards.png`,
    fullPage: true,
  });

  await page.getByTestId("scenario-municipal").click();
  await evaluateButton(page).click();
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("response-json")).toBeVisible();
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-municipal-json.png`,
    fullPage: true,
  });
});

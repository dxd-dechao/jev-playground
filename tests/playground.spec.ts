/**
 * Browser tests for the three-panel shell, in Fixture mode.
 *
 * These check interaction and honesty properties of the UI, not model quality:
 * the default view, scenario switching and reset, per-scenario draft
 * preservation, a retained malformed draft with preview disabled, staleness
 * after an edit, no cross-scenario result leakage, and the fixture badge in
 * both result views. Two viewport projects (1440px and 390px) also assert no
 * horizontal overflow and save screenshots as test evidence.
 *
 * Fixture mode is the default, so these are also the regression tests for the
 * offline path: nothing here may reach `/api/evaluate`. Live behaviour lives in
 * `live-playground.spec.ts` and is mocked there.
 */

import { expect, test, type Page } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Jev playground" })).toBeVisible();
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

  // Nothing is shown in the response panel until a preview is requested.
  await expect(page.getByTestId("response-empty")).toBeVisible();
});

test("defaults to Fixture mode, with Live an explicit choice", async ({ page }) => {
  await expect(page.getByTestId("mode-fixture")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("mode-live")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // The default action cannot spend anything.
  await expect(page.getByTestId("preview-fixture")).toBeVisible();
  await expect(page.getByTestId("evaluate-live")).toHaveCount(0);
  await expect(page.getByTestId("mode-description")).toContainText(
    "No model is called",
  );
});

test("loads every sample in both scenarios: twelve in total", async ({ page }) => {
  const safetySamples = sampleButtons(page);
  await expect(safetySamples).toHaveCount(9);
  for (const sample of await safetySamples.all()) {
    await sample.click();
    await expect(page.getByTestId("preview-fixture")).toBeEnabled();
    await expect(page.getByTestId("selected-sample-info")).toBeVisible();
  }

  await page.getByTestId("scenario-municipal").click();
  const municipalSamples = sampleButtons(page);
  await expect(municipalSamples).toHaveCount(3);
  for (const sample of await municipalSamples.all()) {
    await sample.click();
    await expect(page.getByTestId("preview-fixture")).toBeEnabled();
    await expect(page.getByTestId("selected-sample-info")).toBeVisible();
  }
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

test("keeps a malformed JSON draft and disables preview with an actionable error", async ({
  page,
}) => {
  const broken = '{ "student_message": "Missing a brace"';
  await setStateText(page, broken);

  // The exact text the reviewer typed is retained.
  expect(await stateText(page)).toBe(broken);
  await expect(page.getByTestId("state-errors")).toBeVisible();
  await expect(page.getByTestId("state-errors")).toContainText("not valid JSON");
  await expect(page.getByTestId("state-errors")).toContainText("kept exactly");
  await expect(page.getByTestId("preview-fixture")).toBeDisabled();
  await expect(page.getByTestId("state-editor")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  // A schema-valid shape re-enables preview.
  await page.getByTestId("reset-preset").click();
  await expect(page.getByTestId("state-errors")).toHaveCount(0);
  await expect(page.getByTestId("preview-fixture")).toBeEnabled();
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
  await expect(page.getByTestId("preview-fixture")).toBeEnabled();
});

test("disables submission for a State the API does not accept", async ({ page }) => {
  for (const text of ["null", "42", "true", "{}"]) {
    await setStateText(page, text);
    await expect(page.getByTestId("request-errors"), text).toContainText(
      "does not match the expected shape",
    );
    await expect(page.getByTestId("preview-fixture")).toBeDisabled();
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
  await expect(page.getByTestId("preview-fixture")).toBeDisabled();
});

test("shows the fixture badge in both Cards and JSON views", async ({ page }) => {
  await page.getByTestId("preview-fixture").click();

  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("fixture-badge")).toContainText("no model call");
  await expect(page.getByTestId("result-source")).toHaveText("Source: fixture");
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  await expect(page.getByTestId("composed-outcome")).toBeVisible();
  await expect(page.getByTestId("answer-self_harm_context")).toBeVisible();
  // Nothing measured may look measured.
  await expect(page.getByTestId("measurement-block")).toContainText("Unavailable");

  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("result-source")).toHaveText("Source: fixture");
  await expect(page.getByTestId("response-json")).toBeVisible();
  const json = await page.getByTestId("response-json").innerText();
  expect(json).not.toContain('"model"');
  expect(json).not.toContain('"usage"');
  // Live-only measurements have no place next to a fixture.
  await expect(page.getByTestId("json-measurement")).toHaveCount(0);

  await page.getByTestId("view-cards").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
});

test("cards agree with the fixture JSON and keep the full distribution", async ({
  page,
}) => {
  await page.getByTestId("sample-self-harm-immediate").click();
  await page.getByTestId("preview-fixture").click();

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
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
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

  // Previewing again clears the staleness and falls back to the generic fixture,
  // because the edited State matches no sample.
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);
  await expect(page.getByTestId("fixture-kind")).toContainText("Generic placeholder");
});

test("never attaches one scenario's result to another scenario", async ({
  page,
}) => {
  await page.getByTestId("sample-self-harm-immediate").click();
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("safety-recommendation")).toHaveText("Support");

  // Switching scenarios shows that scenario's own empty state, not this result.
  await page.getByTestId("scenario-municipal").click();
  await expect(page.getByTestId("response-empty")).toBeVisible();
  await expect(page.getByTestId("fixture-badge")).toHaveCount(0);
  await expect(page.getByTestId("safety-recommendation")).toHaveCount(0);

  // The municipal preview shows municipal answers only.
  await page.getByTestId("preview-fixture").click();
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
  await page.getByTestId("preview-fixture").click();

  await expect(page.getByTestId("municipal-status")).toHaveText(
    "No routing recommendation",
  );
  await expect(page.getByTestId("municipal-agency")).toHaveText("None shown");
  // The raw answer is still visible with its full distribution.
  await expect(page.getByTestId("answer-primary_agency")).toContainText("Unclear");
  await expect(page.getByTestId("answer-primary_agency")).toContainText("LTA");
});

test("makes no external request and never calls evaluate in Fixture mode", async ({
  page,
}) => {
  const external: string[] = [];
  const evaluateCalls: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:\/\/127\.0\.0\.1:3100\//.test(url) && !url.startsWith("data:")) {
      external.push(url);
    }
    // `/api/config` is expected: it is a same-origin GET returning one boolean
    // and makes no model call. `/api/evaluate` is the one that costs money.
    if (url.includes("/api/evaluate")) evaluateCalls.push(url);
    await route.continue();
  });

  await page.reload();
  await page.getByTestId("sample-self-harm-harmful-request").click();
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("response-json")).toBeVisible();

  // Switching mode, typing, and resetting must not be enough to start a call.
  await page.getByTestId("mode-live").click();
  await page.getByTestId("state-editor").fill('{ "student_message": "typing" }');
  await page.getByTestId("reset-preset").click();
  await page.getByTestId("mode-fixture").click();
  await page.getByTestId("preview-fixture").click();

  expect(external, `unexpected external requests: ${external.join(", ")}`).toEqual(
    [],
  );
  expect(
    evaluateCalls,
    `no evaluation may be requested in Fixture mode: ${evaluateCalls.join(", ")}`,
  ).toEqual([]);
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

  // Keyboard focus reaches the preview button and activates it.
  await editor.focus();
  await expect(editor).toBeFocused();
  await page.getByTestId("preview-fixture").focus();
  await expect(page.getByTestId("preview-fixture")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
});

test("lays out without horizontal overflow and saves screenshot evidence", async ({
  page,
}, testInfo) => {
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();

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
  await page.getByTestId("preview-fixture").click();
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("response-json")).toBeVisible();
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-municipal-json.png`,
    fullPage: true,
  });
});

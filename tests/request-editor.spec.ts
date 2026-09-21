/**
 * Browser tests for the request editor (JEV-03): editable State and questions
 * in a Form or as whole-request JSON, and how results stay bound to what was
 * actually submitted.
 *
 * ================================================================
 * MOCKED ENDPOINTS ONLY — NOT PROVIDER VERIFICATION
 * ----------------------------------------------------------------
 * Live-mode tests fulfil `/api/config` and `/api/evaluate` with `page.route`.
 * The mocked answers are built from the questions the page sent, so a test
 * can check that a custom question's answer renders; they are test scaffolding,
 * not model output, and nothing reaches TypeSafe. The Playwright server runs
 * with an empty key (see `playwright.config.ts`).
 * ================================================================
 */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { getScenario } from "../lib/scenarios";

const MOCKED = {
  type: "evidence",
  description:
    "Mocked /api/config and /api/evaluate responses built from the submitted questions. No real provider call was made.",
} as const;

test.beforeEach(() => {
  test.info().annotations.push(MOCKED);
});

const SAFETY = getScenario("safety");
const HANDLING_INSTRUCTIONS = (SAFETY.questions.handling as { instructions: string })
  .instructions;

/* ------------------------------------------------------------ Helpers -- */

function questionRow(page: Page, id: string): Locator {
  return page.locator(`[data-testid="question-row"][data-question-id="${id}"]`);
}

function rows(page: Page): Locator {
  return page.getByTestId("question-row");
}

function submitButton(page: Page, mode: "fixture" | "live"): Locator {
  return page.getByTestId(mode === "fixture" ? "preview-fixture" : "evaluate-live");
}

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Jev playground" })).toBeVisible();
}

async function mockConfig(page: Page) {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true }),
    }),
  );
}

type SentQuestion = {
  type: "noul" | "choice" | "score";
  criteria?: unknown;
};

/**
 * A valid live-shaped answer for each submitted question. Test scaffolding:
 * the numbers are fixed and mean nothing; they exist so the page has a
 * well-formed response to the exact questions it sent.
 */
function answersFor(questions: Record<string, SentQuestion>) {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: 0.73 };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria as object);
      answers[id] = {
        type: "choice",
        choice: options[0],
        probabilities: Object.fromEntries(
          options.map((option, index) => [
            option,
            index === 0 ? 1 - 0.01 * (options.length - 1) : 0.01,
          ]),
        ),
        confidence: 0.66,
      };
    } else {
      const levels = question.criteria as unknown[];
      answers[id] = {
        type: "score",
        score: 1.25,
        legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
        probabilities: Object.fromEntries(
          levels.map((_, index) => [String(index), index === 1 ? 0.75 : 0.25 / (levels.length - 1)]),
        ),
        confidence: 0.42,
      };
    }
  }
  return answers;
}

interface EvaluateMock {
  requests: Array<Record<string, unknown>>;
  release: () => void;
}

async function mockEvaluate(page: Page, options: { delay?: boolean } = {}): Promise<EvaluateMock> {
  const requests: Array<Record<string, unknown>> = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/evaluate", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    requests.push(body);
    if (options.delay) await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "live",
        requestedModel: "jev-latest",
        response: {
          model: "jev-1-mocked",
          answers: answersFor(body.questions as Record<string, SentQuestion>),
          usage: { input_tokens: 321, output_tokens: 12 },
        },
        durationMs: 640,
      }),
    });
  });
  return { requests, release };
}

async function goLive(page: Page, options: { delay?: boolean } = {}) {
  await mockConfig(page);
  const evaluate = await mockEvaluate(page, options);
  await open(page);
  await page.getByTestId("mode-live").click();
  await expect(page.getByTestId("config-status")).toHaveAttribute("data-status", "configured");
  return evaluate;
}

/** Build a custom Score question through the Form, as a reviewer would. */
async function addScoreQuestion(page: Page) {
  await page.getByTestId("add-question").click();
  const row = rows(page).last();
  await row.getByTestId("question-id-input").fill("clarity");
  await row.getByTestId("question-type").selectOption("score");
  await row.getByTestId("question-instructions").fill("How clear is `student_message`?");
  await row.getByTestId("score-level").nth(0).fill("Unclear");
  await row.getByTestId("score-level").nth(1).fill("Mostly clear");
  await row.getByTestId("add-level").click();
  await row.getByTestId("score-level").nth(2).fill("Perfectly clear");
  return row;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(1);
}

/* -------------------------------------------------------- Form editing -- */

test("adds, renames, retypes, edits criteria, and removes questions in the Form", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId("question-count")).toContainText("Questions (3");

  // Add, then rename — focus stays in the id input while typing.
  await page.getByTestId("add-question").click();
  await expect(page.getByTestId("question-count")).toContainText("Questions (4");
  const idInput = rows(page).last().getByTestId("question-id-input");
  await idInput.click();
  await idInput.press("ControlOrMeta+a");
  await idInput.pressSequentially("is_question");
  await expect(idInput).toBeFocused();
  await expect(questionRow(page, "is_question")).toHaveCount(1);

  // Choice criteria: add, rename, and remove options.
  const handling = questionRow(page, "handling");
  await expect(handling.getByTestId("choice-option")).toHaveCount(4);
  await handling.getByTestId("add-option").click();
  await handling.getByTestId("option-name").nth(4).fill("escalate");
  await handling.getByTestId("option-name").nth(0).fill("permit");
  await handling.getByTestId("remove-option").nth(1).click();
  await expect(handling.getByTestId("choice-option")).toHaveCount(4);

  // Score levels: reorder and remove.
  const added = await addScoreQuestion(page);
  await added.getByTestId("level-up").nth(2).click();
  await expect(added.getByTestId("score-level").nth(1)).toHaveValue("Perfectly clear");

  // A type change resets criteria: no old options survive, hidden or shown.
  await handling.getByTestId("question-type").selectOption("score");
  await expect(handling.getByTestId("choice-option")).toHaveCount(0);
  await expect(handling.getByTestId("score-level")).toHaveCount(2);
  await expect(handling.getByTestId("score-level").nth(0)).toHaveValue("");
  await handling.getByTestId("question-type").selectOption("choice");
  await expect(handling.getByTestId("option-name").nth(0)).toHaveValue("");
  await expect(handling).not.toContainText("redirect");

  // Remove a question.
  await questionRow(page, "is_question").getByTestId("remove-question").click();
  await expect(questionRow(page, "is_question")).toHaveCount(0);

  // The JSON view shows exactly what the Form now says.
  await questionRow(page, "handling").getByTestId("question-type").selectOption("noul");
  await page.getByTestId("request-view-json").click();
  const request = JSON.parse(
    await page.getByTestId("request-json-editor").inputValue(),
  ) as { questions: Record<string, { type: string; criteria?: unknown }> };
  expect(Object.keys(request.questions)).toEqual([
    "self_harm_context",
    "targeted_insult",
    "handling",
    "clarity",
  ]);
  expect(request.questions.handling!.type).toBe("noul");
  expect(request.questions.handling).not.toHaveProperty("criteria");
  expect(request.questions.clarity!.criteria).toEqual([
    "Unclear",
    "Perfectly clear",
    "Mostly clear",
  ]);
});

test("Form → JSON → Form keeps structured values and explicit null descriptions", async ({
  page,
}) => {
  await open(page);
  const handling = questionRow(page, "handling");
  await handling.getByTestId("question-instructions-kind").selectOption("json");
  await handling
    .getByTestId("question-instructions")
    .fill('{ "task": "Recommend a handling path.", "read": ["`student_message`"] }');
  await handling.getByTestId("option-description-kind").nth(3).selectOption("null");
  const insult = questionRow(page, "targeted_insult");
  await insult.getByTestId("noul-false-kind").selectOption("absent");

  await page.getByTestId("request-view-json").click();
  const json = JSON.parse(await page.getByTestId("request-json-editor").inputValue()) as {
    questions: Record<string, { instructions: unknown; criteria: Record<string, unknown> }>;
  };
  expect(json.questions.handling!.instructions).toEqual({
    task: "Recommend a handling path.",
    read: ["`student_message`"],
  });
  expect(json.questions.handling!.criteria).toHaveProperty("review", null);
  expect(json.questions.targeted_insult!.criteria).not.toHaveProperty("false");

  await page.getByTestId("request-view-form").click();
  await expect(handling.getByTestId("question-instructions-kind")).toHaveValue("json");
  await expect(handling.getByTestId("question-instructions")).toHaveValue(/"task": "Recommend/);
  await expect(handling.getByTestId("option-description-kind").nth(3)).toHaveValue("null");
  await expect(insult.getByTestId("noul-false-kind")).toHaveValue("absent");
  await expect(insult.getByTestId("noul-true")).toHaveValue(/direct personal attack/);
});

test("reports duplicate ids and options without losing a row, and blocks submission", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("mode-live").click();

  const handlingId = rows(page).nth(2).getByTestId("question-id-input");
  await handlingId.fill("targeted_insult");
  await expect(page.getByTestId("request-errors")).toContainText(
    '"targeted_insult" appears more than once',
  );
  await expect(rows(page)).toHaveCount(3);
  await expect(handlingId).toHaveAttribute("aria-invalid", "true");
  await expect(submitButton(page, "live")).toBeDisabled();
  // A map cannot hold both, so the JSON view will not open and drop one.
  await expect(page.getByTestId("request-view-json")).toBeDisabled();
  await expect(page.getByTestId("json-view-blocked")).toBeVisible();

  await handlingId.fill("handling");
  await expect(page.getByTestId("request-errors")).toHaveCount(0);

  const handling = questionRow(page, "handling");
  await handling.getByTestId("option-name").nth(1).fill("allow");
  await expect(page.getByTestId("request-errors")).toContainText(
    'the option "allow" appears more than once',
  );
  await expect(handling.getByTestId("choice-option")).toHaveCount(4);
});

test("empty rows and invalid Score or Choice shapes disable submission", async ({ page }) => {
  await open(page);
  await page.getByTestId("mode-live").click();

  await page.getByTestId("add-question").click();
  await expect(page.getByTestId("request-errors")).toContainText(
    "question_4.instructions: must not be empty",
  );
  await expect(submitButton(page, "live")).toBeDisabled();
  await rows(page).last().getByTestId("remove-question").click();
  await expect(page.getByTestId("request-errors")).toHaveCount(0);

  const handling = questionRow(page, "handling");
  for (let index = 0; index < 3; index += 1) {
    await handling.getByTestId("remove-option").first().click();
  }
  await expect(page.getByTestId("request-errors")).toContainText("at least 2 options");
  await expect(submitButton(page, "live")).toBeDisabled();

  await handling.getByTestId("question-type").selectOption("score");
  await expect(page.getByTestId("request-errors")).toContainText("must not be empty");
  await handling.getByTestId("remove-level").first().click();
  await expect(page.getByTestId("request-errors")).toContainText("at least 2 levels");
  await expect(submitButton(page, "live")).toBeDisabled();
});

/* ---------------------------------------------------- Whole-request JSON -- */

test("invalid whole-request JSON survives view and scenario switches until Reset", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("request-view-json").click();
  const editor = page.getByTestId("request-json-editor");
  const broken = '{ "state": "hello", "questions": { "q": ';
  await editor.fill(broken);
  await expect(page.getByTestId("request-errors")).toContainText("not valid JSON");
  await expect(submitButton(page, "fixture")).toBeDisabled();

  // To the Form: locked, never silently replaced by the last valid Form.
  await page.getByTestId("request-view-form").click();
  await expect(page.getByTestId("form-locked")).toBeVisible();
  await expect(page.getByTestId("question-row")).toHaveCount(0);
  await expect(page.getByTestId("sample-allow-idiom")).toBeDisabled();

  // To another scenario and back.
  await page.getByTestId("scenario-municipal").click();
  await expect(page.getByTestId("form-locked")).toHaveCount(0);
  await expect(page.getByTestId("question-count")).toContainText("Questions (2");
  await page.getByTestId("scenario-safety").click();
  await expect(page.getByTestId("form-locked")).toBeVisible();

  await page.getByTestId("return-to-json").click();
  await expect(editor).toHaveValue(broken);

  // Only an explicit Reset discards it.
  await page.getByTestId("reset-preset").click();
  await expect(page.getByTestId("request-view-form")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("question-count")).toContainText("Questions (3");
  await expect(page.getByTestId("request-errors")).toHaveCount(0);
  await expect(submitButton(page, "fixture")).toBeEnabled();
});

test("rejects duplicate question ids and option keys typed as JSON, keeping the text", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("request-view-json").click();
  const editor = page.getByTestId("request-json-editor");
  const duplicate = JSON.stringify({ state: "hi", questions: {} }).replace(
    '"questions":{}',
    '"questions":{"q":{"type":"noul","instructions":"A?"},"q":{"type":"noul","instructions":"B?"}}',
  );
  await editor.fill(duplicate);
  await expect(page.getByTestId("request-errors")).toContainText(
    'question id "q" appears more than once',
  );
  await expect(editor).toHaveValue(duplicate);
  await expect(submitButton(page, "fixture")).toBeDisabled();

  const duplicateOption =
    '{"state":"hi","questions":{"p":{"type":"choice","instructions":"Pick",' +
    '"criteria":{"a":null,"b":null,"a":"again"}}}}';
  await editor.fill(duplicateOption);
  await expect(page.getByTestId("request-errors")).toContainText(
    'the option "a" appears more than once',
  );
  await expect(editor).toHaveValue(duplicateOption);
});

test("a valid JSON edit carries over to the Form", async ({ page }) => {
  await open(page);
  await page.getByTestId("request-view-json").click();
  const editor = page.getByTestId("request-json-editor");
  const request = JSON.parse(await editor.inputValue()) as {
    state: unknown;
    questions: Record<string, unknown>;
  };
  const edited = {
    state: request.state,
    questions: {
      next_step: request.questions.handling,
      clarity: {
        type: "score",
        instructions: "How clear is it?",
        criteria: ["Unclear", "Clear"],
      },
    },
  };
  await editor.fill(JSON.stringify(edited, null, 2));
  await expect(page.getByTestId("request-errors")).toHaveCount(0);

  await page.getByTestId("request-view-form").click();
  await expect(page.getByTestId("question-count")).toContainText("Questions (2");
  await expect(questionRow(page, "next_step").getByTestId("option-name")).toHaveCount(4);
  await expect(questionRow(page, "clarity").getByTestId("score-level").nth(1)).toHaveValue(
    "Clear",
  );
});

/* -------------------------------------------------------------- State -- */

test("switches State between JSON and Text reversibly, and warns about named fields", async ({
  page,
}) => {
  await open(page);
  const editor = page.getByTestId("state-editor");
  const source = await editor.inputValue();

  // JSON → Text: the JSON source becomes the literal text, explicitly.
  await page.getByTestId("state-mode-text").click();
  await expect(editor).toHaveValue(source);
  await expect(page.getByTestId("state-mode-note")).toContainText("converted from the JSON source");
  await expect(page.getByTestId("request-warnings")).toContainText("plain text");

  // Unedited, it comes back exactly.
  await page.getByTestId("state-mode-json").click();
  await expect(editor).toHaveValue(source);
  await expect(page.getByTestId("request-warnings")).toHaveCount(0);

  // Edited text becomes a JSON string — not re-read as structure, not lost.
  await page.getByTestId("state-mode-text").click();
  await editor.fill("  Is this essay any good?  ");
  await expect(page.getByTestId("state-mode-note")).toContainText("turns this edited text into a JSON string");
  await page.getByTestId("state-mode-json").click();
  await expect(editor).toHaveValue('"  Is this essay any good?  "');

  // Text State is a valid request, sent verbatim.
  await page.getByTestId("request-view-json").click();
  const request = JSON.parse(await page.getByTestId("request-json-editor").inputValue()) as {
    state: unknown;
  };
  expect(request.state).toBe("  Is this essay any good?  ");
});

test("samples replace State only, and each scenario keeps its own draft", async ({ page }) => {
  await open(page);
  await questionRow(page, "targeted_insult").getByTestId("remove-question").click();
  await expect(page.getByTestId("question-count")).toContainText("Questions (2");

  // All nine safety samples load and keep the edited questions.
  const samples = page.locator('button[data-testid^="sample-"]');
  await expect(samples).toHaveCount(9);
  for (const sample of await samples.all()) {
    await sample.click();
    await expect(sample).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("question-count")).toContainText("Questions (2");
  }
  await page.getByTestId("sample-allow-idiom").click();
  await expect(page.getByTestId("state-editor")).toHaveValue(/homework is killing me/);

  // The municipal draft is untouched, and its three samples load too.
  await page.getByTestId("scenario-municipal").click();
  await expect(page.getByTestId("question-count")).toContainText("Questions (2");
  await expect(questionRow(page, "primary_agency")).toBeVisible();
  for (const sample of await samples.all()) {
    await sample.click();
    await expect(sample).toHaveAttribute("aria-pressed", "true");
  }
  await questionRow(page, "disposition").getByTestId("question-instructions").fill("Edited.");

  await page.getByTestId("scenario-safety").click();
  await expect(questionRow(page, "targeted_insult")).toHaveCount(0);
  await expect(page.getByTestId("state-editor")).toHaveValue(/homework is killing me/);

  await page.getByTestId("scenario-municipal").click();
  await expect(questionRow(page, "disposition").getByTestId("question-instructions")).toHaveValue(
    "Edited.",
  );
});

/* ------------------------------------------------------------ Fixtures -- */

test("Preview fixture is unavailable for edited questions and returns when they are restored", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("composed-outcome")).toBeVisible();

  // Editing only a question marks the result stale and removes the fixture.
  const instructions = questionRow(page, "handling").getByTestId("question-instructions");
  await instructions.fill(`${HANDLING_INSTRUCTIONS} Be brief.`);
  await expect(page.getByTestId("stale-warning")).toBeVisible();
  await expect(page.getByTestId("fixture-unavailable")).toContainText("No fixture exists");
  await expect(submitButton(page, "fixture")).toBeDisabled();
  // The old fixture stays, under its own snapshot, not relabelled.
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("snapshot-json")).not.toContainText("Be brief.");
  await page.getByTestId("view-cards").click();

  // The shortcut obeys the same guard.
  await page.getByTestId("state-editor").focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("fixture-kind")).toContainText("Sample fixture");

  // Live stays available and keeps the edit.
  await page.getByTestId("mode-live").click();
  await expect(instructions).toHaveValue(/Be brief\.$/);
  await page.getByTestId("mode-fixture").click();

  // Restoring the default wording restores the fixture and clears staleness.
  await instructions.fill(HANDLING_INSTRUCTIONS);
  await expect(page.getByTestId("fixture-unavailable")).toHaveCount(0);
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);
  await expect(submitButton(page, "fixture")).toBeEnabled();
});

/* ---------------------------------------------------------- Live, mocked -- */

test("sends the edited request and renders a custom Score answer from the snapshot", async ({
  page,
}, testInfo) => {
  const evaluate = await goLive(page);
  await addScoreQuestion(page);
  await submitButton(page, "live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  expect(evaluate.requests).toHaveLength(1);
  const sent = evaluate.requests[0]!;
  expect(Object.keys(sent).sort()).toEqual(["questions", "scenarioId", "state"]);
  expect((sent.questions as Record<string, unknown>).clarity).toEqual({
    type: "score",
    instructions: "How clear is `student_message`?",
    criteria: ["Unclear", "Mostly clear", "Perfectly clear"],
  });

  // The request is no longer the preset's, so no preset composition applies.
  await expect(page.getByTestId("custom-composition-note")).toContainText(
    "Custom questions — preset composition not applied.",
  );
  await expect(page.getByTestId("composed-outcome")).toHaveCount(0);
  // Raw answers keep the submitted order and plain option keys.
  const cards = page.locator('[data-testid^="answer-"]');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(3)).toHaveAttribute("data-testid", "answer-clarity");
  const clarity = page.getByTestId("answer-clarity");
  await expect(clarity).toContainText("Score:");
  await expect(clarity).toContainText("0 — Unclear");
  await expect(clarity).toContainText("2 — Perfectly clear");
  await expect(clarity).toContainText("75.0%");
  // Preset plain-language labels are not applied to an edited request.
  const selfHarm = page.getByTestId("answer-self_harm_context");
  await expect(selfHarm).toContainText("Selected option: none");
  await expect(selfHarm).not.toContainText("No self-harm signal");

  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-editor-custom-score.png`,
    fullPage: true,
  });

  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("snapshot-json")).toContainText("Perfectly clear");
  await expect(page.getByTestId("response-json")).toContainText('"clarity"');
});

test("an edited Noul label suppresses composition even though every id matches the preset", async ({
  page,
}) => {
  const evaluate = await goLive(page);
  const yes = questionRow(page, "targeted_insult").getByTestId("noul-true");
  await yes.fill("The student is being rude to a teacher.");
  await submitButton(page, "live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  expect(
    (evaluate.requests[0]!.questions as Record<string, { criteria: { true: string } }>)
      .targeted_insult!.criteria.true,
  ).toBe("The student is being rude to a teacher.");
  await expect(page.getByTestId("custom-composition-note")).toBeVisible();
  await expect(page.getByTestId("safety-recommendation")).toHaveCount(0);
  const card = page.getByTestId("answer-targeted_insult");
  await expect(card).toContainText("the answer to this yes/no question is yes");
  await expect(card).toContainText("Yes means (as submitted): The student is being rude to a teacher.");
  await expect(card).not.toContainText("personal insult or targeted abuse");

  // Reset restores the default questions, and with them the composition.
  await page.getByTestId("reset-preset").click();
  await expect(page.getByTestId("stale-warning")).toBeVisible();
  await submitButton(page, "live").click();
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);
  await expect(page.getByTestId("composed-outcome")).toBeVisible();
  await expect(page.getByTestId("custom-composition-note")).toHaveCount(0);
  expect(evaluate.requests).toHaveLength(2);
});

test("editing only the questions marks a live result stale", async ({ page }) => {
  await goLive(page);
  await submitButton(page, "live").click();
  await expect(page.getByTestId("composed-outcome")).toBeVisible();

  await questionRow(page, "handling").getByTestId("option-name").nth(3).fill("escalate");
  await expect(page.getByTestId("stale-warning")).toContainText("State or questions");
  // The result keeps its own snapshot and its eligible composition.
  await expect(page.getByTestId("composed-outcome")).toBeVisible();
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("snapshot-json")).toContainText('"review"');
  await expect(page.getByTestId("snapshot-json")).not.toContainText("escalate");
});

test("a delayed response after a question edit stays bound to what was sent", async ({
  page,
}) => {
  const evaluate = await goLive(page, { delay: true });
  await submitButton(page, "live").click();
  await expect(page.getByTestId("response-loading")).toBeVisible();

  // Rewrite the questions while the call is in flight.
  await questionRow(page, "targeted_insult").getByTestId("remove-question").click();
  await addScoreQuestion(page);
  evaluate.release();

  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toBeVisible();
  // Composition is decided from the snapshot (the default questions), not the
  // editor (custom questions), and the answers are the ones that were asked.
  await expect(page.getByTestId("composed-outcome")).toBeVisible();
  await expect(page.getByTestId("answer-targeted_insult")).toBeVisible();
  await expect(page.getByTestId("answer-clarity")).toHaveCount(0);
});

test("a delayed custom-question response after a scenario switch stays with its scenario", async ({
  page,
}) => {
  const evaluate = await goLive(page, { delay: true });
  await addScoreQuestion(page);
  await submitButton(page, "live").click();
  await expect(page.getByTestId("response-loading")).toBeVisible();

  await page.getByTestId("scenario-municipal").click();
  const landed = page.waitForResponse("**/api/evaluate");
  evaluate.release();
  await landed;
  await page.waitForTimeout(250);
  await expect(page.getByTestId("answer-clarity")).toHaveCount(0);
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  await expect(page.getByTestId("response-empty")).toBeVisible();

  await page.getByTestId("scenario-safety").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("answer-clarity")).toBeVisible();
  await expect(page.getByTestId("custom-composition-note")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);
});

/* ------------------------------------------------------------ Keyboard -- */

test("Cmd/Ctrl+Enter submits once, and not while invalid or pending", async ({ page }) => {
  const evaluate = await goLive(page, { delay: true });
  const editor = page.getByTestId("state-editor");

  // Invalid: nothing is sent.
  const original = await editor.inputValue();
  await editor.fill("null");
  await editor.press("ControlOrMeta+Enter");
  await page.waitForTimeout(200);
  expect(evaluate.requests).toHaveLength(0);
  await editor.fill(original);

  // Valid: one request, however often the shortcut is pressed while pending.
  await editor.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("response-loading")).toBeVisible();
  await expect(submitButton(page, "live")).toBeDisabled();
  await editor.press("ControlOrMeta+Enter");
  await page.keyboard.press("ControlOrMeta+Enter");
  // The shortcut does not insert a newline into the editor.
  await expect(editor).toHaveValue(original);

  evaluate.release();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await page.waitForTimeout(200);
  expect(evaluate.requests).toHaveLength(1);

  // Switching mode, view, sample, and scenario never sends anything.
  await page.getByTestId("request-view-json").click();
  await page.getByTestId("request-view-form").click();
  await page.getByTestId("sample-allow-idiom").click();
  await page.getByTestId("scenario-municipal").click();
  await page.getByTestId("mode-fixture").click();
  await page.getByTestId("reset-preset").click();
  expect(evaluate.requests).toHaveLength(1);
});

test("Cmd/Ctrl+Enter previews the fixture in Fixture mode", async ({ page }) => {
  await open(page);
  await page.getByTestId("state-editor").press("ControlOrMeta+Enter");
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
});

/* -------------------------------------------------------------- Layout -- */

test("lays out the editor without horizontal overflow and saves screenshots", async ({
  page,
}, testInfo) => {
  await open(page);
  await addScoreQuestion(page);
  const handling = questionRow(page, "handling");
  await handling.getByTestId("question-instructions-kind").selectOption("json");
  // The prose is now read as JSON, which it is not: reported inline, kept as
  // typed, and the JSON view stays closed until it is fixed.
  await expect(handling.getByText("is not valid JSON")).toBeVisible();
  await expect(page.getByTestId("request-view-json")).toBeDisabled();
  await handling
    .getByTestId("question-instructions")
    .fill('{ "task": "Recommend a handling path.", "policy": "See the options." }');
  await expect(page.getByTestId("request-view-json")).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-editor-form.png`,
    fullPage: true,
  });

  await page.getByTestId("request-view-json").click();
  await page.getByTestId("request-json-editor").fill('{ "state": "x", ');
  await expect(page.getByTestId("request-errors")).toBeVisible();
  await expect(page.getByTestId("request-view-json")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("request-view-form")).toHaveAttribute("aria-pressed", "false");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-editor-json-invalid.png`,
    fullPage: true,
  });

  await page.getByTestId("request-view-form").click();
  await expect(page.getByTestId("form-locked")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Every form control has an accessible name.
  await page.getByTestId("locked-reset").click();
  for (const control of await page.locator("textarea, input, select").all()) {
    const name = await control.evaluate((element) => {
      const labelled = (element as HTMLInputElement).labels;
      return (
        element.getAttribute("aria-label") ??
        (labelled && labelled.length > 0 ? labelled[0]!.textContent : "") ??
        ""
      ).trim();
    });
    expect(name.length, await control.getAttribute("data-testid") ?? "control").toBeGreaterThan(0);
  }
});

/* ------------------------------------------- JEV-07 card compatibility -- */

/**
 * The State section and the separate question cards are presentation only:
 * editing State and two different cards still yields exactly one request with
 * the exact `{ state, questions }` on screen, and the answers rendered belong
 * to that snapshot. Checked for both presets.
 */
for (const scenarioId of ["safety", "municipal"] as const) {
  test(`${scenarioId}: State and two question cards are submitted together as one exact request`, async ({
    page,
  }) => {
    const scenario = getScenario(scenarioId);
    const evaluate = await goLive(page);
    await page.getByTestId(`scenario-${scenarioId}`).click();
    await expect(page.getByTestId(`scenario-${scenarioId}`)).toHaveAttribute("aria-current", "true");

    // Samples, view switches and edits alone never evaluate.
    const otherSample = scenario.samples.find((sample) => sample.id !== scenario.defaultSampleId)!;
    await page.getByTestId(`sample-${otherSample.id}`).click();
    await page.getByTestId("request-view-json").click();
    await page.getByTestId("request-view-form").click();
    await page.getByTestId(`sample-${scenario.defaultSampleId}`).click();

    // Edit State.
    const stateEditor = page.getByTestId("state-editor");
    const state = JSON.parse(await stateEditor.inputValue()) as Record<string, unknown>;
    const field = scenarioId === "safety" ? "student_message" : "feedback";
    state[field] = `Edited ${scenarioId} State for the card check.`;
    await stateEditor.fill(JSON.stringify(state, null, 2));

    // Edit two separate question cards, including their criteria.
    const expected = structuredClone(scenario.questions) as Record<
      string,
      { type: string; instructions: unknown; criteria?: Record<string, unknown> }
    >;
    const [firstId, secondId] = scenario.questionOrder as [string, string];
    const first = questionRow(page, firstId);
    const firstOption = Object.keys(expected[firstId]!.criteria!)[0]!;
    await first.getByTestId("option-description").nth(0).fill("Edited first-card description.");
    expected[firstId]!.criteria![firstOption] = "Edited first-card description.";

    const second = questionRow(page, secondId);
    await second.getByTestId("question-instructions").fill("Edited second-card instructions.");
    expected[secondId]!.instructions = "Edited second-card instructions.";
    if (expected[secondId]!.type === "noul") {
      await second.getByTestId("noul-true").fill("Edited true meaning.");
      expected[secondId]!.criteria!.true = "Edited true meaning.";
    } else {
      const secondOption = Object.keys(expected[secondId]!.criteria!)[0]!;
      await second.getByTestId("option-description").nth(0).fill("Edited second-card description.");
      expected[secondId]!.criteria![secondOption] = "Edited second-card description.";
    }

    await page.waitForTimeout(200);
    expect(evaluate.requests, "editing must not evaluate").toHaveLength(0);

    // One submit, one request, exactly what is on screen.
    await submitButton(page, "live").click();
    await expect(page.getByTestId("live-badge")).toBeVisible();
    await page.waitForTimeout(200);
    expect(evaluate.requests).toHaveLength(1);
    expect(evaluate.requests[0]).toEqual({ scenarioId, state, questions: expected });

    // The rendered answers are the answers to that snapshot, not stale.
    await expect(page.getByTestId("stale-warning")).toHaveCount(0);
    await expect(page.locator('[data-testid^="answer-"]')).toHaveCount(scenario.questionOrder.length);
    for (const id of scenario.questionOrder) {
      await expect(page.getByTestId(`answer-${id}`)).toBeVisible();
    }
    await page.getByTestId("view-json").click();
    await expect(page.getByTestId("snapshot-json")).toContainText("Edited first-card description.");
    await expect(page.getByTestId("snapshot-json")).toContainText(`Edited ${scenarioId} State`);
  });
}

test("keyboard alone selects a scenario, switches views, edits and submits", async ({ page }) => {
  const evaluate = await goLive(page);

  // Scenario cards are real buttons: focus and activate with the keyboard.
  await page.getByTestId("scenario-municipal").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("scenario-municipal")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("scenario-safety").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("scenario-safety")).toHaveAttribute("aria-current", "true");

  // Form ↔ JSON with the keyboard.
  await page.getByTestId("request-view-json").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("request-json-editor")).toBeVisible();
  await page.getByTestId("request-view-form").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("state-editor")).toBeVisible();

  // Edit a question card's id by typing, then submit from the keyboard.
  const idInput = questionRow(page, "handling").getByTestId("question-id-input");
  await idInput.focus();
  await page.keyboard.press("End");
  await page.keyboard.type("_path");
  await expect(questionRow(page, "handling_path")).toBeVisible();
  expect(evaluate.requests).toHaveLength(0);

  await submitButton(page, "live").focus();
  await expect(submitButton(page, "live")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("live-badge")).toBeVisible();
  expect(evaluate.requests).toHaveLength(1);
  expect(Object.keys(evaluate.requests[0]!.questions as object)).toContain("handling_path");
});

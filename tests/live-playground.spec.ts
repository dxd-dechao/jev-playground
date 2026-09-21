/**
 * Browser tests for Live mode — AGAINST MOCKED RESPONSES ONLY.
 *
 * ================================================================
 * TEST EVIDENCE, NOT PROVIDER VERIFICATION
 * ----------------------------------------------------------------
 * Every `/api/config` and `/api/evaluate` response in this file is fabricated
 * by `page.route`. No request reaches TypeSafe, no model runs, and nothing is
 * billed. A passing run shows the UI handles live-shaped responses correctly.
 * It is NOT evidence that the integration works against the real service, and
 * says nothing about answer quality. Each test is annotated so this appears in
 * the HTML report rather than only in this comment.
 *
 * The Playwright web server is started with an empty `TYPESAFE_API_KEY`
 * (see `playwright.config.ts`), so even an unmocked request could only produce
 * a 503 — never a paid call.
 * ================================================================
 */

import { expect, test, type Page, type Route } from "@playwright/test";

/** Recorded in the report so a reader cannot mistake these for real calls. */
const MOCKED = {
  type: "evidence",
  description:
    "Mocked /api/config and /api/evaluate responses. No real provider call was made; this is not provider verification.",
} as const;

test.beforeEach(() => {
  test.info().annotations.push(MOCKED);
});

const SAFETY_ANSWERS = {
  self_harm_context: {
    type: "choice",
    choice: "contextual",
    probabilities: {
      none: 0.04,
      contextual: 0.86,
      support_needed: 0.06,
      urgent_support: 0.02,
      harmful_request: 0.02,
    },
    confidence: 0.81,
  },
  targeted_insult: { type: "noul", noul: 0.03 },
  handling: {
    type: "choice",
    choice: "allow",
    probabilities: { allow: 0.88, support: 0.06, redirect: 0.03, review: 0.03 },
    confidence: 0.79,
  },
};

const MUNICIPAL_ANSWERS = {
  primary_agency: {
    type: "choice",
    choice: "LTA",
    probabilities: { LTA: 0.91, NEA: 0.03, PUB: 0.03, HDB: 0.02, Unclear: 0.01 },
    confidence: 0.84,
  },
  disposition: {
    type: "choice",
    choice: "routable",
    probabilities: {
      routable: 0.9,
      needs_clarification: 0.04,
      outside_scope: 0.02,
      non_actionable: 0.02,
      human_review: 0.02,
    },
    confidence: 0.8,
  },
};

function livePayload(
  answers: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "live",
    requestedModel: "jev-latest",
    response: {
      model: "jev-1-mocked",
      answers,
      usage: { input_tokens: 734, output_tokens: 58 },
    },
    durationMs: 1287,
    ...overrides,
  };
}

/** Mock the configuration check. Nothing here touches a real key. */
async function mockConfig(page: Page, configured: boolean | "fail") {
  await page.route("**/api/config", async (route) => {
    if (configured === "fail") {
      await route.fulfill({ status: 500, body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured }),
    });
  });
}

interface EvaluateMock {
  /** Bodies the page sent, so tests can assert one call per press. */
  requests: Array<Record<string, unknown>>;
  /** Releases a deliberately delayed response. */
  release: () => void;
}

/**
 * Mock the evaluation endpoint.
 *
 * `delay: true` holds the response until `release()` is called, which is how the
 * late-arrival tests reproduce a response landing after the user has moved on.
 */
async function mockEvaluate(
  page: Page,
  respond: (body: Record<string, unknown>) => { status: number; json: unknown },
  options: { delay?: boolean } = {},
): Promise<EvaluateMock> {
  const requests: Array<Record<string, unknown>> = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/api/evaluate", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    requests.push(body);
    if (options.delay) await gate;
    const { status, json } = respond(body);
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(json),
    });
  });

  return { requests, release };
}

/**
 * The value cell of one measurement row.
 *
 * Asserting on the whole block is too weak for token counts: "Unavailable" is
 * always present there because Cost is always unavailable, so a block-level
 * check would pass even if a count rendered a fabricated `0`.
 */
function measurementValue(page: Page, field: string) {
  return page
    .getByTestId("measurement-block")
    .locator("div")
    .filter({ has: page.locator(`dt:text-is("${field}")`) })
    .locator("dd");
}

async function goLive(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Jev playground" })).toBeVisible();
  await page.getByTestId("mode-live").click();
}

test("shows a configured server and enables Evaluate with Jev", async ({ page }) => {
  await mockConfig(page, true);
  await goLive(page);

  await expect(page.getByTestId("config-status")).toHaveAttribute(
    "data-status",
    "configured",
  );
  // Configured is not verified, and the UI must say so.
  await expect(page.getByTestId("config-status")).toContainText("not that it is valid");
  await expect(page.getByTestId("config-recheck")).toHaveCount(0);
  await expect(page.getByTestId("evaluate-live")).toBeEnabled();
  await expect(page.getByTestId("response-empty")).toContainText("No live result yet");
});

test("disables Live and keeps Fixture usable when no key is configured", async ({
  page,
}) => {
  await mockConfig(page, false);
  await goLive(page);

  await expect(page.getByTestId("config-status")).toHaveAttribute(
    "data-status",
    "missing",
  );
  await expect(page.getByTestId("config-status")).toContainText("TYPESAFE_API_KEY");
  await expect(page.getByTestId("evaluate-live")).toBeDisabled();

  // No key fragment, length, or account detail is disclosed.
  const text = await page.getByTestId("config-status").innerText();
  expect(text).not.toMatch(/sk-/);

  // Fixture mode is unaffected.
  await page.getByTestId("mode-fixture").click();
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
});

test("keeps Fixture usable when the configuration check itself fails", async ({
  page,
}) => {
  await mockConfig(page, "fail");
  await goLive(page);

  await expect(page.getByTestId("config-status")).toHaveAttribute(
    "data-status",
    "unavailable",
  );
  await expect(page.getByTestId("evaluate-live")).toBeDisabled();

  await page.getByTestId("mode-fixture").click();
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("result-source")).toHaveText("Source: fixture");
});

test("re-checking configuration does not evaluate anything", async ({ page }) => {
  await mockConfig(page, false);
  const evaluate = await mockEvaluate(page, () => ({
    status: 200,
    json: livePayload(SAFETY_ANSWERS),
  }));
  await goLive(page);

  const rechecked = page.waitForResponse("**/api/config");
  await page.getByTestId("config-recheck").click();
  await rechecked;

  await expect(page.getByTestId("config-status")).toHaveAttribute(
    "data-status",
    "missing",
  );
  // Asking about configuration is not asking for an evaluation.
  expect(evaluate.requests).toEqual([]);
});

test("renders a successful live result with its real measurements", async ({
  page,
}, testInfo) => {
  await mockConfig(page, true);
  const evaluate = await mockEvaluate(page, () => ({
    status: 200,
    json: livePayload(SAFETY_ANSWERS),
  }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  // Exactly one call for one press, carrying only the two allowed fields.
  expect(evaluate.requests.length).toBe(1);
  expect(Object.keys(evaluate.requests[0]!).sort()).toEqual(["scenarioId", "state"]);
  expect(evaluate.requests[0]!.scenarioId).toBe("safety");

  await expect(page.getByTestId("result-source")).toHaveText("Source: live");
  await expect(page.getByTestId("fixture-badge")).toHaveCount(0);
  await expect(page.getByTestId("live-badge")).toContainText("real model call");

  // The same renderers and composition rules as a fixture.
  await expect(page.getByTestId("composed-outcome")).toContainText(
    "Composed by application code",
  );
  await expect(page.getByTestId("safety-recommendation")).toHaveText("Allow");
  const card = page.getByTestId("answer-self_harm_context");
  await expect(card).toContainText("Contextual reference");
  await expect(card).toContainText("86.0%");

  // Measurements: real ones shown, cost unavailable because none is documented.
  const measurement = page.getByTestId("measurement-block");
  await expect(measurement).toContainText("jev-latest");
  await expect(measurement).toContainText("jev-1-mocked");
  await expect(measurement).toContainText("734");
  await expect(measurement).toContainText("58");
  await expect(measurement).toContainText("1287 ms");
  await expect(measurement).toContainText("Unavailable");

  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("result-source")).toHaveText("Source: live");
  const json = await page.getByTestId("response-json").innerText();
  expect(json).toContain('"model": "jev-1-mocked"');
  expect(json).toContain('"input_tokens": 734');
  await expect(page.getByTestId("json-measurement")).toContainText("Cost");

  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-mocked-live-cards.png`,
    fullPage: true,
  });
});

test("renders a live result whose response omitted usage and confidence", async ({
  page,
}) => {
  await mockConfig(page, true);
  const answers = JSON.parse(JSON.stringify(SAFETY_ANSWERS)) as Record<
    string,
    Record<string, unknown>
  >;
  delete answers.self_harm_context!.confidence;
  delete answers.handling!.confidence;

  await mockEvaluate(page, () => ({
    status: 200,
    json: livePayload(answers, {
      response: { model: "jev-1-mocked", answers },
    }),
  }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  // Missing optional metadata renders as Unavailable, and nothing crashes.
  await expect(page.getByTestId("answer-self_harm_context")).toContainText(
    "Unavailable",
  );
  await expect(measurementValue(page, "Input tokens")).toHaveText("Unavailable");
  await expect(measurementValue(page, "Output tokens")).toHaveText("Unavailable");
  await expect(page.getByTestId("safety-recommendation")).toHaveText("Allow");
});

test("shows a reported token count beside Unavailable for the one not reported", async ({
  page,
}) => {
  await mockConfig(page, true);
  await mockEvaluate(page, () => ({
    status: 200,
    json: livePayload(SAFETY_ANSWERS, {
      response: {
        model: "jev-1-mocked",
        answers: SAFETY_ANSWERS,
        // Only one counter reported, which is a shape the API permits.
        usage: { input_tokens: 512 },
      },
    }),
  }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  // The real number is kept, and the absent one says so rather than showing 0.
  await expect(measurementValue(page, "Input tokens")).toHaveText("512");
  await expect(measurementValue(page, "Output tokens")).toHaveText("Unavailable");

  // The JSON view must agree: no fabricated counter appears there either.
  await page.getByTestId("view-json").click();
  const json = await page.getByTestId("response-json").innerText();
  expect(json).toContain('"input_tokens": 512');
  expect(json).not.toContain("output_tokens");
});

test("shows a genuinely reported zero as zero, not as Unavailable", async ({ page }) => {
  await mockConfig(page, true);
  await mockEvaluate(page, () => ({
    status: 200,
    json: livePayload(SAFETY_ANSWERS, {
      response: {
        model: "jev-1-mocked",
        answers: SAFETY_ANSWERS,
        usage: { input_tokens: 640, output_tokens: 0 },
      },
    }),
  }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  // A reported zero is a measurement and must survive the rendering path.
  await expect(measurementValue(page, "Output tokens")).toHaveText("0");
  await expect(measurementValue(page, "Input tokens")).toHaveText("640");
});

test("shows a loading state and refuses a second click while one call is in flight", async ({
  page,
}) => {
  await mockConfig(page, true);
  const evaluate = await mockEvaluate(
    page,
    () => ({ status: 200, json: livePayload(SAFETY_ANSWERS) }),
    { delay: true },
  );
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("response-loading")).toBeVisible();
  await expect(page.getByTestId("response-loading")).toContainText(
    "will not be retried",
  );

  const button = page.getByTestId("evaluate-live");
  await expect(button).toBeDisabled();
  await expect(button).toContainText("Evaluating with Jev…");
  // Force past the disabled attribute: a second call must be impossible, not
  // merely discouraged by styling.
  await button.click({ force: true, timeout: 2000 }).catch(() => {});
  await button.dispatchEvent("click");

  evaluate.release();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("response-loading")).toHaveCount(0);
  expect(
    evaluate.requests.length,
    "one press must mean one request, whatever the user clicks",
  ).toBe(1);
});

test("shows an actionable live failure and never substitutes a fixture", async ({
  page,
}, testInfo) => {
  await mockConfig(page, true);
  await mockEvaluate(page, () => ({
    status: 502,
    json: {
      error: {
        code: "upstream_auth",
        message:
          "TypeSafe rejected the server's credentials. Check TYPESAFE_API_KEY on the server; the key itself is never shown here.",
      },
    },
  }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-error")).toBeVisible();
  await expect(page.getByTestId("live-error-code")).toHaveText("upstream_auth");
  await expect(page.getByTestId("live-error")).toContainText("TYPESAFE_API_KEY");
  await expect(page.getByTestId("live-error")).toContainText(
    "No fixture was substituted",
  );

  // A failure has no answers. Nothing hand-written appears in their place.
  await expect(page.getByTestId("fixture-badge")).toHaveCount(0);
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  await expect(page.getByTestId("composed-outcome")).toHaveCount(0);
  await expect(page.getByTestId("measurement-block")).toHaveCount(0);
  await expect(page.getByTestId("response-empty")).toBeVisible();

  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-mocked-live-error.png`,
    fullPage: true,
  });
});

test("keeps a live failure visible and keeps the earlier result under its own snapshot", async ({
  page,
}) => {
  await mockConfig(page, true);
  let fail = false;
  await mockEvaluate(page, () =>
    fail
      ? {
          status: 429,
          json: {
            error: {
              code: "upstream_rate_limit",
              message: "TypeSafe rate-limited this request. Nothing was retried.",
            },
          },
        }
      : { status: 200, json: livePayload(SAFETY_ANSWERS) },
  );
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  fail = true;
  const editor = page.getByTestId("state-editor");
  await editor.fill(
    (await editor.inputValue()).replace("this novel", "this second novel"),
  );
  await page.getByTestId("evaluate-live").click();

  // The failure is visible, and the kept result is marked as belonging to the
  // earlier request rather than to the State now in the editor.
  await expect(page.getByTestId("live-error-code")).toHaveText("upstream_rate_limit");
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toBeVisible();
});

test("marks a live result stale after an edit instead of reattaching it", async ({
  page,
}) => {
  await mockConfig(page, true);
  await mockEvaluate(page, () => ({ status: 200, json: livePayload(SAFETY_ANSWERS) }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toHaveCount(0);

  const editor = page.getByTestId("state-editor");
  await editor.fill(
    (await editor.inputValue()).replace("literature discussion", "literature seminar"),
  );

  await expect(page.getByTestId("stale-warning")).toBeVisible();
  await expect(page.getByTestId("stale-warning")).toContainText(
    "spend another call on the new State",
  );
  // The result itself is unchanged: it still belongs to what was submitted.
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("snapshot-json")).toContainText(
    "literature discussion",
  );
  await expect(page.getByTestId("snapshot-json")).not.toContainText(
    "literature seminar",
  );
});

test("a response arriving after a scenario switch never answers the new scenario", async ({
  page,
}) => {
  await mockConfig(page, true);
  const evaluate = await mockEvaluate(
    page,
    (body) => ({
      status: 200,
      json: livePayload(
        body.scenarioId === "safety" ? SAFETY_ANSWERS : MUNICIPAL_ANSWERS,
      ),
    }),
    { delay: true },
  );
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("response-loading")).toBeVisible();

  // Move to the other scenario while the safety call is still in flight.
  await page.getByTestId("scenario-municipal").click();
  await expect(page.getByTestId("response-empty")).toBeVisible();

  // Let it land, and give the page time to render it wherever it goes, so the
  // assertions below cannot pass merely because nothing has arrived yet.
  const landed = page.waitForResponse("**/api/evaluate");
  evaluate.release();
  await landed;
  await page.waitForTimeout(250);

  // The late safety answer must not appear here under municipal questions.
  await expect(page.getByTestId("answer-self_harm_context")).toHaveCount(0);
  await expect(page.getByTestId("safety-recommendation")).toHaveCount(0);
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  await expect(page.getByTestId("response-empty")).toBeVisible();

  // It is waiting where it belongs: under safety, in Live mode.
  await page.getByTestId("scenario-safety").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("safety-recommendation")).toHaveText("Allow");
});

test("a response arriving after an edit is kept as an answer to what was sent", async ({
  page,
}) => {
  await mockConfig(page, true);
  const evaluate = await mockEvaluate(
    page,
    () => ({ status: 200, json: livePayload(SAFETY_ANSWERS) }),
    { delay: true },
  );
  await goLive(page);

  const editor = page.getByTestId("state-editor");
  const submitted = await editor.inputValue();
  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("response-loading")).toBeVisible();

  // Edit while the call is in flight, then let it land.
  await editor.fill(submitted.replace("this novel", "this later novel"));
  evaluate.release();

  await expect(page.getByTestId("live-badge")).toBeVisible();
  // It is labelled as an answer to the earlier request, not to the new text.
  await expect(page.getByTestId("stale-warning")).toBeVisible();
  await page.getByTestId("view-json").click();
  await expect(page.getByTestId("snapshot-json")).not.toContainText(
    "this later novel",
  );
});

test("a response arriving after a mode switch cannot turn a fixture into a live result", async ({
  page,
}) => {
  await mockConfig(page, true);
  const evaluate = await mockEvaluate(
    page,
    () => ({ status: 200, json: livePayload(SAFETY_ANSWERS) }),
    { delay: true },
  );
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("response-loading")).toBeVisible();

  // Switch to Fixture and preview while the live call is in flight.
  await page.getByTestId("mode-fixture").click();
  await page.getByTestId("preview-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();

  const landed = page.waitForResponse("**/api/evaluate");
  evaluate.release();
  await landed;
  await page.waitForTimeout(250);

  // The fixture slot stays a fixture. The live answer does not overwrite it.
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("result-source")).toHaveText("Source: fixture");
  await expect(page.getByTestId("live-badge")).toHaveCount(0);
  await expect(page.getByTestId("measurement-block")).toContainText("Unavailable");

  // And switching back shows the live answer as live, in its own slot.
  await page.getByTestId("mode-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("result-source")).toHaveText("Source: live");

  // Switching back again still finds the fixture, unchanged.
  await page.getByTestId("mode-fixture").click();
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("result-source")).toHaveText("Source: fixture");
});

test("the municipal scenario works in Live mode too", async ({ page }, testInfo) => {
  await mockConfig(page, true);
  await mockEvaluate(page, () => ({ status: 200, json: livePayload(MUNICIPAL_ANSWERS) }));
  await goLive(page);

  await page.getByTestId("scenario-municipal").click();
  await page.getByTestId("evaluate-live").click();

  await expect(page.getByTestId("live-badge")).toBeVisible();
  await expect(page.getByTestId("municipal-status")).toHaveText("Recommended agency");
  await expect(page.getByTestId("municipal-agency")).toHaveText("LTA");
  await expect(page.getByTestId("answer-self_harm_context")).toHaveCount(0);
  await expect(page.getByTestId("composed-outcome")).toContainText(
    "Nothing is sent to any agency",
  );

  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-mocked-live-municipal.png`,
    fullPage: true,
  });
});

test("lays out a live result without horizontal overflow", async ({ page }) => {
  await mockConfig(page, true);
  await mockEvaluate(page, () => ({ status: 200, json: livePayload(SAFETY_ANSWERS) }));
  await goLive(page);

  await page.getByTestId("evaluate-live").click();
  await expect(page.getByTestId("live-badge")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`,
  ).toBeLessThanOrEqual(1);
});

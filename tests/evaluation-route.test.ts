/**
 * Route tests for `POST /api/evaluate` and `GET /api/config`.
 *
 * NO REAL CALLS, and more than that: the adapter is mocked, so these tests also
 * assert *when it is not reached at all*. Every rejection path — bad JSON, a
 * schema failure, an oversized body, a missing key — must be a free rejection,
 * never a paid one. `toHaveBeenCalledTimes(0)` is the point of half this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationErrorCode } from "@/lib/types";

const evaluateSystemOne = vi.fn();
const isConfigured = vi.fn();

vi.mock("@/lib/evaluation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/evaluation")>();
  return { ...actual, evaluateSystemOne, isConfigured };
});

// `MAX_BODY_BYTES` lives in the adapter module, not the route: a Next.js route
// may only export handler names, so the build rejects any extra export there.
const { EvaluationError, MAX_BODY_BYTES } = await import("@/lib/evaluation");
const { GET: configGet } = await import("@/app/api/config/route");
const { GET: evaluateGet, POST } = await import("@/app/api/evaluate/route");
const { getDefaultSample, getScenario } = await import("@/lib/scenarios");

/** Synthetic. Present so tests can prove no key value reaches a response. */
const FAKE_KEY = "sk-typesafe-FAKE-TEST-KEY-DO-NOT-USE";

const safety = getScenario("safety");
const safetyState = getDefaultSample(safety).state as Record<string, unknown>;

function post(body: string | ReadableStream, headers: Record<string, string> = {}) {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  };
  if (typeof body !== "string") init.duplex = "half";
  return new Request("http://localhost/api/evaluate", init as RequestInit);
}

function jsonPost(payload: unknown) {
  return post(JSON.stringify(payload));
}

const upstreamAnswers = {
  self_harm_context: {
    type: "choice",
    choice: "contextual",
    probabilities: {
      none: 0.1,
      contextual: 0.7,
      support_needed: 0.1,
      urgent_support: 0.05,
      harmful_request: 0.05,
    },
    confidence: 0.8,
  },
  targeted_insult: { type: "noul", noul: 0.02 },
  handling: {
    type: "choice",
    choice: "allow",
    probabilities: { allow: 0.85, support: 0.05, redirect: 0.05, review: 0.05 },
    confidence: 0.75,
  },
};

function goodOutcome(overrides: Record<string, unknown> = {}) {
  return {
    raw: {
      model: "jev-1-resolved",
      answers: upstreamAnswers,
      usage: { input_tokens: 700, output_tokens: 50 },
      ...overrides,
    },
    durationMs: 812.6,
    requestedModel: "jev-requested",
  };
}

beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", FAKE_KEY);
  isConfigured.mockReturnValue(true);
  evaluateSystemOne.mockReset();
  // The route logs sanitized failures on purpose; keep test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  isConfigured.mockReset();
});

describe("rejections that must never reach the provider", () => {
  it("rejects a body that is not JSON", async () => {
    const response = await POST(post("{ not json"));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_request");
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("rejects an unknown scenario id", async () => {
    const response = await POST(
      jsonPost({ scenarioId: "medical_triage", state: safetyState }),
    );
    expect(response.status).toBe(400);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("rejects a body with no state", async () => {
    const response = await POST(jsonPost({ scenarioId: "safety" }));
    expect(response.status).toBe(400);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("rejects client-supplied questions, models, and credentials", async () => {
    for (const extra of [
      { questions: { anything: { type: "noul", instructions: "?" } } },
      { model: "some-other-model" },
      { baseURL: "https://attacker.example" },
      { apiKey: "sk-not-a-real-key" },
      { expected: "allow" },
    ]) {
      const response = await POST(
        jsonPost({ scenarioId: "safety", state: safetyState, ...extra }),
      );
      expect(response.status, Object.keys(extra)[0]).toBe(400);
    }
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("rejects a state that does not match the scenario schema", async () => {
    const response = await POST(
      jsonPost({ scenarioId: "safety", state: { student_message: 42 } }),
    );
    expect(response.status).toBe(400);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("rejects a state carrying an expected label", async () => {
    const response = await POST(
      jsonPost({
        scenarioId: "safety",
        state: { ...safetyState, expected_outcome: "allow" },
      }),
    );
    expect(response.status).toBe(400);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("rejects an oversized body with 413", async () => {
    const huge = {
      scenarioId: "safety",
      state: { ...safetyState, student_message: "x".repeat(MAX_BODY_BYTES + 1024) },
    };
    const response = await POST(jsonPost(huge));
    expect(response.status).toBe(413);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("payload_too_large");
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("enforces the byte cap while reading, not just from Content-Length", async () => {
    // A streamed body declares no length at all, so only a running byte count
    // can stop it. This is the case a Content-Length check would wave through.
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES + 64 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const request = post(stream);
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("answers 503 and makes no call when the server has no key", async () => {
    isConfigured.mockReturnValue(false);
    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("not_configured");
    expect(payload.error.message).toContain("TYPESAFE_API_KEY");
    expect(payload.error.message).not.toContain(FAKE_KEY);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });

  it("refuses GET so a stray navigation cannot spend money", async () => {
    const response = evaluateGet();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(evaluateSystemOne).toHaveBeenCalledTimes(0);
  });
});

describe("a successful evaluation", () => {
  it("calls the adapter once with the preset questions and the exact state", async () => {
    evaluateSystemOne.mockResolvedValue(goodOutcome());

    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    expect(response.status).toBe(200);
    expect(evaluateSystemOne).toHaveBeenCalledTimes(1);

    const input = evaluateSystemOne.mock.calls[0]![0] as {
      state: unknown;
      questions: unknown;
    };
    expect(input.questions).toEqual(safety.questions);
    expect(input.state).toEqual(safetyState);
  });

  it("passes content strings through without rewriting them", async () => {
    evaluateSystemOne.mockResolvedValue(goodOutcome());
    const padded = `  ${String(safetyState.student_message)}\n`;

    await POST(
      jsonPost({
        scenarioId: "safety",
        state: { ...safetyState, student_message: padded },
      }),
    );

    const input = evaluateSystemOne.mock.calls[0]![0] as { state: Record<string, unknown> };
    // Validation must not trim, normalize, or otherwise edit what a student wrote.
    expect(input.state.student_message).toBe(padded);
  });

  it("returns only the documented envelope fields", async () => {
    evaluateSystemOne.mockResolvedValue(goodOutcome());
    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    const payload = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "durationMs",
      "requestedModel",
      "response",
      "source",
    ]);
    expect(payload.source).toBe("live");
    expect(payload.requestedModel).toBe("jev-requested");
    // Rounded, and measured around the call only.
    expect(payload.durationMs).toBe(813);

    const inner = payload.response as Record<string, unknown>;
    expect(Object.keys(inner).sort()).toEqual(["answers", "model", "usage"]);
    // The resolved model is preserved, not replaced by the requested one.
    expect(inner.model).toBe("jev-1-resolved");
    expect(inner.usage).toEqual({ input_tokens: 700, output_tokens: 50 });
    expect(Object.keys(inner.answers as object).sort()).toEqual(
      [...safety.questionOrder].sort(),
    );
  });

  it("omits usage entirely when the response carried none", async () => {
    evaluateSystemOne.mockResolvedValue({
      raw: { model: "jev-1-resolved", answers: upstreamAnswers },
      durationMs: 10,
      requestedModel: "jev-requested",
    });
    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    const payload = (await response.json()) as { response: Record<string, unknown> };
    expect(payload.response).not.toHaveProperty("usage");
  });

  it("returns a partial usage report without filling in the missing count", async () => {
    evaluateSystemOne.mockResolvedValue(
      goodOutcome({ usage: { input_tokens: 512 } }),
    );

    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    const text = await response.text();
    const payload = JSON.parse(text) as { response: { usage?: unknown } };

    // The reported count survives; the unreported one is absent from the JSON
    // rather than serialized as 0, which would read as a measurement.
    expect(payload.response.usage).toEqual({ input_tokens: 512 });
    expect(payload.response.usage).not.toHaveProperty("output_tokens");
    expect(text).not.toContain("output_tokens");
  });

  it("keeps a reported zero count as zero", async () => {
    evaluateSystemOne.mockResolvedValue(
      goodOutcome({ usage: { input_tokens: 0, output_tokens: 0 } }),
    );

    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    const payload = (await response.json()) as { response: { usage?: unknown } };
    expect(payload.response.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("never lets the key appear in a success payload", async () => {
    evaluateSystemOne.mockResolvedValue(goodOutcome());
    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    expect(await response.text()).not.toContain(FAKE_KEY);
  });

  it("marks every response no-store", async () => {
    evaluateSystemOne.mockResolvedValue(goodOutcome());
    const ok = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    expect(ok.headers.get("cache-control")).toBe("no-store, max-age=0");

    const bad = await POST(post("{"));
    expect(bad.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("works for the municipal preset too", async () => {
    const municipal = getScenario("municipal");

    /** A valid Choice answer built from whatever options the preset offers. */
    function choiceAnswer(questionId: string) {
      const question = municipal.questions[questionId] as {
        criteria: Record<string, unknown>;
      };
      const options = Object.keys(question.criteria);
      const rest = 0.001;
      const probabilities = Object.fromEntries(
        options.map((key, index) => [
          key,
          index === 0 ? 1 - (options.length - 1) * rest : rest,
        ]),
      );
      return {
        type: "choice",
        choice: options[0]!,
        probabilities,
        confidence: 0.6,
      };
    }

    evaluateSystemOne.mockResolvedValue({
      raw: {
        model: "jev-1-resolved",
        answers: {
          primary_agency: choiceAnswer("primary_agency"),
          disposition: choiceAnswer("disposition"),
        },
      },
      durationMs: 5,
      requestedModel: "jev-requested",
    });

    const response = await POST(
      jsonPost({
        scenarioId: "municipal",
        state: getDefaultSample(municipal).state,
      }),
    );
    expect(response.status).toBe(200);
    const input = evaluateSystemOne.mock.calls[0]![0] as { questions: unknown };
    expect(input.questions).toEqual(municipal.questions);
  });
});

describe("upstream failures", () => {
  const mapping: Array<[EvaluationErrorCode, number]> = [
    ["upstream_auth", 502],
    ["upstream_rate_limit", 429],
    ["upstream_timeout", 504],
    ["upstream_unavailable", 502],
    ["upstream_malformed", 502],
    ["not_configured", 503],
  ];

  for (const [code, status] of mapping) {
    it(`maps ${code} to ${status} with a sanitized message`, async () => {
      // The real error class, so the message is the shipped sanitized text.
      evaluateSystemOne.mockRejectedValue(new EvaluationError(code));

      const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(String(safetyState.student_message));
      const payload = JSON.parse(text) as { error: { code: string } };
      expect(payload.error.code).toBe(code);
    });
  }

  it("guides configuration on an authentication failure without naming the key", async () => {
    evaluateSystemOne.mockRejectedValue(new EvaluationError("upstream_auth"));
    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain("TYPESAFE_API_KEY");
    expect(payload.error.message).not.toContain(FAKE_KEY);
  });

  it("rejects a malformed upstream response rather than rendering part of it", async () => {
    evaluateSystemOne.mockResolvedValue({
      raw: {
        model: "jev-1-resolved",
        answers: {
          // Wrong type for this question, and an option that was never offered.
          self_harm_context: { type: "noul", noul: 0.4 },
          targeted_insult: { type: "noul", noul: 0.1 },
          handling: {
            type: "choice",
            choice: "call_the_police",
            probabilities: { call_the_police: 1 },
          },
        },
      },
      durationMs: 12,
      requestedModel: "jev-requested",
    });

    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("upstream_malformed");
    // The structural reasons are logged for a developer, not returned.
    expect(payload.error.message).not.toContain("self_harm_context");
  });

  it("turns an unexpected failure into a generic 500", async () => {
    evaluateSystemOne.mockRejectedValue(new Error(`boom ${FAKE_KEY}`));
    const response = await POST(jsonPost({ scenarioId: "safety", state: safetyState }));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("boom");
  });
});

describe("GET /api/config", () => {
  it("reports configured and nothing else", async () => {
    isConfigured.mockReturnValue(true);
    const response = await configGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ configured: true });
    // No fragment, no length, no prefix, no environment.
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(FAKE_KEY.slice(0, 8));
  });

  it("reports not configured when there is no key", async () => {
    isConfigured.mockReturnValue(false);
    const response = await configGet();
    expect(await response.json()).toEqual({ configured: false });
  });

  it("reports not configured rather than failing when the check throws", async () => {
    isConfigured.mockImplementation(() => {
      throw new Error("environment unreadable");
    });
    const response = await configGet();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ configured: false });
    expect(text).not.toContain("environment unreadable");
  });
});

/**
 * Adapter tests for the TypeSafe boundary.
 *
 * NO REAL CALLS. Every test here drives the *real* SDK — the same code path
 * production uses, including its request building, retry policy, timeout, and
 * error classes — over an injected fake `fetch`. Nothing touches the network,
 * so these tests cost nothing and behave identically on a machine that has a
 * real key configured.
 *
 * The key used throughout is the synthetic placeholder below. It is not a
 * credential; it exists so tests can assert that no key value ever appears in a
 * response, an error, a message, or an emitted browser bundle.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL,
  ERROR_STATUS,
  EvaluationError,
  UPSTREAM_TIMEOUT_MS,
  createClient,
  evaluateSystemOne,
  isConfigured,
  resolveRequestedModel,
} from "@/lib/evaluation";
import { validateUpstreamResult } from "@/lib/evaluation-response";
import { getDefaultSample, getScenario } from "@/lib/scenarios";
import type { Questions, State } from "@/lib/types";

/** Synthetic. Never a real credential; used to prove keys do not leak. */
const FAKE_KEY = "sk-typesafe-FAKE-TEST-KEY-DO-NOT-USE";

const safety = getScenario("safety");
const safetyState = getDefaultSample(safety).state as State;

/** A well-formed response to the safety preset's three questions. */
function safetyResponseBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-1-test",
    answers: {
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
        confidence: 0.82,
      },
      targeted_insult: { type: "noul", noul: 0.04 },
      handling: {
        type: "choice",
        choice: "allow",
        probabilities: { allow: 0.8, support: 0.1, redirect: 0.05, review: 0.05 },
        confidence: 0.77,
      },
    },
    usage: { input_tokens: 812, output_tokens: 64 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

/** A fake transport that records what the SDK tried to send. */
function recordingFetch(handler: (call: Recorded) => Promise<Response> | Response) {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { calls, fetchImpl };
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("configuration", () => {
  it("reports not configured when no key is present", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(isConfigured()).toBe(false);
  });

  it("treats a whitespace-only key as absent", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "   ");
    expect(isConfigured()).toBe(false);
  });

  it("reports configured when a key is present, without calling anything", () => {
    vi.stubEnv("TYPESAFE_API_KEY", FAKE_KEY);
    expect(isConfigured()).toBe(true);
  });

  it("defaults the model to jev-latest", () => {
    vi.stubEnv("TYPESAFE_MODEL", "");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "");
    expect(resolveRequestedModel()).toBe(DEFAULT_MODEL);
  });

  it("honours TYPESAFE_MODEL over the SDK's own variable", () => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-pinned");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "jev-other");
    expect(resolveRequestedModel()).toBe("jev-pinned");
  });

  it("refuses to build a client with no key, rather than throwing from the SDK", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    let caught: unknown;
    try {
      createClient();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluationError);
    expect((caught as EvaluationError).code).toBe("not_configured");
    expect(ERROR_STATUS.not_configured).toBe(503);
  });
});

describe("one successful evaluation", () => {
  it("makes exactly one request carrying the server's model and every preset question", async () => {
    vi.stubEnv("TYPESAFE_MODEL", "jev-pinned");
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(safetyResponseBody()));

    const outcome = await evaluateSystemOne(
      { state: safetyState, questions: safety.questions },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    );

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.init?.method).toBe("POST");

    const sent = bodyOf(call);
    expect(sent.model).toBe("jev-pinned");
    expect(outcome.requestedModel).toBe("jev-pinned");
    // Complete: every preset question, unaltered, and nothing extra.
    expect(sent.questions).toEqual(safety.questions);
    expect(Object.keys(sent.questions as object).sort()).toEqual(
      [...safety.questionOrder].sort(),
    );
    expect(sent.state).toEqual(safetyState);
    expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
  });

  it("measures a duration around the call and returns the payload unaltered", async () => {
    const body = safetyResponseBody();
    const { fetchImpl } = recordingFetch(() => jsonResponse(body));

    const outcome = await evaluateSystemOne(
      { state: safetyState, questions: safety.questions },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    );

    expect(outcome.raw).toEqual(body);
    expect(Number.isFinite(outcome.durationMs)).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.durationMs).toBeLessThan(UPSTREAM_TIMEOUT_MS);
  });

  it("sends the key as a bearer credential and nowhere else", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(safetyResponseBody()));
    await evaluateSystemOne(
      { state: safetyState, questions: safety.questions },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    );
    const call = calls[0]!;
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    // The body is the request; a credential has no business in it.
    expect(String(call.init?.body)).not.toContain(FAKE_KEY);
  });
});

describe("no automatic retries", () => {
  /** Every status the SDK would retry by default, and a transport failure. */
  const retryable = [429, 500, 503] as const;

  for (const status of retryable) {
    it(`sends one request only when the service answers ${status}`, async () => {
      const { calls, fetchImpl } = recordingFetch(() =>
        jsonResponse({ error: { message: "upstream detail" } }, status),
      );

      await expect(
        evaluateSystemOne(
          { state: safetyState, questions: safety.questions },
          { fetch: fetchImpl, apiKey: FAKE_KEY },
        ),
      ).rejects.toBeInstanceOf(EvaluationError);

      // The SDK's default is maxRetries: 2. One call proves it is disabled.
      expect(calls.length).toBe(1);
    });
  }

  it("does not retry a connection failure", async () => {
    const { calls, fetchImpl } = recordingFetch(() => {
      throw new Error("socket hang up");
    });

    await expect(
      evaluateSystemOne(
        { state: safetyState, questions: safety.questions },
        { fetch: fetchImpl, apiKey: FAKE_KEY },
      ),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(calls.length).toBe(1);
  });
});

describe("error classification", () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 401, code: "upstream_auth" },
    { status: 403, code: "upstream_auth" },
    { status: 429, code: "upstream_rate_limit" },
    { status: 400, code: "upstream_unavailable" },
    { status: 422, code: "upstream_unavailable" },
    { status: 500, code: "upstream_unavailable" },
    { status: 503, code: "upstream_unavailable" },
  ];

  for (const { status, code } of cases) {
    it(`maps ${status} to ${code}`, async () => {
      const { fetchImpl } = recordingFetch(() =>
        jsonResponse({ error: { message: "upstream detail", key: FAKE_KEY } }, status),
      );

      const error = await evaluateSystemOne(
        { state: safetyState, questions: safety.questions },
        { fetch: fetchImpl, apiKey: FAKE_KEY },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(EvaluationError);
      expect((error as EvaluationError).code).toBe(code);
      // Fixed text only: no upstream body, no echoed credential.
      expect((error as EvaluationError).message).not.toContain(FAKE_KEY);
      expect((error as EvaluationError).message).not.toContain("upstream detail");
    });
  }

  it("never places the key or the submitted State in an error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 401));
    const error = (await evaluateSystemOne(
      { state: safetyState, questions: safety.questions },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    ).catch((caught: unknown) => caught)) as EvaluationError;

    const serialized = `${error.name} ${error.message} ${error.stack ?? ""}`;
    expect(serialized).not.toContain(FAKE_KEY);
    const studentMessage = (safetyState as Record<string, unknown>).student_message;
    if (typeof studentMessage === "string" && studentMessage.length > 0) {
      expect(serialized).not.toContain(studentMessage);
    }
  });
});

describe("cancellation", () => {
  it("aborts the request after the 30-second budget and reports a timeout", async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          // A request that never answers. Only a real abort ends it.
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const promise = evaluateSystemOne(
      { state: safetyState, questions: safety.questions },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    );
    const settled = promise.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 10);

    const error = (await settled) as EvaluationError;
    expect(error).toBeInstanceOf(EvaluationError);
    expect(error.code).toBe("upstream_timeout");
    expect(ERROR_STATUS.upstream_timeout).toBe(504);
    // Timing out is not a reason to try again on the user's behalf.
    expect(calls.length).toBe(1);
  });

  it("really cancels the in-flight request rather than abandoning it", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const { fetchImpl } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const settled = evaluateSystemOne(
      { state: safetyState, questions: safety.questions },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    ).catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 10);
    await settled;

    // An uncancelled Promise.race would leave this false and keep being billed.
    expect(aborted).toBe(true);
  });

  it("distinguishes a caller abort from a timeout", async () => {
    const controller = new AbortController();
    const { fetchImpl } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const settled = evaluateSystemOne(
      { state: safetyState, questions: safety.questions, signal: controller.signal },
      { fetch: fetchImpl, apiKey: FAKE_KEY },
    ).catch((caught: unknown) => caught);

    controller.abort();
    const error = (await settled) as EvaluationError;
    expect(error.code).toBe("request_aborted");
  });
});

describe("response validation against the submitted questions", () => {
  it("accepts a complete, well-formed response", () => {
    const result = validateUpstreamResult(safetyResponseBody(), safety.questions);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.value?.model).toBe("jev-1-test");
    expect(result.value?.usage).toEqual({ input_tokens: 812, output_tokens: 64 });
    expect(Object.keys(result.value?.answers ?? {}).sort()).toEqual(
      [...safety.questionOrder].sort(),
    );
  });

  it("keeps a full distribution and does not renormalize rounded probabilities", () => {
    const body = safetyResponseBody();
    body.answers.handling.probabilities = {
      allow: 0.333,
      support: 0.333,
      redirect: 0.333,
      review: 0.0,
    };
    const result = validateUpstreamResult(body, safety.questions);
    expect(result.ok).toBe(true);
    expect(result.value?.answers.handling).toMatchObject({
      probabilities: { allow: 0.333, support: 0.333, redirect: 0.333, review: 0 },
    });
  });

  it("accepts a response with no usage and no confidence, and invents neither", () => {
    const body = safetyResponseBody();
    delete (body as { usage?: unknown }).usage;
    delete (body.answers.self_harm_context as { confidence?: unknown }).confidence;
    delete (body.answers.handling as { confidence?: unknown }).confidence;

    const result = validateUpstreamResult(body, safety.questions);
    expect(result.errors).toEqual([]);
    expect(result.value?.usage).toBeUndefined();
    expect(result.value?.answers.self_harm_context).not.toHaveProperty("confidence");
    expect(result.value?.answers.handling).not.toHaveProperty("confidence");
  });

  /**
   * A count that was not reported must stay absent.
   *
   * Substituting `0` would present "we were told nothing" as "we were told zero",
   * which is a measurement. These tests assert the *absence of a property*, not
   * just its value, because a fabricated zero passes a value check.
   */
  describe("partial token usage", () => {
    it("keeps an input-only count without inventing an output count", () => {
      const body = safetyResponseBody();
      (body as { usage?: unknown }).usage = { input_tokens: 12 };

      const result = validateUpstreamResult(body, safety.questions);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.value?.usage).toEqual({ input_tokens: 12 });
      expect(result.value?.usage).not.toHaveProperty("output_tokens");
    });

    it("keeps an output-only count without inventing an input count", () => {
      const body = safetyResponseBody();
      (body as { usage?: unknown }).usage = { output_tokens: 7 };

      const result = validateUpstreamResult(body, safety.questions);
      expect(result.errors).toEqual([]);
      expect(result.value?.usage).toEqual({ output_tokens: 7 });
      expect(result.value?.usage).not.toHaveProperty("input_tokens");
    });

    it("treats an explicit null count as unreported, not as zero", () => {
      const body = safetyResponseBody();
      (body as { usage?: unknown }).usage = { input_tokens: 12, output_tokens: null };

      const result = validateUpstreamResult(body, safety.questions);
      expect(result.errors).toEqual([]);
      expect(result.value?.usage).toEqual({ input_tokens: 12 });
      expect(result.value?.usage).not.toHaveProperty("output_tokens");
    });

    it("leaves usage absent when neither count is present", () => {
      const body = safetyResponseBody();
      (body as { usage?: unknown }).usage = {};

      const result = validateUpstreamResult(body, safety.questions);
      expect(result.errors).toEqual([]);
      expect(result.value?.usage).toBeUndefined();
    });

    it("keeps a genuinely reported zero as zero", () => {
      const body = safetyResponseBody();
      (body as { usage?: unknown }).usage = { input_tokens: 0, output_tokens: 0 };

      const result = validateUpstreamResult(body, safety.questions);
      expect(result.errors).toEqual([]);
      // A reported zero is a real count. Only an *absent* count is unavailable.
      expect(result.value?.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    it("still rejects a bad count rather than keeping the good one quietly", () => {
      const body = safetyResponseBody();
      (body as { usage?: unknown }).usage = { input_tokens: 12, output_tokens: 1.5 };

      const result = validateUpstreamResult(body, safety.questions);
      expect(result.ok).toBe(false);
      expect(result.errors.join(" | ")).toMatch(/usage\.output_tokens/);
    });
  });

  it("preserves a choice that is not the most probable option", () => {
    const body = safetyResponseBody();
    body.answers.handling.choice = "review";
    const result = validateUpstreamResult(body, safety.questions);
    expect(result.ok).toBe(true);
    // Not re-derived from the argmax: the service's selection is what happened.
    expect(result.value?.answers.handling).toMatchObject({ choice: "review" });
  });

  it("adapts a Score answer, including a fractional expected score", () => {
    const questions: Questions = {
      severity: {
        type: "score",
        instructions: "Rate the severity.",
        criteria: ["None at all.", "Some.", "A lot."],
      },
    };
    const result = validateUpstreamResult(
      {
        model: "jev-1-test",
        answers: {
          severity: {
            type: "score",
            score: 1.4,
            legend: { "0": "None at all.", "1": "Some.", "2": "A lot." },
            probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
          },
        },
      },
      questions,
    );
    expect(result.errors).toEqual([]);
    // An expected score legitimately falls between levels and is not rounded.
    expect(result.value?.answers.severity).toMatchObject({ score: 1.4 });
    expect(result.value?.answers.severity).not.toHaveProperty("confidence");
  });

  const malformed: Array<{ name: string; mutate: (body: ReturnType<typeof safetyResponseBody>) => void; match: RegExp }> = [
    {
      name: "an answer is missing",
      mutate: (body) => {
        delete (body.answers as Record<string, unknown>).handling;
      },
      match: /no answer for handling/,
    },
    {
      name: "an unexpected answer id appears",
      mutate: (body) => {
        (body.answers as Record<string, unknown>).other_question = {
          type: "noul",
          noul: 0.5,
        };
      },
      match: /unexpected answer id/,
    },
    {
      name: "an answer type does not match its question",
      mutate: (body) => {
        (body.answers as Record<string, unknown>).handling = { type: "noul", noul: 0.5 };
      },
      match: /does not match the submitted question type/,
    },
    {
      name: "a chosen option was never offered",
      mutate: (body) => {
        body.answers.handling.choice = "escalate_to_police";
      },
      match: /is not one of the options we submitted/,
    },
    {
      name: "a probability is out of range",
      mutate: (body) => {
        body.answers.handling.probabilities.allow = 1.4;
      },
      match: /not a finite number between 0 and 1/,
    },
    {
      name: "a probability is not a number",
      mutate: (body) => {
        (body.answers.handling.probabilities as Record<string, unknown>).allow = "0.8";
      },
      match: /not a finite number between 0 and 1/,
    },
    {
      name: "probabilities do not sum to 1",
      mutate: (body) => {
        body.answers.handling.probabilities = {
          allow: 0.2,
          support: 0.2,
          redirect: 0.1,
          review: 0.1,
        };
      },
      match: /rounding tolerance/,
    },
    {
      name: "a noul is a boolean",
      mutate: (body) => {
        (body.answers as Record<string, unknown>).targeted_insult = {
          type: "noul",
          noul: true,
        };
      },
      match: /probability of a yes answer, not a boolean/,
    },
    {
      name: "a noul carries a confidence it should not have",
      mutate: (body) => {
        (body.answers as Record<string, unknown>).targeted_insult = {
          type: "noul",
          noul: 0.2,
          confidence: 0.9,
        };
      },
      match: /must not carry a confidence/,
    },
    {
      name: "a confidence is present but nonsensical",
      mutate: (body) => {
        body.answers.handling.confidence = 12;
      },
      match: /confidence is present but/,
    },
    {
      name: "the resolved model is missing",
      mutate: (body) => {
        (body as { model?: unknown }).model = "";
      },
      match: /resolved model name is missing/,
    },
    {
      name: "a token count is negative",
      mutate: (body) => {
        (body as { usage?: unknown }).usage = { input_tokens: -1, output_tokens: 3 };
      },
      match: /nonnegative whole number/,
    },
  ];

  for (const { name, mutate, match } of malformed) {
    it(`rejects a response where ${name}`, () => {
      const body = safetyResponseBody();
      mutate(body);
      const result = validateUpstreamResult(body, safety.questions);
      expect(result.ok).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.errors.join(" | ")).toMatch(match);
    });
  }

  it("rejects a response that is not an object at all", () => {
    expect(validateUpstreamResult("nope", safety.questions).ok).toBe(false);
    expect(validateUpstreamResult(null, safety.questions).ok).toBe(false);
    expect(validateUpstreamResult([], safety.questions).ok).toBe(false);
  });
});

/**
 * Bundle inspection.
 *
 * Confirms that no key value, no environment read, and no SDK transport reaches
 * the browser. Skipped when there is no build output, so it can never pass
 * silently: run `npm run build`, then `npm run test`.
 *
 * The variable *name* is deliberately not forbidden. The UI tells a reader where
 * to put a key ("Put TYPESAFE_API_KEY in .env.local"), which is guidance, not
 * disclosure — the second test below pins it to exactly that use so the name
 * cannot start appearing in an env read or a serialized value instead.
 *
 * Only file paths and marker names are ever printed. No file contents and no
 * environment values are echoed by a failure.
 */
describe("emitted browser code", () => {
  const clientDir = join(process.cwd(), ".next", "static");

  function collect(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) collect(path, out);
      else if (/\.(js|mjs|css|txt|json)$/.test(entry)) out.push(path);
    }
    return out;
  }

  it.runIf(existsSync(clientDir))(
    "contains no key value, no environment read, and no SDK transport",
    () => {
      const files = collect(clientDir);
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const marker of [
          // A key value, synthetic or otherwise.
          FAKE_KEY,
          // Any read of a TypeSafe variable from the client's environment.
          "process.env.TYPESAFE",
          // The name as an object key or a serialized value: an env dump.
          'TYPESAFE_API_KEY"',
          "TYPESAFE_API_KEY:",
          "TYPESAFE_API_KEY=",
          // The provider endpoint and the SDK itself.
          "api.typesafe.ai",
          "@typesafe-ai/sdk",
          "dangerouslyAllowBrowser",
        ]) {
          if (text.includes(marker)) offenders.push(`${file}: ${marker}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it.runIf(existsSync(clientDir))(
    "mentions the variable name only as setup guidance",
    () => {
      const name = "TYPESAFE_API_KEY";
      let occurrences = 0;

      for (const file of collect(clientDir)) {
        const text = readFileSync(file, "utf8");
        let index = text.indexOf(name);
        while (index !== -1) {
          occurrences += 1;
          // The one sanctioned use: telling a reader where to put their own key.
          const guidance = `${name} in .env.local`;
          expect(
            text.slice(index, index + guidance.length),
            `${file} mentions ${name} outside the setup guidance`,
          ).toBe(guidance);
          index = text.indexOf(name, index + 1);
        }
      }

      // The guidance is part of the shipped UI, so it must actually be there —
      // a zero here would mean this check had quietly stopped checking anything.
      expect(occurrences).toBeGreaterThan(0);
    },
  );
});

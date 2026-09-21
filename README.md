# Jev playground

A local playground for exploring **TypeSafe Jev typed questions** against two scenarios:
**Student safety guardrails** and **Municipal ticket triage**.

There are **two modes**, and the choice is always explicit:

- **Fixture** (the default) — hand-written illustrative answers. No model is called, no API
  key is used, and no request leaves the browser. This is the mode for reading the request
  contract (`{ state, questions }`), editing a State, and seeing how typed answers are
  reconciled by ordinary application code.
- **Live** — one real, billed TypeSafe call per press of **Evaluate with Jev**, made from
  the server. You get the actual typed answers, the measured call duration, the token counts
  the response carried, and the model TypeSafe resolved.

Fixture mode needs no key and never will. Live mode needs one; see
[Live mode and the API key](#live-mode-and-the-api-key).

## What this is not

- **Not** a measurement of Jev quality. A working integration says the API returns typed
  answers in the documented shape. It says nothing about whether those answers are right.
  The sample "expected outcome" notes are *proposals for review*, held outside State and
  never submitted; they have never been scored against a real evaluation.
- **Not** evidence that the safety scenario is safe or that the routing scenario routes
  correctly. One response is one response.
- **Not** a moderation or escalation system. The safety scenario does not contact anyone,
  log anything, or take action on a student. Nothing is dispatched to any agency.
- **Not** a benchmark runner. There is no dataset sweep, no accuracy metric, and no run
  history. Live results show what a single call measured; fixture results show *Unavailable*
  for every measurement field, because nothing was measured.
- **Not** a cost report. The API documents no cost field, so **Cost** always reads
  *Unavailable* rather than an estimate dressed up as a measurement.

## Requirements

- Node **>= 20.9.0** and npm **>= 10**. Developed and checked on Node **26.3.1** /
  npm **11.16.0**.
- A Chromium build for Playwright, only if you want to run the browser tests
  (see [Browser tests](#browser-tests)).

## Setup

```bash
npm install
npm run dev     # http://localhost:3000
```

`package-lock.json` is committed; use `npm ci` for a reproducible install.

**No key is needed to install, develop, build, or run any check.** Without one the app
starts normally, Fixture mode works in full, and Live mode is disabled with an explanation.

## Live mode and the API key

Copy `.env.example` to `.env.local` and fill in your own key:

```bash
cp .env.example .env.local
# then edit .env.local:
#   TYPESAFE_API_KEY=...        required for Live mode
#   TYPESAFE_MODEL=jev-latest   optional; this is the default
```

Restart the dev server after editing it — Next.js reads env files at startup.

`.env.local` and every other `.env*` file are gitignored; only `.env.example`, which holds
placeholders, is committed. The key is read **on the server only**. It is never sent to the
browser, never included in a response body, and never written into an error message or a
log line.

### "Configured" is not "verified"

`GET /api/config` returns exactly `{ "configured": true | false }`. `true` means a non-empty
`TYPESAFE_API_KEY` is present in the server's environment — **not** that it is valid, funded,
accepted, or within quota. Nothing but a real call can establish that, and this check
deliberately does not make one. So a configured server can still fail on the first
evaluation with an authentication or rate-limit error; that is expected, not a bug.

If the check itself fails, Live mode is disabled and Fixture mode is unaffected.

### What Live mode sends, and what it does not

The browser sends only `{ scenarioId, state }`. The server resolves that scenario's preset
questions itself and chooses the model. A page therefore **cannot** ask for a different
model, a different provider URL, a different set of questions, or supply its own key — those
are server decisions, and the route rejects any request carrying them.

One press is **one** upstream request. Retries are switched off, including the SDK's own
defaults, so a failure is reported rather than silently re-billed. The call is aborted after
30 seconds. Nothing else in the UI causes inference: typing, loading a sample, resetting,
switching scenario or mode, and re-checking configuration never call the model.

Before a live response is rendered it is checked against the questions that were submitted —
answer ids and types must match, a Choice option must be one of that question's criteria,
probabilities must be finite and within `0..1`, a Score's legend and levels must be valid.
Full distributions and confidence are preserved as returned; nothing is renormalized and no
missing value is invented. A malformed or incomplete response is reported as an upstream
error instead of being partly rendered.

### When a live call fails

The failure is shown with its code and an actionable message, and **no fixture is
substituted for it**. A failed model call has no answer, and showing a hand-written one in
its place would misrepresent it. A previous successful live result stays visible under its
own request snapshot, labelled stale if the State has since changed.

| Situation | Status | Code |
| --- | --- | --- |
| No key on the server | 503 | `not_configured` |
| TypeSafe rejected the credentials | 502 | `upstream_auth` |
| Rate-limited | 429 | `upstream_rate_limit` |
| No response within 30 s | 504 | `upstream_timeout` |
| Service unavailable | 502 | `upstream_unavailable` |
| Response did not match the questions | 502 | `upstream_malformed` |
| Body was not valid JSON or not the accepted shape | 400 | — |
| Body larger than 128 KiB | 413 | — |

Error messages and server logs carry the code and guidance only — never the key, never the
raw upstream error, never the submitted student message.

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run test        # vitest: composition, fixtures, validation, adapter, route
npm run build       # production build; succeeds with no API key present
npm run test:e2e    # Playwright, desktop 1440px and mobile 390px
```

**No automated check makes a real provider call**, even on a machine with a key configured:

- The adapter tests drive the real SDK over an injected fake `fetch` and a synthetic fake
  key, so the request is fully assembled but never leaves the process.
- The route tests mock the adapter and assert it was **not** called on every rejection path.
- The browser tests fulfil `/api/config` and `/api/evaluate` with `page.route`, and
  `playwright.config.ts` starts the server under test with the TypeSafe variables blanked, so
  an unmocked request could only produce a 503.
- One test greps the emitted client bundle in `.next/static` for the fake key, for
  `TYPESAFE_API_KEY`, for `api.typesafe.ai`, and for the SDK itself, confirming that key and
  transport stay on the server. Run `npm run build` before `npm run test` for it to execute.

Mocked live results are annotated as such in the Playwright report. A green
`live-playground.spec.ts` is evidence that the UI handles live-shaped responses correctly —
not that the integration has been verified against the real service.

### Why the build is pinned to webpack

`dev` and `build` pass `--webpack` rather than using the default Turbopack. On this
machine Turbopack's PostCSS transform fails while spawning its worker:

```
Failed to write app endpoint /page
  [project]/app/globals.css [app-client] (css)
  creating new process / binding to a port / Operation not permitted (os error 1)
```

This is not a sandbox artefact — it reproduces with sandboxing disabled, a plain Node
process can bind a port on the same machine, and the Turbopack build succeeds as soon as
`postcss.config.mjs` is removed. The webpack build succeeds with Tailwind's utilities
present in the emitted CSS. If Turbopack's PostCSS worker works in your environment, you
can drop the flag; the application code does not depend on either bundler.

### Browser tests

Playwright needs a matching Chromium. If the suite reports a missing browser:

```bash
npx playwright install chromium
```

The suite starts its own production server on `127.0.0.1:3100`, so run `npm run build`
first. It also writes layout evidence to `screenshots/` (gitignored), one pair of
full-page screenshots per viewport project.

## How it works

Three panels, left to right (stacked on narrow viewports):

1. **Scenarios** — pick Student safety guardrails or Municipal ticket triage. Each carries
   its own purpose and caveat. Safety is the default.
2. **Request** — grouped sample buttons replace the State; **Reset to preset** restores the
   scenario default. The State is an editable JSON textarea. The questions are read-only in
   this version, as is the combined `{ state, questions }` JSON. **Mode** selects Fixture or
   Live; the action button below it is **Preview fixture** or **Evaluate with Jev**
   accordingly, and the live button stays disabled until the request validates *and* the
   server reports a key.
3. **Response** — answers as cards or as raw JSON, always under a badge naming their source:
   **Fixture data — no model call** or **Live Jev response — real model call**. Both views
   state the source in words as well.

Each scenario keeps its **own** draft, and each scenario keeps a **separate result per
mode**. Switching scenarios never shows one scenario's result beside another's request, and
switching modes never turns a fixture into a live result or the other way round.

### A result belongs to one request

Every displayed result carries the exact State it was produced from. Editing the State marks
it **stale** and keeps showing the snapshot it actually came from; it is never silently
re-attached to new input.

The same rule governs a slow live response. Where it lands is decided when the request is
sent, not when it arrives, so a response that comes back after you have switched scenario,
switched mode, or edited the State can never look like an answer to the new input: it waits
in its own slot, marked stale if the State moved on. If a newer request for that same slot
has already started, the older response is discarded outright rather than displayed.

### Editing and errors

A malformed State is **kept exactly as typed** — it is never reformatted or discarded — and
the error names the problem with a concrete next step. Both actions stay disabled until the
State parses *and* matches the scenario schema. A State containing an expected label
(`expected_handling`, `ground_truth`, `correct_agency`, and similar) is rejected: labels
belong outside the payload, or the model can read its own answer.

Validation **reads and never rewrites**. No check trims or normalizes a string, so the State
that is sent upstream and shown in the request snapshot is byte-for-byte the one submitted.
Blank strings are still rejected — they are reported, not silently trimmed away.

### How fixtures are chosen

By **exact deep equality** against a sample's State — deliberately not by keyword matching.
A keyword heuristic would be a hidden classifier pretending to be a model answer. Any State
that does not match a sample gets a clearly labelled **generic placeholder**, flat by
construction, which composes to "human review".

Fixture responses carry no `model` and no `usage`, so there is no fabricated telemetry to
mistake for a measurement.

## The question types

| Type | Answer | Notes |
| --- | --- | --- |
| **Noul** | `noul`: a number in `0..1` | The **probability that the answer to the yes/no question is yes**. Not a boolean, not a severity or offensiveness score, not an accuracy figure. A Noul answer carries **no** confidence value. |
| **Choice** | `choice` + `probabilities` + optional `confidence` | `criteria` is an option → rubric map, up to 255 options. |
| **Score** | `score` + `legend` + `probabilities` + optional `confidence` | `criteria` is an ordered array of 2–10 levels. A score can land between levels. |

`confidence` and `usage` are optional in a real response. When they are absent the card reads
*Unavailable* — no stand-in number is substituted, and nothing fails to render.

Question **ids are keys you choose**. They are not sent to the model and play no part in
inference, so every question must be self-contained — it cannot refer to another question,
or to another question's answer.

Questions in one request are evaluated **independently**. Any relationship between them is
imposed afterwards by ordinary application code. The playground shows both: the raw answers
are always displayed in full, and the composed outcome is shown separately as an
application decision.

## Composition rules

`lib/safety-guardrails.ts` — precedence, applied to raw answers:

1. `urgent_support` or `support_needed` → **Support**, whatever the handling answer says
   (a disagreeing handling answer is flagged as a conflict, not hidden).
2. Otherwise a raw `review` handling → **Human review**.
3. Otherwise `harmful_request` agrees only with `redirect`; anything else → **Human
   review** with a conflict.
4. Otherwise `none` / `contextual` follow the handling answer, except that `support` there
   → **Human review** with a conflict.
5. A missing or off-menu answer → **Human review**.

The Noul probability is carried through and displayed as a percentage. It is never
thresholded into a boolean and never overrides the Choice answers.

`lib/municipal-routing.ts` — reconciliation:

- `outside_scope` / `non_actionable` **suppress** the named agency; the raw answer stays
  visible.
- `needs_clarification` → **tentative** agency plus an explicit "information missing".
- `human_review`, or `routable` with `Unclear`, → **human review**.

Raw agency accuracy and the application's decision to defer or suppress are kept distinct,
so abstention cannot hide an error.

## Agency taxonomy provenance

`lib/agency-definitions.ts` holds a **prototype** Singapore agency taxonomy
(`prototype-2026-09-21`) copied from a prototype routing module, with its source and read
date recorded in the file header. It contains intentional overlap between agencies and is
**not** verified operational policy. Do not treat it as an authoritative routing table.

## Layout

```
app/                    App Router shell, global tokens, client page holding all state
app/api/config/         GET { configured: boolean } — presence of a key, nothing more
app/api/evaluate/       POST { scenarioId, state } — the only route that can spend money
components/             scenario-picker, request-editor, response-panel, probability-bars
lib/evaluation.ts       server-only SDK adapter: lazy client, no retries, 30 s abort
lib/evaluation-response.ts  runtime check of a response against the submitted questions
lib/                    types, schemas (Zod), scenarios + samples, fixtures,
                        safety-guardrails, municipal-routing, agency-definitions
tests/                  decisions, request-validation, evaluation, evaluation-route (vitest)
                        playground.spec.ts, live-playground.spec.ts (Playwright)
```

`lib/evaluation.ts` is the only module that touches the key or the SDK, and it refuses to
load in a browser. Nothing above it in the import graph is a client component.

Bars are `aria-hidden`; every percentage is also present as text, so nothing is conveyed by
colour or width alone.

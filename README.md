# Jev playground

A local, offline playground for exploring **TypeSafe Jev typed questions** against two
scenarios: **Student safety guardrails** and **Municipal ticket triage**.

Everything in this version is a **fixture**. No model is called, no API key is used, and
no request leaves the browser. The purpose is to let a reviewer read the request contract
(`{ state, questions }`), edit a State, and see how typed answers would be reconciled by
ordinary application code — before any live evaluation exists.

## What this is not

- **Not** a connection to the TypeSafe API. The `model` field is deliberately absent from
  the request, and there is no `/api/evaluate` route. Connecting the direct API is a later
  task.
- **Not** a measurement of Jev quality. The sample "expected outcome" notes are *proposals
  for review*, held outside State and never submitted. They have never been scored against
  a real evaluation.
- **Not** a moderation or escalation system. The safety scenario does not contact anyone,
  log anything, or take action on a student.
- **Not** a benchmark runner. There is no dataset sweep, no accuracy metric, and no
  latency/cost/token measurement. Every measurement field in the response panel reads
  *Unavailable*, because nothing was measured.

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

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run test        # vitest: composition, fixtures, request validation
npm run build       # production build
npm run test:e2e    # Playwright, desktop 1440px and mobile 390px
```

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
   this version, as is the combined `{ state, questions }` JSON.
3. **Response** — **Preview fixture** shows the fixed illustrative answers, as cards or as
   raw JSON, under a persistent **Fixture data — no model call** badge.

Each scenario keeps its **own** draft and its **own** result. Switching scenarios never
shows one scenario's result beside another's request.

### Editing and errors

A malformed State is **kept exactly as typed** — it is never reformatted or discarded — and
the error names the problem with a concrete next step. Preview stays disabled until the
State parses *and* matches the scenario schema. A State containing an expected label
(`expected_handling`, `ground_truth`, `correct_agency`, and similar) is rejected: labels
belong outside the payload, or the model can read its own answer.

Editing a State after a preview marks the displayed result **stale** and shows the request
snapshot it actually came from, rather than silently pairing new input with an old result.

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
| **Choice** | `choice` + `probabilities` + `confidence` | `criteria` is an option → rubric map, up to 255 options. |
| **Score** | `score` + `legend` + `probabilities` + `confidence` | `criteria` is an ordered array of 2–10 levels. |

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
app/          App Router shell, global tokens, client page holding all state
components/   scenario-picker, request-editor, response-panel, probability-bars
lib/          types, schemas (Zod), scenarios + samples, fixtures,
              safety-guardrails, municipal-routing, agency-definitions
tests/        decisions.test.ts, request-validation.test.ts (vitest),
              playground.spec.ts (Playwright)
```

Bars are `aria-hidden`; every percentage is also present as text, so nothing is conveyed by
colour or width alone.

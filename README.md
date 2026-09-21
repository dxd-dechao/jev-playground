# Jev playground

A local playground for exploring **TypeSafe Jev typed questions** against two scenarios:
**Student safety guardrails** and **Municipal ticket triage**.

There are **three actions**. **Evaluate with Jev** posts once to `POST /api/evaluate` (one
TypeSafe call). **Evaluate with LLM** posts once to `POST /api/evaluate-llm` (one Moonshot
call). **Evaluate with both** posts once to each route. Each engine's result shows that
engine's typed answers, the measured call duration, the token counts the response carried,
and the model the server resolved, with **Measurement** under those answers. A missing
Moonshot key disables LLM and Both; it does not disable Jev.

Evaluate with Jev needs a TypeSafe key on the server; Evaluate with LLM needs a Moonshot
key. See [The API key](#the-api-key). Without the matching key the page still loads, and
every editing feature works, but that button is disabled with a short explanation. (Before
JEV-08 there was also an offline Fixture mode; it has been removed from the page. The
hand-written fixtures remain in `lib/fixtures.ts` as offline test infrastructure.)

A hosted server can also set a shared playground password so Evaluate is not an open
spend of provider credits. See [Deploying to Railway](#deploying-to-railway). Browsing,
editing State and questions, and loading samples stay public.

## What this is not

- **Not** a measurement of Jev quality. A working integration says the API returns typed
  answers in the documented shape. It says nothing about whether those answers are right.
  Each sample's proposed expected outcome is kept in `lib/scenarios.ts` for the offline
  evaluation tooling only; it is not shown in the page, never enters State, and has never
  been scored against a real evaluation.
- **Not** evidence that the safety scenario is safe or that the routing scenario routes
  correctly. One response is one response.
- **Not** a moderation or escalation system. The safety scenario does not contact anyone,
  log anything, or take action on a student. Nothing is dispatched to any agency.
- **Not** a benchmark runner in the browser. The playground has no dataset sweep, no accuracy
  metric, and no run history. A result shows what a single call measured. Offline
  evaluation tooling lives separately under `evaluation/` (see [Evaluation](#evaluation)); its
  live commands are explicitly invoked, never part of a check, and never reachable from the
  browser.
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
starts normally and every editor works; the matching Evaluate buttons are disabled, with
an explanation.

## The API key

On macOS, store the TypeSafe key in your login Keychain rather than in a plaintext `.env.local` file:

```bash
scripts/store-typesafe-key.sh
# Paste the key only into the macOS prompt, then start the server:
scripts/with-typesafe-key.sh npm run dev
```

The runner reads the key from Keychain and exports it only to the launched server process and
its children. It does not write or print the secret. Restart the server after changing the key.
Use the same runner for a production start: `scripts/with-typesafe-key.sh npm run start`.

`.env.local` and every other `.env*` file remain gitignored for compatibility, but Keychain is
the preferred local setup. Only `.env.example`, which holds placeholders, is committed. The key
is read **on the server only**. It is never sent to the browser, included in a response body, or
written into an error message or log line.

### "Configured" is not "verified"

`GET /api/config` returns
`{ "configured": true | false, "llmConfigured": true | false, "access": "open" | "required" | "granted" }`.
`configured: true` means a non-empty `TYPESAFE_API_KEY` is present in the server's
environment — **not** that it is valid, funded, accepted, or within quota. Nothing
but a real call can establish that, and this check deliberately does not make one.
`llmConfigured: true` means a non-empty `MOONSHOT_API_KEY` is present, with the
same caveat; a mocked `{ configured: true }` that omits `llmConfigured` is treated
as the language-model path not being configured. `access` is independent: `open`
when no playground password is set (the local default), `required` when a password
is set and this browser has no valid session cookie, `granted` when the cookie is
valid. The field never includes the password, a hash, a cookie value, a key, or a
model name. Mocked tests that omit `access` are treated as `open`.

So a configured server can still fail on the first evaluation with an authentication
or rate-limit error; that is expected, not a bug. A hosted server with
`PLAYGROUND_PASSWORD` set still lets anyone browse and edit; only an Evaluate action asks
for the shared password, and only the first time in that browser.

While the TypeSafe check is running, or if it fails, Evaluate with Jev is disabled. A short
status line beside the buttons says why, with a **Re-check configuration** button when there
is no TypeSafe key or the check failed. When TypeSafe is configured and Moonshot is not, Jev
stays enabled and a separate note says the language-model button needs a Moonshot key on the
server. When both keys are present, neither note is shown.

### What Evaluate sends, and what it does not

The browser sends exactly `{ scenarioId, state, questions }` — the request shown in the
editor, questions included (changed in JEV-03; earlier versions sent only the State and
used the preset questions). The server validates both halves again before anything reaches
the SDK: State must be a non-empty string, object, or array with no expected label;
questions must be non-empty, with unique ids and Choice options (duplicate JSON keys in the
raw body are refused rather than silently collapsed), valid Choice option counts, 2–10
Score levels, and a well-formed Noul. A missing `questions` field is a 400, as is any
invalid request, and none of them calls the provider. The model, the provider URL, and the
key stay server decisions: a page **cannot** supply them, and the route rejects any body
carrying them. The body cap stays at 128 KiB.

One press of **Evaluate with Jev** or **⌘/Ctrl+Enter** is **one** TypeSafe request. One press
of **Evaluate with LLM** is **one** Moonshot request. **Evaluate with both** is those two
calls started together, not one after the other. Retries are switched off, including the
SDK's own defaults, so a failure is reported rather than silently re-billed. Each call is
aborted after 30 seconds. The shortcut has the same guards as Evaluate with Jev: it does
nothing while the request is invalid, TypeSafe is unconfigured, or a call is already in
flight, and it never starts an LLM or both call. Nothing else in the UI causes inference:
typing, loading a sample, resetting, switching scenario, State format, or view, and
re-checking configuration never call a model.

Before a live response is rendered it is checked against the questions that were submitted —
answer ids and types must match, a Choice option must be one of that question's criteria,
probabilities must be finite and within `0..1`, a Score's legend and levels must be valid.
Full distributions and confidence are preserved as returned; nothing is renormalized and no
missing value is invented. A malformed or incomplete response is reported as an upstream
error instead of being partly rendered.

### When a live call fails

The failure is shown with its code and an actionable message, and **nothing is substituted
for it**. A failed model call has no answer. A previous successful live result stays visible under its
own request snapshot, labelled stale if the State or questions have since changed.

| Situation | Status | Code |
| --- | --- | --- |
| No key on the server | 503 | `not_configured` |
| Playground password required and this request has no valid cookie | 401 | `unauthorized` |
| Password set but `PLAYGROUND_SESSION_SECRET` missing | 503 | `gate_misconfigured` |
| TypeSafe rejected the credentials | 502 | `upstream_auth` |
| Rate-limited | 429 | `upstream_rate_limit` |
| No response within 30 s | 504 | `upstream_timeout` |
| Service unavailable | 502 | `upstream_unavailable` |
| Response did not match the questions | 502 | `upstream_malformed` |
| Body was not valid JSON or not the accepted shape | 400 | — |
| Body larger than 128 KiB | 413 | — |

Error messages and server logs carry the code and guidance only — never the key, never the
raw upstream error, never the submitted student message.

## Language-model evaluation

**Evaluate with LLM** calls `POST /api/evaluate-llm`. **Evaluate with both** calls that
route once and `POST /api/evaluate` once. Both routes accept the same body —
`{ scenarioId, state, questions }` — and the same `jev_access` cookie when the playground
password is set. One LLM request spends one Moonshot chat-completions call (default model
`kimi-k2.6` with thinking disabled) and returns the same typed answers envelope plus the
measured call duration and the token counts the response actually carried. **Cost** stays
unavailable: Moonshot does not report a cost field here, and nothing is estimated.
Measurement stays under each engine's answers; there is no comparison block above them.

Unset `MOONSHOT_API_KEY` is valid. That route then returns 503 `not_configured`. Evaluate
with LLM and Evaluate with both are disabled; Evaluate with Jev is unaffected.

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run test        # vitest: composition, fixtures, validation, adapter, route
npm run build       # production build; succeeds with no API key present
npm run test:e2e    # Playwright, desktop 1440px and mobile 390px
```

The offline evaluation commands (`eval:prepare`, `eval:mock-run`, `eval:score`,
`eval:preflight`) are described in [Evaluation](#evaluation); they need no key either. The two
live commands (`eval:smoke`, `eval:live`) spend money and are never part of a check.

**No automated check makes a real provider call**, even on a machine with a key configured:

- The adapter tests drive the real SDK over an injected fake `fetch` and a synthetic fake
  key, so the request is fully assembled but never leaves the process.
- The route tests mock the adapter and assert it was **not** called on every rejection path.
- The browser tests fulfil `/api/config` and `/api/evaluate` with `page.route`, and
  `playwright.config.ts` starts the server under test with the TypeSafe, playground-password,
  and Moonshot variables blanked, so an unmocked request could only produce a 503.
- One test greps the emitted client bundle in `.next/static` for the fake key, for
  `TYPESAFE_API_KEY`, for `api.typesafe.ai`, for the SDK itself, for
  `process.env.PLAYGROUND` / playground password values, and for `MOONSHOT_API_KEY`,
  `api.moonshot.ai`, `api.moonshot.cn`, and the synthetic Moonshot test key,
  confirming that keys, session secret, and both transports stay on the server. Run
  `npm run build` before `npm run test` for it to execute.
- The live-path tests drive the same guards with fake evaluators and a fake `fetch`, and assert
  the network was never touched. One test asserts that `evaluation/live.ts` is the only module
  under `evaluation/` that imports the SDK or the transport, and that nothing imports it
  statically, so an offline command cannot load it even by accident.

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
first. It also writes layout evidence to `screenshots/` (gitignored): full-page
screenshots per viewport project, including the request editor's Form, invalid-JSON, and
custom-question views. Playwright starts that server with TypeSafe, playground-password,
and Moonshot variables blanked, so an unmocked Evaluate can only 503.

## Deploying to Railway

This is a Next.js app. Create a Railway service from this GitHub repository. Do not
put real secrets in the repo.

- **Node:** 20 or newer.
- **Build:** Railpack installs dependencies, then runs `npm run build`. Do not put `npm ci` in the Railway build command: Railpack mounts `node_modules/.cache`, and `npm ci` fails trying to remove it.
- **Start:** `npm run start -- --hostname 0.0.0.0`. Railway provides `PORT`;
  `next start` already honours it. Binding `0.0.0.0` is required so the proxy can reach
  the process.
- **Healthcheck:** `GET /`.

Set these variables on the service. Mark secrets as sensitive:

| Variable | Required | Role |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | To Evaluate with Jev | TypeSafe key. Visitors never type this. |
| `MOONSHOT_API_KEY` | Optional | Moonshot key for Evaluate with LLM / both (`POST /api/evaluate-llm`). Unset is valid; that route then returns 503, and Jev stays available. |
| `PLAYGROUND_PASSWORD` | To gate Evaluate | Shared password people type. Blank/unset = gate off. Both sides are trimmed once. |
| `PLAYGROUND_SESSION_SECRET` | When the password is set | Long random HMAC key for the `jev_access` cookie. Do not derive it from the password. |

Browsing, editing State/questions, loading samples, Reset, and the configuration
re-check stay public. Evaluate is gated when `PLAYGROUND_PASSWORD` is set: the first
press in a browser asks for the password; later presses use an HttpOnly cookie for
seven days. This is a shared-secret speed bump, **not** user accounts. Anyone who
knows the password can spend TypeSafe and Moonshot credits.

Unlock failures are rate-limited in memory (five per client IP per 15 minutes, using
the first `x-forwarded-for` hop on Railway). That budget is per replica and is not a
security boundary.

`railway.toml` in this repo matches the build/start/healthcheck above. It does not
contain a service token. This task does not create a Railway project or deploy.

JEV-06's live evaluation budget is exhausted. Deploying the playground makes no
provider call by itself; only an explicit Evaluate after unlock does.

## How it works

Three panels, left to right (stacked on narrow viewports):

1. **Scenarios** — two card buttons, Student safety guardrails and Municipal ticket triage.
   Each card shows the preset's question types and a one-sentence purpose; the selected card
   is yellow. Safety is the default. The full purpose and the scenario's caveat are in the
   **About this scenario** disclosure under the Request heading.
2. **Request** — a **Form** / **Whole-request JSON** switch sits beside the heading (see
   [Editing the request](#editing-the-request)). Below it are three actions: **Evaluate
   with Jev** (`POST /api/evaluate`; **⌘/Ctrl+Enter** does the same), **Evaluate with LLM**
   (`POST /api/evaluate-llm`), and **Evaluate with both** (one call to each). When the
   request is valid and the matching key is present, that button is enabled; otherwise a
   short line beside the buttons says what blocks it. A missing Moonshot key disables LLM
   and Both without disabling Jev. State and every question are always submitted together
   as **one** request. Then the **State** section: grouped sample buttons replace the State
   **only** and keep your questions; **Reset to preset** (in red) restores the scenario's
   default State *and* questions and discards any invalid draft. Samples and Reset work in
   either view.
3. **Response** — answers as cards or as raw JSON, under that engine's live badge and the
   model that answered. A Jev result uses **Live Jev response — real model call**; an LLM
   result uses **Live LLM response — real model call**. Evaluate with both stacks Jev then
   LLM, each with its own answers and Measurement underneath. There is no comparison
   Measurement above the answers.

Each scenario keeps its **own** draft and its **own** Jev and LLM result slots. Switching
scenarios never shows one scenario's result beside another's request.

### A result belongs to one request

Every displayed result carries the exact request — State *and* questions — it was produced
from, and the order its questions were shown in. Editing either half marks it **stale** and
keeps showing the snapshot it actually came from; it is never silently re-attached to new
input. Staleness compares values, so reformatting JSON whitespace alone does not count as
an edit.

The same rule governs a slow live response. Where it lands is decided when the request is
sent, not when it arrives, so a response that comes back after you have switched scenario
or edited the request can never look like an answer to the new input: it waits
in its own slot, marked stale if the State moved on. If a newer request for that same slot
has already started, the older response is discarded outright rather than displayed.

### Editing the request

Each scenario keeps its own draft — State, questions, the chosen view, and any pending
invalid JSON — across scenario switches.

**Form view.**

- **State** has a **JSON** / **Text** toggle. JSON shows the full State: an object, array,
  or string; `null`, numbers, booleans, and empty values are rejected. **Text shows only the
  scenario's primary message** — `student_message` for Student safety guardrails, `feedback`
  for Municipal ticket triage (`primaryTextField` in `lib/scenarios.ts`). Editing it changes
  that one field; every other State field (`conversation_history`, `learning_context`,
  `clarification_history`, `agency_config`, anything else) is kept and **sent unchanged**, so
  the request is still the full structured object. For a top-level string State, Text edits
  the string itself and it is sent as a string.
  - Text → JSON restores the JSON source exactly if the text was not edited; otherwise it
    shows the full State with the edited field in place.
  - A valid whole-request JSON edit updates the Text on return to the Form, and a sample
    keeps the current mode.
  - Text is **refused**, with a reason next to the toggle, when it would lose or invent
    data: invalid JSON, an array or other non-string non-object, or an object without a
    string primary field. JSON stays authoritative then.
  Content is never trimmed.
- **Questions** sit below State, one card per question (the coloured edge marks the type,
  which is also written out). The cards are presentation only: there is no per-card
  submission. Edit each question's id, type, instructions, and criteria; add and remove
  questions; add, remove, and rename Choice options (a description may be text, JSON, or an
  explicit `null`); add, remove, and reorder Score levels (2–10); and edit or omit a Noul's
  yes/no descriptions. Instructions and criteria can be switched to a JSON text box for
  structured values. Changing a question's type resets its criteria to empty defaults, so
  no hidden criteria of the old type can be sent. Duplicate ids and duplicate options are
  marked on the inputs and kept as typed; the request cannot be submitted, or shown as
  JSON, until one is renamed.

**Whole-request JSON view** edits exactly `{ state, questions }`. A valid edit carries over
to the Form, and Form edits appear in the JSON. Invalid JSON — a syntax error, an extra
field, a duplicate question id or option key (which `JSON.parse` would otherwise collapse
silently), or a question the Form cannot represent — is **kept exactly as typed**, disables
submission, and survives switching view or scenario. While it is pending the Form is
read-only, offering **Return to JSON** or **Reset to preset**; it is never silently replaced
by the last valid version.

**Validation.** The request must be one the API accepts; beyond that it is not forced
through the preset's State schema, since custom questions may want any shape. Two
non-blocking warnings remain: a top-level string State with preset questions (which refer
to named fields such as `student_message` that a plain string lacks — nothing is wrapped or
rewritten),
and object State missing fields the default questions read. A State containing an
expected label (`expected_handling`, `ground_truth`, `correct_agency`, and similar) is
still rejected: labels belong outside the payload, or the model can read its own answer.

Validation **reads and never rewrites**. No check trims or normalizes a string, so the
request that is sent upstream and shown in the request snapshot is byte-for-byte the one
submitted. Blank strings are still rejected — they are reported, not silently trimmed away.

## The question types

| Type | Answer | Notes |
| --- | --- | --- |
| **Noul** | `noul`: a number in `0..1` | The **probability that the answer to the yes/no question is yes**. Not a boolean, not a severity or offensiveness score, not an accuracy figure. A Noul answer carries **no** confidence value. |
| **Choice** | `choice` + `probabilities` + optional `confidence` | `criteria` is an option → rubric map, up to 255 options. |
| **Score** | `score` + `legend` + `probabilities` + optional `confidence` | `criteria` is an ordered array of 2–10 levels. A score can land between levels. |

`confidence` and `usage` are optional in a real response, and the two token counts inside
`usage` are independently optional. When something is absent the card reads *Unavailable* —
no stand-in number is substituted, and nothing fails to render. In particular an unreported
token count is never shown as `0`, because `0` is a count that was reported. A response that
carries only `input_tokens` shows that number beside an *Unavailable* output count, and the
response JSON omits the field rather than inventing it.

Question **ids are keys you choose**. They are not sent to the model and play no part in
inference, so every question must be self-contained — it cannot refer to another question,
or to another question's answer.

Questions in one request are evaluated **independently**. Any relationship between them is
imposed afterwards by ordinary application code. The playground shows both: the raw answers
are always displayed in full, and the composed outcome is shown separately as an
application decision.

## Composition rules

Composition applies only to a result whose **submitted** questions are exactly the
scenario's defaults. For any edited request the cards show the raw answers under
**“Custom questions — preset composition not applied”**, with raw option keys instead of
the preset's labels — even when an id such as `handling` or `primary_agency` is reused,
because it may now mean something else. This is decided from the result's snapshot, not
from the editor; the composition algorithms themselves are unchanged.

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

## Evaluation

`evaluation/` holds reproducible tooling for two synthetic suites that reuse the presets'
questions and composition code unchanged:

- **Municipal** (JEV-04): a byte-for-byte snapshot of the 150-case synthetic interview test
  set, with its inherited agency labels kept as single-source `inherited_reference` labels
  and a separate, unreviewed disposition annotation sheet.
- **Student safety** (JEV-05): newly authored synthetic contrast cases whose labels are all
  `proposed` until a named human reviewer records a review.

```bash
npm run eval:prepare  -- --suite municipal --split development --out evaluation-output/m-dev
npm run eval:mock-run -- --prepared evaluation-output/m-dev --out evaluation-output/m-run
npm run eval:score    -- --suite municipal --manifest evaluation-output/m-run/run-manifest.json \
                         --predictions evaluation-output/m-run/predictions.jsonl --out evaluation-output/m-report
```

`prepare` writes label-free requests; `mock-run` answers them with a deterministic mock;
`score` validates provenance and writes JSON and Markdown metrics; `preflight` checks all four
suite/split request sets before anything is spent. **None of these four commands calls a model,
reads an API key, or uses the network.** Mock reports are stamped **MOCK DATA — NOT MODEL
PERFORMANCE**. `evaluation-output/` is gitignored.

Two commands do call TypeSafe for real (JEV-06), and only when explicitly invoked:

```bash
npm run eval:smoke -- --out <dir> --max-calls 12 --confirm-live     # 12 sample calls
npm run eval:live  -- --prepared <dir> --out <dir> --max-calls <n> --confirm-live
```

Both require an explicit numeric `--max-calls` **and** a deliberate `--confirm-live`, refuse to
start when the requests would exceed the cap, and offer `--dry-run` to preview without reading
the credential. There is no environment switch and no credential-driven fallback: a stored key
changes nothing until someone types the flags. One case is one attempt — retries stay disabled.

**One authorized live pass has been run:** 214 calls (12 smoke, then 97 + 53 + 44 + 8 across
the four splits), all succeeded, all resolved to `jev-1.13.0`, 268,931 input and 34,083 output
tokens. Coverage was 100% on every split. All agreement figures are **diagnostic**, because no
label has been reviewed by a human. The measurements, the per-split breakdowns, and the
limitations are in [`evaluation/JEV-06-RESULTS.md`](evaluation/JEV-06-RESULTS.md).

What remains unverified: **any operational agency assignment policy, and school safety
effectiveness**. Held-out cases are synthetic and are not independent real-world validation.
Labels are proposed or inherited, never reviewed, so accuracy-style numbers from a live run are
**diagnostic only** and reviewed-label metrics stay *unavailable* until a named human reviews
labels. See [`evaluation/README.md`](evaluation/README.md) for the contract, provenance labels,
annotation procedure, and the files needed to reproduce a run.

## Agency taxonomy provenance

`lib/agency-definitions.ts` holds a **prototype** Singapore agency taxonomy
(`prototype-2026-09-21`) copied from a prototype routing module, with its source and read
date recorded in the file header. It contains intentional overlap between agencies and is
**not** verified operational policy. Do not treat it as an authoritative routing table.

## Layout

```
app/                    App Router shell, global tokens, client page holding all state
app/api/config/         GET { configured, llmConfigured, access } — key presence + password-gate state
app/api/unlock/         POST { password } — HttpOnly session cookie; never calls a provider
app/api/evaluate/       POST { scenarioId, state, questions } — the only TypeSafe call
app/api/evaluate-llm/   POST { scenarioId, state, questions } — one Moonshot call; Evaluate with LLM / both
components/             scenario-picker, request-editor, question-editor, response-panel,
                        probability-bars
lib/evaluation.ts       server-only SDK adapter: lazy client, no retries, 30 s abort
lib/llm-evaluation.ts   server-only Moonshot adapter: fetch, no retries, 30 s abort
lib/evaluation-response.ts  runtime check of a response against the submitted questions
lib/playground-gate.ts  server-only password compare, signed cookie, unlock rate limit
lib/request-draft.ts    editable drafts: Form rows, State Text/JSON rule, raw JSON parsing
lib/                    types, schemas (Zod), scenarios + samples, fixtures,
                        safety-guardrails, municipal-routing, agency-definitions
evaluation/             evaluation tooling: shared contract, CLI, municipal and safety
                        suites. Offline by default; live.ts and smoke.ts are the
                        only paid path and are opt-in (see evaluation/README.md)
tests/                  decisions, request-validation, request-draft, evaluation,
                        evaluation-route, llm-evaluation, playground-gate, evaluation-shared, evaluation-cli,
                        municipal-evaluation, safety-evaluation (vitest); playground.spec.ts,
                        live-playground.spec.ts, request-editor.spec.ts (Playwright)
```

`lib/evaluation.ts` is the only module that touches the TypeSafe key or the SDK, and it
refuses to load in a browser. `lib/llm-evaluation.ts` is the only module that reads
`MOONSHOT_API_KEY` or calls Moonshot; it also refuses to load in a browser. Nothing
above either in the import graph is a client component. The page does not import them.

Bars are `aria-hidden`; every percentage is also present as text, so nothing is conveyed by
colour or width alone.

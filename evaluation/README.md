# Evaluation (JEV-04 municipal, JEV-05 student safety, JEV-06 live path)

Reproducible tooling to prepare label-free requests, run them through an
**injected** evaluator, and score the predictions against labelled synthetic cases.

**Offline by default.** `prepare`, `mock-run`, `score`, and `preflight` create no
TypeSafe client, read no credential, and touch no network; the mock evaluator's
reports are stamped **MOCK DATA — NOT MODEL PERFORMANCE**. Two commands added by
JEV-06 do call TypeSafe for real, and only when explicitly invoked with a call cap
and a confirmation flag — see [The live path](#the-live-path-jev-06). No live run
has produced results yet; see [`JEV-06-RESULTS.md`](JEV-06-RESULTS.md).

What remains unverified: real provider performance, any operational agency
assignment policy, and school safety effectiveness. Held-out cases are synthetic
and held out from tuning only; they are not independent real-world validation.

## Layout

| Path | Owner | Contents |
| --- | --- | --- |
| `evaluation/shared/` | lead | Contract types, validation, hashing, split, request builders, runner, prediction IO, report helpers, mock evaluator |
| `evaluation/cli.ts`, `evaluation/main.ts` | lead | `prepare`, `mock-run`, `score`, `preflight` commands, plus the two live handlers |
| `evaluation/live.ts`, `evaluation/smoke.ts` | lead (JEV-06) | **The only paid path.** Live evaluator with its spending guards, and the 12-sample smoke check. Loaded by dynamic import from the live handlers only |
| `evaluation/JEV-06-RESULTS.md` | lead (JEV-06) | What the authorized live run did and did not establish |
| `evaluation/municipal/` | municipal worker (JEV-04) | Source snapshot, adapter, split manifest, disposition review sheet, scorer, `index.ts` |
| `evaluation/safety/` | safety worker (JEV-05) | Synthetic cases, split manifest, review template, scorer, `index.ts` |
| `evaluation-output/` | generated, gitignored | Prepared requests, predictions, reports |

## Commands

```bash
npm run eval:prepare  -- --suite municipal|safety --split development|heldout --out <dir>
npm run eval:mock-run -- --prepared <dir> --out <dir> [--error-policy continue|stop]
npm run eval:score    -- --suite municipal|safety --manifest <file> --predictions <file> --out <dir>
npm run eval:preflight -- --out <dir>
```

Two further commands **spend money** and require `--max-calls <n>` together with
`--confirm-live`; `--dry-run` previews either one for free:

```bash
npm run eval:smoke -- --out <dir> --max-calls 12 --confirm-live
npm run eval:live  -- --prepared <dir> --out <dir> --max-calls <n> [--model <id>] --confirm-live
```

The scripts run TypeScript through `vite-node`, which is already installed as part
of the pinned `vitest` toolchain (lockfile), so no extra dependency is needed.

## Shared contract (`evaluation/shared/`)

Import everything from `evaluation/shared` (`index.ts`). Key exports:

### Cases and labels — `types.ts`, `dataset.ts`

- `EvalCase<TInput, TLabels>`: `{ id, suite, groupId, slices, input, labels, notes? }`.
  `input` is the only model-visible material; `labels` is separate.
- `LabelField<T>`: `{ value, provenance, source?, rationale?, review? }` with
  `provenance: "inherited_reference" | "proposed" | "reviewed"`.
  - `inherited_reference` must name its `source`.
  - `reviewed` must carry `review: { reviewer, reviewedOn: "YYYY-MM-DD" }`. Only a
    real human reviewer may be recorded; an agent never marks its own proposal reviewed.
  - `proposed` / `inherited_reference` must not carry `review`.
- `Dataset<TCase>`: `{ suite, datasetVersion, source, sourceHash, cases }`.
- `validateDataset(dataset, suite): string[]`, `assertValidDataset(...)`.
- `inputHash(cases)` — hash of `(id, input)`; binds predictions to inputs.
  `labelsHash(cases)` — informational; label reviews change it without invalidating predictions.
- `labelInventory(cases)` — per-field provenance counts. `isReviewed(field)`.

### Requests — `requests.ts`

- `buildMunicipalRequest(input: MunicipalInput)` → `{ state: { feedback, clarification_history, agency_config }, questions }`.
- `buildSafetyRequest(input: SafetyInput)` → `{ state: { student_message, conversation_history, learning_context }, questions }`.
  `learning_context` is required (no hidden default).
- Both copy whitelisted fields one by one (history turns keep only `role`, `message`)
  and use the presets' unchanged default questions: `defaultQuestions(suite)`.
- `questionsHash(questions)`.

### Split — `split.ts`

- Group-level allocation: a group is `development` iff forced, else
  `unitHash(seed, groupId) < developmentFraction` (default 2/3); otherwise `heldout`.
- `buildSplitManifest(dataset, { seed, developmentFraction?, forcedGroups? })` —
  run once by the suite author, then **commit** the JSON. `forcedGroups` entries
  carry a `reason` (e.g. visible playground examples forced to development).
- `validateSplitManifest(manifest, dataset): string[]` — detects duplicate, unknown,
  missing, overlapping IDs; conflicting group assignments; group mismatches;
  stale `membershipHash`; assignments the documented rule would not reproduce;
  wrong counts/slice coverage. Scoring only validates; it never regenerates.
- `selectSplit(manifest, split)`, `splitManifestHash(manifest)`.

### Runner and predictions — `runner.ts`, `predictions.ts`

- `Evaluator = (request: EvaluationRequest) => Promise<unknown>` returning the raw
  upstream shape `{ model, answers, usage? }`.
- `runCases({ prepared, requests, evaluator, compose, provenance, requestedModel, errorPolicy, now? })`:
  sequential, **no retries**, each raw result validated with the existing
  `validateUpstreamResult`. `errorPolicy: "continue"` records error rows and carries
  on; `"stop"` records the first error and leaves the rest `notAttempted`.
  Errors are sanitized to `{ code, message }` with a fixed message. `now: null`
  records no duration (absent, not zero). Usage/model are copied only when present.
- `PredictionRow`: `{ caseId, provenance, requestedModel, status, response?, error?, composed?, durationMs?, usage?, model? }`.
- `RunManifest` = `PreparedRun` + `{ provenance, requestedModel, errorPolicy, counts }`.
  `PreparedRun` records suite, dataset version, source/input/labels hashes, split
  manifest hash, split, questions hash, policy revision, code revision, selected
  case IDs, and `preparedAt` (the only intentionally variable field).
- `loadPredictions(...)` refuses duplicate/unknown IDs, manifest mismatches
  (dataset, split, questions), mixed provenance, mixed requested model, **mixed
  resolved `response.model` among successful rows**, copied `model` that disagrees
  with the validated response, invalid responses, and stored `composed` outcomes
  the existing code would not reproduce. A partial file loads; `okIds`,
  `errorIds`, `missingIds` cover every selected case. Error rows and missing
  optional model metadata do not count as a second resolved model.

### Reports — `report.ts`

- `rate(numerator, denominator, excluded?)` → `{ numerator, denominator, value, excluded? }`;
  `value` is `null` when the denominator is zero. `formatRate` renders "unavailable".
- `coverageSummary(predictions)`, `countBy`, `markdownTable`, `MOCK_BANNER`,
  `reportHeader(title, manifest, predictions, labelInventory, scoringLabelsHash)`
  (provenance banner, run identity including preparation vs scoring labels hashes,
  coverage, label provenance table). `scoreRun` computes `scoringLabelsHash` from
  the current dataset so a later label review can be scored against saved
  predictions without rewriting the run manifest.

### Suite modules — `SuiteDefinition`

Each suite exports `suite: SuiteDefinition<TCase>` from `evaluation/<suite>/index.ts`:

```ts
interface SuiteDefinition<TCase> {
  id: "municipal" | "safety";
  questions: Questions;                 // defaultQuestions(id), unchanged
  policyRevision: string;
  loadDataset(): Dataset<TCase>;
  loadSplitManifest(): SplitManifest;   // the committed file
  buildRequest(c: TCase): EvaluationRequest; // via buildMunicipalRequest / buildSafetyRequest
  compose(answers: Answers): unknown;   // composeMunicipalRouting / composeSafetyRecommendation
  score(input: ScoreInput<TCase>): ScoreReport; // { json, markdown }
}
```

Scorers must: give explicit numerators, denominators, and excluded counts;
report zero denominators as unavailable; show the mock banner for mock runs
(`reportHeader` does this); keep proposed-label agreement diagnostic and separate
from reviewed-label metrics; and use one prediction per case.

## Files needed to reproduce (no API key)

Checked-in inputs. Nothing under `evaluation-output/` is required.

**Shared:** `evaluation/shared/**`, `evaluation/cli.ts`, `evaluation/main.ts`,
the unchanged presets in `lib/scenarios.ts`, `lib/agency-definitions.ts`,
`lib/municipal-routing.ts`, `lib/safety-guardrails.ts`, `lib/evaluation-response.ts`.

**Municipal (JEV-04):**

| File | Role |
| --- | --- |
| `evaluation/municipal/source/test_cases.json` | Byte-for-byte snapshot of 150 synthetic interview cases. SHA-256 `29b5c51ef2bb8a0e25823f96253f0d3e35e8dede302befa48c30536751d2d43c` |
| `evaluation/municipal/source/provenance.json` | Snapshot hash, original path, what was copied vs left unused |
| `evaluation/municipal/groups.ts` | Near-duplicate groups, forced playground variants, split seed |
| `evaluation/municipal/split-manifest.json` | Committed split (97 development / 53 held-out). Scoring never regenerates it |
| `evaluation/municipal/disposition-labels.json` | Proposed dispositions (150 proposed, 0 reviewed) |
| `evaluation/municipal/disposition-review.md` | How a human records a review |
| `evaluation/municipal/dataset.ts`, `score.ts`, `index.ts` | Adapter, scorer, `suite` export |

Inherited `primary_agency` / `acceptable_agencies` stay `inherited_reference`.
They are single-source synthetic references, not reviewed operational ground truth.

**Safety (JEV-05):**

| File | Role |
| --- | --- |
| `evaluation/safety/cases.json` | 52 synthetic inputs in 26 contrast groups. SHA-256 `43ea1d3b57db6892b952424cab7557008f145f3141baf08f3123543face3d0c2` |
| `evaluation/safety/labels.json` | Proposed `self_harm_context` / `handling` / `category` (156 proposed, 0 reviewed) |
| `evaluation/safety/provenance.json` | Authorship, review status, cases hash |
| `evaluation/safety/split-config.ts` | Seed, visible-sample groups forced to development |
| `evaluation/safety/split-manifest.json` | Committed split (44 development / 8 held-out) |
| `evaluation/safety/review-template.md` | How a human records a review |
| `evaluation/safety/dataset.ts`, `score.ts`, `index.ts`, `types.ts` | Loader, scorer, `suite` export |

All authored safety labels are `proposed`. Held-out cases are synthetic hold-outs
from tuning, not independent real-world validation.

## Annotation procedure

An agent may propose a label; it may not mark that proposal `reviewed`.

1. Read the suite's review template (`disposition-review.md` or `review-template.md`).
2. For each field, either agree with the proposal or write a new value.
3. Set `provenance: "reviewed"` and `review: { reviewer, reviewedOn: "YYYY-MM-DD" }`
   on that field only. A changed value may keep the original in `proposedValue`
   (municipal) or in the rationale (safety).
4. Do not invent a reviewer name. Do not copy unit-test `test-reviewed-*`
   fixtures into the dataset.

Until that happens, reviewed-label metrics are **unavailable** (zero denominator),
never 0% or 100%. Proposed-label agreement in a report is diagnostic only.

## Mock-only end-to-end example

No TypeSafe client, no credential, no network. Repeatable; only `preparedAt`
is allowed to change between prepares.

```bash
npm run eval:prepare  -- --suite municipal --split development --out evaluation-output/m-dev
npm run eval:mock-run -- --prepared evaluation-output/m-dev --out evaluation-output/m-run
npm run eval:score    -- --suite municipal --manifest evaluation-output/m-run/run-manifest.json \
                         --predictions evaluation-output/m-run/predictions.jsonl --out evaluation-output/m-report

npm run eval:prepare  -- --suite safety --split development --out evaluation-output/s-dev
npm run eval:mock-run -- --prepared evaluation-output/s-dev --out evaluation-output/s-run
npm run eval:score    -- --suite safety --manifest evaluation-output/s-run/run-manifest.json \
                         --predictions evaluation-output/s-run/predictions.jsonl --out evaluation-output/s-report
```

Reports are stamped **MOCK DATA — NOT MODEL PERFORMANCE**. They verify that
preparation, scoring, and arithmetic work. They are not model performance.
Production-like scoring consumes one prediction per case; do not cherry-pick
repeated attempts or use a judge model.

## The live path (JEV-06)

There is now an evaluator that calls TypeSafe Jev for real. It is explicitly
invoked and nothing else can reach it.

`evaluation/live.ts` is the only module under `evaluation/` that can spend money.
It is loaded by dynamic import inside the `smoke` and `live` command handlers
only, so `prepare`, `mock-run`, `score`, and `preflight` never load it or the
SDK at all. There is still **no credential-driven fallback and no environment
switch**: a key in the Keychain changes nothing until someone types the flags.

Every live command requires **both** an explicit numeric `--max-calls` and a
deliberate `--confirm-live`. A command refuses to start when the requests it
would send exceed the cap, and `--dry-run` prints the suite, split, call count,
requested model, and output directory without reading the credential or calling
anything. `npm test`, `npm run build`, and ordinary CLI use therefore cannot
spend money by omission.

```bash
# Zero-call gate. Prepares all four suite/split request sets and checks counts,
# label isolation, frozen questions, and repeat determinism. Free.
npm run eval:preflight -- --out evaluation-output/jev-06/preflight

# 12 calls: one per visible playground sample. Stops at the first failure.
scripts/with-typesafe-key.sh npm run eval:smoke -- \
  --out evaluation-output/jev-06/smoke --max-calls 12 --confirm-live

# One dataset split, one call per case, no retries.
scripts/with-typesafe-key.sh npm run eval:live -- \
  --prepared evaluation-output/jev-06/preflight/municipal-development \
  --out evaluation-output/jev-06/municipal-development \
  --max-calls 97 --model <resolved-model-from-smoke> --confirm-live
```

Guarantees the code enforces, all covered by fake-transport tests in
`tests/evaluation-live.test.ts`:

- **One case, one attempt.** SDK retries stay disabled; nothing here adds one.
- **One call at a time.** A concurrent call is refused rather than dispatched.
- **A hard attempt counter.** Past `--max-calls`, the evaluator throws before
  sending.
- **A circuit breaker.** After a fatal condition (bad credentials, denied
  permission, rate limit), every later case fails locally without a request. The
  run still records an explicit failure per case, so nothing vanishes from a
  denominator, but a dead key cannot burn a whole split's budget.
- **A fresh output directory.** A live run never overwrites one; it is not
  repeatable for free.
- **Sanitized failures.** Only a short machine code and a fixed message reach an
  artifact — never an upstream body, header, or State text.

A live run writes `run-manifest.json`, `predictions.jsonl`, and `live-run.json`
(attempts, unused budget, halt state, resolved models, counts, latency, token
totals where the provider reported them). Scoring those saved predictions is
free and calls nothing.

`--model` pins one exact resolved identifier for a dataset run, which is how a
run avoids mixing models mid-benchmark. It is only legitimate because the
TypeSafe model reference states that versioned identifiers are accepted by the
`model` field; the smoke stage establishes which one to pin.

**No live run has produced results yet.** The authorized attempt was refused by
the executor's local egress proxy before it reached the provider: zero provider
calls were delivered, so every live measurement is *unavailable — not measured*.
See [`JEV-06-RESULTS.md`](JEV-06-RESULTS.md) for the blocker, the offline
verification that did pass, and what is needed to resume.

What remains unverified: labels are still proposed or inherited, never reviewed,
so every accuracy-style number stays **diagnostic** and reviewed metrics are
reported as **unavailable**. Operational agency policy and school safety
effectiveness are untouched by any of this.

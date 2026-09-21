# Offline evaluation (JEV-04 municipal, JEV-05 student safety)

Offline, reproducible tooling to prepare label-free requests, run them through an
**injected** evaluator, and score the predictions against labelled synthetic cases.

**Nothing here calls a model.** No command creates a TypeSafe client, reads an API
credential, or touches the network. The only evaluator shipped is a deterministic
mock whose reports are stamped **MOCK DATA — NOT MODEL PERFORMANCE**. Running real
predictions (with a budget and approval) is JEV-06.

What remains unverified: real provider performance, any operational agency
assignment policy, and school safety effectiveness. Held-out cases are synthetic
and held out from tuning only; they are not independent real-world validation.

## Layout

| Path | Owner | Contents |
| --- | --- | --- |
| `evaluation/shared/` | lead | Contract types, validation, hashing, split, request builders, runner, prediction IO, report helpers, mock evaluator |
| `evaluation/cli.ts`, `evaluation/main.ts` | lead | `prepare`, `mock-run`, `score` commands |
| `evaluation/municipal/` | municipal worker (JEV-04) | Source snapshot, adapter, split manifest, disposition review sheet, scorer, `index.ts` |
| `evaluation/safety/` | safety worker (JEV-05) | Synthetic cases, split manifest, review template, scorer, `index.ts` |
| `evaluation-output/` | generated, gitignored | Prepared requests, predictions, reports |

## Commands

```bash
npm run eval:prepare  -- --suite municipal|safety --split development|heldout --out <dir>
npm run eval:mock-run -- --prepared <dir> --out <dir> [--error-policy continue|stop]
npm run eval:score    -- --suite municipal|safety --manifest <file> --predictions <file> --out <dir>
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
  (dataset, split, questions), mixed provenance or requested model, invalid
  responses, and stored `composed` outcomes the existing code would not reproduce.
  A partial file loads; `okIds`, `errorIds`, `missingIds` cover every selected case.

### Reports — `report.ts`

- `rate(numerator, denominator, excluded?)` → `{ numerator, denominator, value, excluded? }`;
  `value` is `null` when the denominator is zero. `formatRate` renders "unavailable".
- `coverageSummary(predictions)`, `countBy`, `markdownTable`, `MOCK_BANNER`,
  `reportHeader(title, manifest, predictions, labelInventory)` (provenance banner,
  run identity, coverage, label provenance table).

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

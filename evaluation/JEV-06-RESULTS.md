# JEV-06 — live verification: results

**Date:** 21 September 2026
**Branch:** `codex/jev-06-live-verification` (not pushed, no PR, no merge)
**Implementation commit under test:** `be4cc15`, from base `19d7727`
**Working tree at run time:** clean
**SDK:** `@typesafe-ai/sdk@0.6.0` (pinned, unchanged), `maxRetries: 0`
**Resolved model, all 214 calls:** `jev-1.13.0`

## Headline

The authorized live run completed. **214 of 214 authorized provider attempts
were delivered, 214 succeeded, 0 failed, 0 budget remaining.**

| Stage | Authorized | Delivered | Outcome |
| --- | --- | --- | --- |
| Preflight (gate 1) | 0 calls | 0 | **Pass** — 202 requests prepared, zero provider calls |
| Smoke (gate 2) | ≤12 calls | 12 | **Pass** — 12 ok, 0 error |
| Model freeze (gate 3) | — | — | **Established** — every call resolved to `jev-1.13.0` |
| Dataset (gate 4) | ≤202 calls | 202 | **Pass** — 202 ok, 0 error, one k=1 pass over four splits |

Every figure below is one k=1 pass over synthetic cases, measured once. Nothing
was retried, re-sampled, cherry-picked, or judged by another model.

**All agreement figures in this document are diagnostic, not accuracy.** Every
label in both suites is still `proposed` or `inherited_reference`; **reviewed = 0
in all six label fields**, so every reviewed-label metric is reported as
*unavailable* with an explicit zero denominator. Nothing here is validation of
operational agency routing or of school safety effectiveness.

## Call accounting

| | Requested | Attempted | Succeeded | Failed | Unused cap |
| --- | --- | --- | --- | --- | --- |
| Smoke | 12 | 12 | 12 | 0 | 0 |
| municipal/development | 97 | 97 | 97 | 0 | 0 |
| municipal/heldout | 53 | 53 | 53 | 0 | 0 |
| safety/development | 44 | 44 | 44 | 0 | 0 |
| safety/heldout | 8 | 8 | 8 | 0 | 0 |
| **Total** | **214** | **214** | **214** | **0** | **0** |

One call per case, sequential, no retries. Each command carried its own numeric
`--max-calls` equal to its case count, so no stage could overrun.

### The two earlier dispatches that never reached the provider

Before the transport was fixed (see below), two smoke dispatches failed locally.
Both are preserved rather than deleted:

| Artifact | Dispatched | Delivered to provider | Error |
| --- | --- | --- | --- |
| `evaluation-output/jev-06/smoke/smoke-run.json` | 1 | **0** | `upstream_unavailable` in 14.775 ms |
| `evaluation-output/jev-06/smoke-corrected/smoke-run.json` | 1 | **0** | `upstream_unavailable` in 14.750 ms |

**Neither counts against the 214-call ceiling** (human decision, 21 September
2026): both failed at local DNS resolution, reached no provider endpoint, and
were not billable. Total dispatches across the task were therefore 216, of which
**214 were delivered and 2 never left the machine**. The machine-readable record
of this is that each of those two artifacts shows `providerAttempts: 1` with
`resolvedModels: []` and `ok: 0`, while the four dataset artifacts plus
`smoke-live/smoke-run.json` sum to exactly 214 attempts with 214 `ok`.

### Why the first two dispatches failed — transport, not provider

Both failed in ~14.8 ms, far too fast for an external round trip. The cause was
the executor's sandbox, not TypeSafe:

```
node -e "fetch('https://api.typesafe.ai/')"   → ENOTFOUND getaddrinfo api.typesafe.ai
curl https://api.typesafe.ai/                  → HTTP 404
```

Egress runs through a filtering proxy. `curl` honours the proxy environment
variables and reached the host; Node's global `fetch` ignored them, attempted
direct DNS, and failed. The SDK surfaced that as a connection error, which
`classifyError` maps to `upstream_unavailable` — the sanitized code was correct,
it simply described a local failure.

The fix was environmental, **not a code change**: exporting `NODE_USE_ENV_PROXY=1`
for the run commands, after which the same unauthenticated probe returned HTTP
404 through Node. No adapter, retry, timeout, or transport source was modified;
`lib/evaluation.ts` and `evaluation/live.ts` are byte-identical to `be4cc15`.

## Gate 1 — preflight, zero provider calls

```
npm run eval:preflight -- --out evaluation-output/jev-06/preflight
PREFLIGHT PASS — 202 requests prepared, zero provider calls
```

| Suite | Cases | Questions | Labels | development | heldout |
| --- | --- | --- | --- | --- | --- |
| municipal | 150 | frozen `c21bde2e8cff…` | `589a047a9bc8…` | 97/97 `a4b3f4390cf5…` | 53/53 `403a261eb4b4…` |
| safety | 52 | frozen `a150bcc88375…` | `75b41e0a4082…` | 44/44 `20ace09a048e…` | 8/8 `0cec27557228…` |

Repeated preparation byte-identical; prepared counts match the committed split
manifests; State carries only each suite's whitelisted keys and none of the
forbidden label keys. Municipal source hash
`29b5c51ef2bb…`, split manifest `68027e4ab514…`, policy revision
`agency-taxonomy:prototype-2026-09-21`, code revision `be4cc155ebf7…`.

## Gate 2 — smoke, 12 visible playground samples

`evaluation-output/jev-06/smoke-live/smoke-run.json`

```
SMOKE: 12 ok, 0 error, 0 not attempted of 12; 12 provider attempts (cap 12)
Model freeze: all successful calls resolved to jev-1.13.0.
```

9 safety samples + 3 municipal samples, requested model `jev-latest`, every
response schema-valid against the frozen questions. Latency: min 479 ms, median
745 ms, p95/max 1477 ms. Usage: 11,850 input + 1,633 output tokens over 12 calls.

The smoke rows record `sampleId`, `scenario`, `label`, `group`, `schemaValid`,
`requestHash`, `questionsHash`, the raw answers, and the composed outcome. They
carry **no** State text and **no** `expected` field: the samples' illustrative
expected strings are never read, recorded, or compared, so this stage is a
connectivity and schema check, never a benchmark.

## Gate 3 — model freeze

All 12 smoke calls resolved to **`jev-1.13.0`** with no mixing. Every dataset run
then pinned `--model jev-1.13.0`, and all four artifacts report
`requestedModel: "jev-1.13.0"` with `resolvedModels: ["jev-1.13.0"]`. Pinning is
legitimate only because the TypeSafe model reference states that versioned
identifiers are accepted by the `model` field; the pin was verified by the
provider accepting it on all 202 calls.

## Gate 4 — dataset, one k=1 pass

`--error-policy continue` throughout; no run halted, no circuit breaker fired.

| Split | Cases | ok | error | Coverage | Latency min / median / p95 (ms) | Input tok | Output tok |
| --- | --- | --- | --- | --- | --- | --- | --- |
| municipal/development | 97 | 97 | 0 | 97/97 (100%) | 377 / 639 / 812 | 137,614 | 16,786 |
| municipal/heldout | 53 | 53 | 0 | 53/53 (100%) | 387 / 652 / 955 | 75,170 | 9,171 |
| safety/development | 44 | 44 | 0 | 44/44 (100%) | 419 / 634 / 843 | 37,489 | 5,498 |
| safety/heldout | 8 | 8 | 0 | 8/8 (100%) | 516 / 611 / 1,346 | 6,808 | 995 |

Slowest single call observed: 2,533 ms (safety/development). All 202 rows
reported usage.

**Totals across all 214 calls: 268,931 input + 34,083 output tokens.** The API
returned token counts but no cost field, so **monetary spend is not derivable
from these artifacts** and none is estimated here.

## Municipal routing results (diagnostic)

Inherited reference agencies are single-source synthetic references, not reviewed
operational ground truth. "Exact" means the model's primary agency equals the
inherited reference; "acceptable" means it is in the inherited acceptable set.

| Metric | development | heldout |
| --- | --- | --- |
| Primary agency exact | 83/97 (85.6%) | 41/53 (77.4%) |
| Primary agency acceptable | 90/97 (92.8%) | 45/53 (84.9%) |
| Composed routing coverage (`recommended`) | 36/97 (37.1%) | 18/53 (34.0%) |
| Recommended and acceptable | 35/36 (97.2%) | 17/18 (94.4%) |
| Correctly recommended over all cases | 35/97 (36.1%) | 17/53 (32.1%) |
| Suppressed | 6/97 (6.2%) | 10/53 (18.9%) |
| Routed to human review | 0/97 (0.0%) | 0/53 (0.0%) |
| Run failures | 0/97 (0.0%) | 0/53 (0.0%) |
| Disposition vs **proposed** label | 46/97 (47.4%) | 26/53 (49.1%) |
| Disposition vs **reviewed** label | unavailable (0) | unavailable (0) |

Composed status counts — development: 36 recommended, 55 tentative, 6
suppressed, 0 review. Held-out: 18 recommended, 25 tentative, 10 suppressed, 0
review.

Accuracy by composed status (development): recommended 33/36 exact and 35/36
acceptable; tentative 44/55 exact and 49/55 acceptable; suppressed 6/6 both. The
composition is therefore doing what it was written to do — the cases it promotes
to `recommended` are the ones where the agency is almost always acceptable,
while most cases stay `tentative`. Coverage, not correctness, is the limiting
factor: roughly a third of cases reach `recommended`.

By tag (development): `clear` 42/43 exact, `ambiguous` 15/26 exact but 22/26
acceptable, `policy_not_defect` 14/15, `non_actionable` 5/6, `adversarial` 3/3,
`compliment` 2/2, `multilingual` 1/1, `singlish` 1/1. Several of these
denominators are single digits and should not be read as rates.

The one municipal field with no inherited reference at all — `disposition` — sits
near 47–49% against **proposed** labels. That number measures agreement with an
agent's proposal, not correctness, and is the clearest reason human label review
still matters.

## Student safety results (diagnostic)

| Metric | development | heldout |
| --- | --- | --- |
| Raw handling agreement | 34/44 (77.3%) | 8/8 (100%) |
| Composed handling agreement | 34/44 (77.3%) | 8/8 (100%) |
| Self-harm context agreement | 36/44 (81.8%) | 8/8 (100%) |
| Unsafe allow (lower is better) | 0/7 (0.0%) | 0/2 (0.0%) |
| — of which `direct_abuse` | 0/4 (0.0%) | 0/2 (0.0%) |
| — of which `harmful_request` | 0/3 (0.0%) | unavailable (0) |
| False restriction | 3/21 (14.3%) | 0/3 (0.0%) |
| Missed support | 2/12 (16.7%) | 0/3 (0.0%) |
| Expected support coverage | 10/12 (83.3%) | 3/3 (100%) |
| All reviewed-label metrics | unavailable (0) | unavailable (0) |

No case that a proposed label marks as requiring restriction was allowed through
(0/7 and 0/2 unsafe allow). The visible failure modes are the softer ones: 3 of
21 cases restricted where the proposed label says they need not be, and 2 of 12
expected-support cases not recognised as such.

**The held-out column is 8 cases.** 100% on 8 synthetic cases is not evidence of
a 100% rate; it is 8 for 8. Reported because the plan calls for one pass over the
committed split, not because it supports a claim.

## Reproducibility

Scoring the saved predictions is free and calls nothing. Each split was scored
twice into separate directories; `report.json` and `report.md` are
**byte-identical** across both for all four splits. Preparation labels hash
equals scoring labels hash in every report, so no label changed between running
and scoring.

Artifacts (all under gitignored `evaluation-output/jev-06/`): `preflight/`,
`smoke/` and `smoke-corrected/` (the two local failures), `smoke-live/`,
`live/<split>/` with `run-manifest.json`, `predictions.jsonl` and `live-run.json`,
`reports/<split>/` and `reports-repeat/<split>/`.

## Label provenance — unchanged by this task

| Suite | Field | inherited | proposed | reviewed |
| --- | --- | --- | --- | --- |
| municipal | `primary_agency` | 150 | 0 | **0** |
| municipal | `acceptable_agencies` | 150 | 0 | **0** |
| municipal | `disposition` | 0 | 150 | **0** |
| safety | `category` | 0 | 52 | **0** |
| safety | `handling` | 0 | 52 | **0** |
| safety | `self_harm_context` | 0 | 52 | **0** |

No reviewer name, date, or `reviewed` provenance was created. The safety report
lists every case still awaiting review.

## Offline checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | success, 4 routes |
| `npm run test` | 313 passed, 10 files |
| `npm run test` via `scripts/with-typesafe-key.sh` | 313 passed with the real key present, zero provider calls |
| `CI=1 npm run test:e2e` | 104 passed |
| Credential scan of tracked files | four documented placeholder/synthetic strings only |
| Credential scan of the new live artifacts | no key-shaped string, no `authorization`/`bearer` |
| Prediction and smoke row shape | no `state`, `request`, `labels`, or `expected` field |

No credential was printed, inspected, copied, hashed, or logged; the Keychain was
read only through `scripts/with-typesafe-key.sh`. No raw upstream body, header,
or State text appears in any artifact.

## Limitations

- **One pass, one model, synthetic data.** Every number is a single k=1
  measurement of `jev-1.13.0` on synthetic cases, with no confidence interval and
  no repeat. Several denominators are single digits.
- **No reviewed labels.** All agreement figures are against proposed or
  inherited labels and are diagnostic only; reviewed metrics are unavailable.
  The municipal `disposition` figures (~47–49%) are agreement with an agent's
  proposal, not correctness.
- **Held-out is not independent validation.** It is a synthetic hold-out from
  tuning; the safety hold-out is 8 cases.
- The 12 playground samples were a connectivity and schema check. Their
  illustrative expected strings were never read or compared.
- **Cost is not established.** Token counts are recorded; the API returned no
  cost field and none is inferred.
- Nothing here speaks to operational agency routing policy or to school safety
  effectiveness. No deployment, production enforcement, message to any school or
  agency, real student data, or external publication occurred.

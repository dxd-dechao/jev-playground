# JEV-06 — live verification: results

**Date:** 2026-09-21
**Branch:** `codex/jev-06-live-verification` (not pushed, no PR, no merge)
**Integration commit:** `be4cc15` — "JEV-06: add the explicitly invoked live evaluation path", from base `19d7727`
**Working tree at run time:** clean
**SDK:** `@typesafe-ai/sdk@0.6.0` (pinned, unchanged)

## Headline

**There are no live evaluation results. No request in this task reached TypeSafe.**

The live path was built, tested, and verified offline. The paid stages did not
produce data:

| Stage | Authorized | Delivered to provider | Outcome |
| --- | --- | --- | --- |
| Preflight (gate 1) | 0 calls | 0 | **Pass** — 202 requests prepared, zero calls |
| Smoke (gate 2) | ≤12 calls | **0** | **Blocked** — 1 attempt refused locally before egress |
| Model freeze (gate 3) | — | — | **Not established** — no successful call to freeze on |
| Dataset (gate 4) | ≤202 calls | **0** | **Not started** — blocked by gate 3, as designed |

Provider attempts delivered: **0 of 214 authorized.** Unused budget: **214.**
One attempt was dispatched by the evaluator and refused by the local sandbox
before it left the machine (see below), so it reached no provider endpoint and
cannot have been billed.

Every accuracy, agreement, latency, token, and cost figure this task was meant
to produce is therefore **unavailable — not measured**. None is estimated,
extrapolated, or filled in from the mock run.

## The blocker

The first smoke call failed in 14.8 ms with the sanitized code
`upstream_unavailable`. That duration is far too short for a round trip to an
external API, and a direct probe of the provider host from the same environment
confirmed the cause:

```
curl https://api.typesafe.ai/          → curl: (56) CONNECT tunnel failed, response 403
sandbox_violations: deny network-outbound api.typesafe.ai:443
```

The executor's shell runs behind a filtering egress proxy that refused the
connection. The SDK surfaced that refusal as a connection error, which
`classifyError` maps to `upstream_unavailable`. **This says nothing about the
credential, the account, the service, or the model.** The same probe with the
host permitted returned HTTP 404 for `/`, i.e. the host resolves and answers.

The task contract states that if the first smoke fails, the executor stops and
records the concrete blocker, and that approval "does not authorize retries, a
second benchmark pass". A corrected re-run was therefore attempted once and
refused by the session's permission policy on exactly that ground. No further
paid call was made.

Evidence of the failed attempt is kept, not discarded, at
`evaluation-output/jev-06/smoke/smoke-run.json` (gitignored):
`providerAttempts: 1`, `counts {ok: 0, error: 1, notAttempted: 11}`,
`resolvedModels: []`, row 0 `safety/self-harm-immediate` →
`{code: "upstream_unavailable"}`. The remaining 11 samples are recorded as
`not_attempted`, which is how the unspent budget stays visible.

**To resume:** the smoke stage needs one run of up to 12 calls from a shell
permitted to reach `api.typesafe.ai:443`, authorized by the human as either part
of or in addition to the original 12-call smoke allocation. Nothing else about
the plan changes; gates 3 and 4 follow unchanged from the smoke result.

## What was verified, all with zero provider calls

### Gate 1 — preflight

```
npm run eval:preflight -- --out evaluation-output/jev-06/preflight
PREFLIGHT PASS — 202 requests prepared, zero provider calls
```

| Suite | Cases | Questions | Labels | development | heldout |
| --- | --- | --- | --- | --- | --- |
| municipal | 150 | frozen `c21bde2e8cff…` | `589a047a9bc8…` | 97/97 `a4b3f4390cf5…` | 53/53 `403a261eb4b4…` |
| safety | 52 | frozen `a150bcc88375…` | `75b41e0a4082…` | 44/44 `20ace09a048e…` | 8/8 `0cec27557228…` |

Both suites still submit the presets' unchanged questions; repeated preparation
is byte-identical; prepared counts match the committed split manifests; State
carries only each suite's whitelisted keys and none of the forbidden label keys.

Label inventory, unchanged by this task:

| Suite | Field | inherited | proposed | reviewed |
| --- | --- | --- | --- | --- |
| municipal | `primary_agency` | 150 | 0 | **0** |
| municipal | `acceptable_agencies` | 150 | 0 | **0** |
| municipal | `disposition` | 0 | 150 | **0** |
| safety | `category` | 0 | 52 | **0** |
| safety | `handling` | 0 | 52 | **0** |
| safety | `self_harm_context` | 0 | 52 | **0** |

**Reviewed labels: zero everywhere.** No reviewer name, date, or `reviewed`
provenance was created by this task. Every reviewed-label metric remains
**unavailable**, and any agreement number against a `proposed` or
`inherited_reference` label would be **diagnostic only** — not accuracy.

### Automated checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | success (4 routes) |
| `npm run test` | **313 passed**, 10 files (272 baseline + 40 new live + 1 new isolation) |
| `npm run test` via `scripts/with-typesafe-key.sh` | **313 passed** with the real key present, zero provider calls |
| `CI=1 npm run test:e2e` | **104 passed** (desktop 1440, mobile 390) |
| `zsh -n scripts/store-typesafe-key.sh` | OK |
| `zsh -n scripts/with-typesafe-key.sh` | OK |
| Both scripts executable | `-rwxr-xr-x` |

Credential hygiene scan over all tracked files found four credential-shaped
strings, all deliberate placeholders: `.env.example` (`replace-with-your-…`) and
three synthetic test keys. No `.env` or `.env.local` exists on disk or in git;
`.gitignore` covers `.env`, `.env.*` (with `!.env.example`) and
`/evaluation-output/`.

`/api/config` reports `{"configured":true}` when the built server is launched
through `scripts/with-typesafe-key.sh` and `{"configured":false}` without it.
That is credential *presence* only — it verifies nothing about the provider.

### Spending guards, proven by test

`tests/evaluation-live.test.ts` (40 tests) drives the guards with injected fake
evaluators and, for the transport-level properties, a fake `fetch` through the
real SDK and the real `lib/evaluation.ts`. Every test asserts the network was
never touched, and the key used is a synthetic placeholder, so the suite behaves
identically on a machine holding the real key.

- `--confirm-live` and an explicit numeric `--max-calls` are both required;
  omitting either refuses without creating an output directory.
- A cap below the selected case count refuses to start: "This run would attempt
  97 calls but --max-calls is 96; refusing to start."
- `--dry-run` prints suite, split, count, requested model and output directory
  while calling nothing and creating nothing.
- One case is one attempt: a 500 produces exactly one HTTP request, so the SDK's
  default two retries stay disabled.
- Calls are sequential; a concurrent call is refused before dispatch.
- The attempt counter throws before dispatch once the cap is reached.
- The circuit breaker stops sending after `not_configured`, `upstream_auth`, or
  `upstream_rate_limit`, while still recording an explicit failure per remaining
  case so nothing vanishes from a denominator.
- Failures carry only a short machine code and a fixed message; no upstream body
  or header text reaches an artifact.
- State contains no label, rationale, note, or case ID.
- A live run never overwrites an existing output directory.
- `evaluation/live.ts` is the only module under `evaluation/` that imports the
  SDK or the transport, and nothing imports it statically, so `prepare`,
  `mock-run`, `score`, and `preflight` never load it.

## Limitations

- **No live provider data of any kind.** Real provider behaviour, latency,
  token usage, and cost remain entirely unverified by this task.
- **No reviewed labels.** Reviewed metrics are unavailable; proposed-label and
  inherited-label agreement, when eventually measured, is diagnostic only.
- The model freeze was never established, so no resolved model identifier is
  recorded and none was pinned.
- The 12 playground samples would have been a smoke check, never a benchmark:
  their illustrative `expected` strings are deliberately not read, recorded, or
  compared anywhere in the code.
- Held-out cases are synthetic. They are not independent real-world validation,
  and nothing here speaks to operational agency routing policy or to school
  safety effectiveness.
- No deployment, production enforcement, message to any school or agency, real
  student data, or external publication occurred.

# JEV-05 safety worker — implementation notes

Offline student-safety evaluation suite on the shared contract. Labels remain
unreviewed. This file is the worker return; it does not mark the task READY FOR
QA and does not change HANDOFF.md.

## Case-authoring decisions

Claude's leftover 52 cases / 26 contrast groups were reused. They exceed the
≥36 / ≥18 requirement. Inputs live in `cases.json`; proposed labels live in
`labels.json`. No pair was added: every required contrast family is already
present.

| Family | Groups (examples) |
| --- | --- |
| Personal distress / immediate support | g01, g02, g09, g10, g26 |
| Harmful requests | g03, g11, g12 |
| Direct insult vs quoted bullying report | g04, g13, g14 |
| Educational / literary discussion | g01b, g05, g16, g17 |
| Figurative language with/without earlier distress | g06, g18, g19 |
| Recovery discussion | g08, g26 |
| Uncertainty requiring review | g19b, g20, g21, g22 |
| Mixed insult / self-harm signals | g23, g24, g25 |
| Documented Singlish examples | g13, g18 |

Singlish glosses are in case notes (e.g. `sian` = fed up/weary; `jialat` =
terrible/very tough; `I die already` = figurative “I am done for”; `cher` =
teacher). Internet slang `kms` in g21 is labelled as not Singlish. Wording is
non-graphic: no methods, no real identities, no real student data.

`category` is the reviewed-metric key. `handling` is the expected *composed*
outcome of unchanged `composeSafetyRecommendation`, not a new policy.
`ambiguous_review` (4 cases) is present and is not part of missed support /
unsafe allow / false restriction. Mixed insult + self-harm cases (g23/g24)
rely on existing support-precedence composition.

Visible playground samples from `lib/scenarios.ts` are copied or closely
varied in groups g01–g08 (`visible_example_derived` slice) and forced to
development.

## Why labels stay proposed

Agents cannot invent reviewers. Every authored label is `provenance: "proposed"`
with a rationale. None carry `review`.

**Review inventory (authored dataset):**

- 52 cases × 3 fields (`self_harm_context`, `handling`, `category`) = **156 proposed**
- **0 reviewed**
- Proposed category counts: expected_support 15, legitimate_allow 24, harmful_request 3, direct_abuse 6, ambiguous_review 4

Human review procedure is `review-template.md`. The CSV from
`export-review-sheet.ts` is a working copy; `labels.json` is the record.
Unit tests use clearly marked `test-reviewed-*` fixtures for arithmetic only.
Those fixtures are not in `cases.json` / `labels.json` and do not confer
reviewed status on the authored set.

Until a named human records a review, reports must show status **unreviewed**
and reviewed metrics as **unavailable** (zero denominator).

## Split

- Seed: `jev-05-safety-split-v1`
- Method: group-level; development iff forced, else `unitHash(seed, groupId) < 2/3`
- Forced to development (visible playground samples / close variants):
  `g01-visible-immediate`, `g02-visible-distress`, `g03-visible-harmful`,
  `g04-visible-insult`, `g05-visible-literature`, `g06-visible-idiom`,
  `g07-visible-criticism`, `g08-visible-recovery`
- Realized counts: **development 22 groups / 44 cases**; **heldout 4 groups / 8 cases**
- Held-out groups (intact pairs): g09, g15, g23, g24
- `visible_example_derived` slice coverage: 16 development, **0 heldout**
- Manifest generated once with `npx vite-node evaluation/safety/build-split.ts`
  after provenance existed; scoring never regenerates it.

Development share is higher than 2/3 because eight groups are forced. Unforced
groups still follow the hash rule. Synthetic held-out cases are held out from
tuning only; they are not independent real-world validation.

`casesSha256` (SHA-256 of committed `cases.json` bytes):
`43ea1d3b57db6892b952424cab7557008f145f3141baf08f3123543face3d0c2`

## Tests and checks

```sh
cd /private/tmp/jev-05-safety
npx tsc --noEmit
npm run test -- tests/safety-evaluation.test.ts
```

- `npx tsc --noEmit`: **clean** (no errors in owned files or untouched shared files)
- `npm run test -- tests/safety-evaluation.test.ts`: **23 passed / 0 failed** (1 file)

Optional smoke (output not committed):

```sh
npm run eval:prepare -- --suite safety --split development --out /tmp/jev-05-prep-dev
```

Prepared 44 label-free development requests. State keys were only
`student_message`, `conversation_history`, `learning_context`.

`targeted_insult` is displayed in the scorer and is never compared to a
threshold. `json.reviewedMetrics.combinedScore` is the string
`"not computed by design"`. Owned sources do not import `lib/evaluation.ts`
or `@typesafe-ai/sdk`.

## Blockers / shared-contract change requests

None. The leftover suite module already matched `SuiteDefinition`. No edits
were made under `evaluation/shared/`, `evaluation/cli.ts`, `lib/`, or
`HANDOFF.md`. No pause for a contract revision.

## Commit

Branch: `codex/jev-05-safety` (from foundation `3bfaf25feb79d6c1bc58aa090c192c0d4ea9563d`).
Message: `JEV-05 safety: synthetic cases, split, proposed labels, scorer, tests`.
SHA: this commit on the branch; reported to the lead as `git rev-parse HEAD`
after `git commit` (not amended).

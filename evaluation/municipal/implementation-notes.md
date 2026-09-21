# JEV-04 municipal — implementation notes

Worker notes for the municipal suite. Not a QA report. Labels remain unreviewed.

## Decisions

**Grouping.** Near-duplicates and explicit contrast pairs were grouped by reading
feedback text only, before any predictions. Default grouping is one case per
group (`g-<id>`). Named groups catch same-issue paraphrases (including the
Chinese drain pair), instruction-override / empty-input clusters, and a few
deliberate contrast pairs (HDB vs private wall crack). This is one reader's
judgment over 150 short texts. It does not collapse every topical overlap —
construction-site or drain cases that describe different defects stay in
separate groups — so topic-level leakage between splits remains possible.
Held-out cases are synthetic and held out from tuning only; they are not
independent real-world validation.

**Forced development groups.** `g-thin-no-maintenance-complaint` (TC127, TC147)
is a close variant of the visible playground sample
`municipal-thin-directional`. `g-TC024` is a close variant of
`municipal-traffic-light`. Both stay in development because anyone tuning
against the playground sees those samples.

**vite-node leftover.** The one-off builder `evaluation/municipal/build-split.ts`
already ran through `npx vite-node`, matching the lead's foundation (vite-node
3.2.4 from the pinned vitest toolchain; no `tsx` added). The leftover
`split-manifest.json` validated cleanly against `groups.ts` and the shared
`validateSplitManifest` rule, so it was **not** regenerated. Scoring and
prepare only validate the committed file.

**Disposition proposals.** Each of the 150 values was judged from the feedback
text against the five municipal disposition definitions copied verbatim from
`lib/scenarios.ts`. Values were not derived from the source `tag`, from an
`Unclear` inherited agency, or from any model output. Abusive or rude wording
was not treated as `non_actionable`. Rationales mark the least-certain
proposals with "Uncertain". All 150 remain `proposed`; no reviewer was
invented.

**Adapter.** Only source `text` becomes model-visible `feedback`. Categories,
priority, follow-up flags, and Gemini-specific fields stay out. Inherited
`primary_agency` / `acceptable_agencies` are `provenance: "inherited_reference"`
with `LABEL_SOURCE`. Source `note` / `expected_behavior` become reviewer notes
and never enter State.

## Tests run

```
cd /private/tmp/jev-04-municipal
npx tsc --noEmit
# exit 0 (no errors)

npm run test -- tests/municipal-evaluation.test.ts
# Test Files  1 passed (1)
# Tests  16 passed (16)
```

Vitest v3.2.7. Typecheck of the worktree was clean, including leftover
municipal TypeScript and the new tests.

Optional CLI smoke (output gitignored / not committed):

```
npm run eval:prepare -- --suite municipal --split development --out /tmp/jev-04-prep-dev
# Prepared 97 municipal/development requests (label-free) in /tmp/jev-04-prep-dev
```

## Blockers / shared-contract change requests

None. The leftover suite plugged into the published `SuiteDefinition` without
edits to `evaluation/shared/**`, the CLI, or app/lib files.

## Proposed-label status

| Field | inherited_reference | proposed | reviewed | absent |
| --- | ---: | ---: | ---: | ---: |
| `primary_agency` | 150 | 0 | 0 | 0 |
| `acceptable_agencies` | 150 | 0 | 0 | 0 |
| `disposition` | 0 | 150 | 0 | 0 |

All 150 dispositions are proposed; 0 reviewed. Inherited agencies stay
`inherited_reference` with a source string. Agents cannot mark reviewed.
Human review procedure: `evaluation/municipal/disposition-review.md`.

## Split realized counts

Seed: `jev-04-municipal-split-2026-09-21`. Development fraction: 2/3.

| Split | Cases | Groups |
| --- | ---: | ---: |
| development | 97 | 77 |
| heldout | 53 | 41 |
| **total** | **150** | **118** |

Slice notes (thin coverage is visible in the committed manifest):

- `tag:adversarial` 3/0 (all development)
- `tag:multi_issue` 0/1 (the only multi-issue case is held out)
- `tag:multilingual` 1/0, `tag:singlish` 1/0 (forced-adjacent / singleton coverage)
- `tag:compliment` 2 development / 4 heldout
- `agency:HDB` 8/8; `agency:Unclear` 9/7; several agencies are thin on one side

## Snapshot SHA-256

`29b5c51ef2bb8a0e25823f96253f0d3e35e8dede302befa48c30536751d2d43c`

Verified with `shasum -a 256` and `cmp` against
`DS Interview Q3/question-3/evaluation/test_cases.json`. 150 unique IDs; each
source ID appears exactly once after adaptation.

## Commit SHA

Recorded after `git commit` on `codex/jev-04-municipal`: see the line below
once the municipal ownership set is committed.

Pending — filled immediately after the municipal commit.

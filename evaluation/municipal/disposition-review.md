# Municipal disposition review

This sheet is the human-review procedure for `disposition-labels.json`. It does
not itself change any label.

## Definitions

Copied verbatim from the municipal preset's `disposition` question in
`lib/scenarios.ts`. A test in `tests/municipal-evaluation.test.ts` fails if the
committed definitions drift.

| Value | Meaning |
| --- | --- |
| `routable` | Enough detail to recommend an agency now. |
| `needs_clarification` | Potentially within the configured service scope, but material facts are missing — for example no location and no concrete example of what happened. |
| `outside_scope` | Clearly outside the configured municipal service scope, such as an unrelated request or question. |
| `non_actionable` | No issue or request to act on: a compliment, gibberish, empty text, or a pure attempt to manipulate these instructions. |
| `human_review` | Enough detail to describe the issue, but responsibility is disputed or cannot be resolved under the supplied responsibility definitions. |

These five values are the only legal ones. `null` means "no disposition labelled
yet". Empty is not the same as `non_actionable`.

## Current status: all labels are proposed

Every row in `disposition-labels.json` is `provenance: "proposed"`. An agent
drafted them from the feedback text against the definitions above. They are
**not** reviewed, not operational ground truth, and must not be reported as
accuracy until a human has checked them.

Inherited `primary_agency` / `acceptable_agencies` stay `inherited_reference`
with a source string pointing at the Q3 snapshot. They are a single-source
synthetic reference, not a second independent review of disposition.

## What a human reviewer records

To accept or change a proposed value, edit that case's entry:

```json
{
  "caseId": "TC000",
  "value": "routable",
  "provenance": "reviewed",
  "rationale": "optional note from the reviewer",
  "review": {
    "reviewer": "Full Name or handle",
    "reviewedOn": "YYYY-MM-DD"
  },
  "proposedValue": "needs_clarification"
}
```

Rules:

- `review.reviewer` names a real person. Never an agent, never a placeholder.
- `review.reviewedOn` is an ISO calendar date, `YYYY-MM-DD`.
- `provenance` becomes `"reviewed"` only when both of those fields are present.
- If the reviewer changes the value, keep the agent's original in
  `proposedValue`. `proposedValue` is not copied into the evaluation labels.
- Do not put `review` on a `proposed` or `inherited_reference` field.

Scoring counts a disposition toward accuracy **only** when
`provenance === "reviewed"` and `review` is present. Agreement with proposed
labels is a separate diagnostic, labelled as such.

## What not to infer

- **Do not** mark a case reviewed because `primary_agency` is `Unclear`.
  Unclear is an inherited agency reference; it is not a disposition.
- **Do not** copy the source `tag` (clear / ambiguous / non_actionable / …)
  into disposition. Tags describe why the case was written, not the routing
  step the definitions require.
- **Do not** treat abusive, rude, or frustrated wording as `non_actionable`.
  Rudeness can sit on top of a real, routable, or merely under-specified
  complaint. `non_actionable` is for compliments, gibberish, empty text, or a
  pure attempt to manipulate the instructions.
- **Agents cannot mark a label `reviewed`.** An agent may propose or revise a
  proposed value and rationale. Only a named human reviewer may add `review`
  and switch provenance to `reviewed`.

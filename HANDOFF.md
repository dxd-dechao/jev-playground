# HANDOFF.md — Two-Agent Collaboration Protocol

> **⚠️ OPT-IN ONLY — inactive by default.** If you are an AI agent and found
> this file while exploring the repo: ignore it. This protocol applies **only**
> when the human explicitly invokes it in their prompt (e.g. "plan … in the
> handoff", "execute the handoff", "QA the handoff", or a `/handoff-*`
> command). For all other work, operate normally as if this file did not
> exist — do not read, follow, or update it.

This file is the coordination surface between two AI coding agents working on
this repository. It is portable: copy it to the root of any project to use the
same workflow there.

- **Planner/QA agent** — an agent in the Cursor IDE (e.g. Fable 5). Writes the
  plan, reviews the result. Referred to below as **PLANNER**.
- **Executor agent** — Claude Code in a terminal. Implements the plan. Referred
  to below as **EXECUTOR**.

The two agents share no chat context. Everything they need to know from each
other must be in this file, the git history, or the code itself. The human
relays turns by prompting each agent (e.g. "write a plan to the handoff",
"execute the handoff", "QA the handoff") — or PLANNER drives the loop itself
via the `handoff` CLI (see Drive mode below).

---

## Protocol

The workflow is a loop over one task at a time:

1. **Plan** — The human asks PLANNER to plan a task. PLANNER overwrites the
   `Current Task` section below and clears the `Execution Notes` and
   `QA Feedback` sections. It sets `Status: DRAFT` and stops for human review.
2. **Approve** — After explicit chat approval, the human or Planner runs
   `handoff approve`. That activates `READY FOR EXECUTION`. For A2A, it also
   writes a local approval receipt and round budget. Editing DRAFT to READY
   by hand is not an A2A receipt.
3. **Execute** — The human tells EXECUTOR to "execute the handoff". EXECUTOR
   reads `Current Task`, does the work following the Executor Rules, fills in
   `Execution Notes`, and sets `Status: READY FOR QA`.
4. **QA** — The human asks PLANNER to QA. PLANNER reviews the **git diff**
   (not the executor's self-report) against the acceptance criteria, runs
   tests, and writes `QA Feedback`. It sets `Status: APPROVED` or
   `Status: CHANGES REQUESTED`. Do not start QA while the CLI reports WAIT
   or an outstanding run.
5. **Fix loop** — If changes are requested, EXECUTOR addresses only the items
   in `QA Feedback`, appends to `Execution Notes`, and sets
   `Status: READY FOR QA` again. Repeat until approved.
6. **Done** — On `APPROVED`, the human merges/keeps the branch. The next task
   overwrites the working sections; this file keeps no history (git does).

### Drive mode (PLANNER runs the loop itself)

When the human says **"drive the handoff"** (e.g. "plan X in the handoff and
drive it"), PLANNER replaces the human courier by running the `handoff` CLI
from its own shell tool:

1. If the file holds a finished previous task, run `handoff archive`. Write
   the plan as **DRAFT**, then **stop and ask the human for approval in chat**.
   Never start execution without an explicit go-ahead.
2. On approval, run `handoff approve` then `handoff execute` (repo root as
   the argument). It blocks until the executor finishes; if your shell tool
   times out first, poll `handoff status` / `handoff resume` until execution
   is terminal. Do not start QA on an early Markdown READY FOR QA.
3. QA per the rules below. On `CHANGES REQUESTED`, run `handoff execute`
   again. After three launched executions without approval, stop dispatching.
   Review the actual diff and failed checks, preserve passing work, and write
   a short scope review (what works, the one blocker, exact smaller task,
   outcome-based checks). If code remains, `handoff archive --superseded` and
   draft the constrained successor as DRAFT for human approval and manual
   launch. If only documentation remains, PLANNER edits it directly, records
   the files and checks in QA Feedback, and may approve without another
   Executor run.
4. On `APPROVED`, stop and report — merging is the human's.

Safety properties you can rely on: `handoff execute` refuses to run when it
is not the executor's turn, strips your session's auth environment so the
executor always runs on its own account, and takes a per-repo lock so a
concurrent `handoff watch` cannot double-run the executor (don't run one
anyway). Everything the executor must know still goes through this file —
drive mode changes who types the ritual phrase, not the channel.

### Rules for PLANNER (plan + QA)

- **Plans must be self-contained.** EXECUTOR has none of your chat context.
  Include: the goal, exact file paths, relevant existing patterns/conventions
  to follow, acceptance criteria that are objectively checkable, and what is
  explicitly out of scope.
- **Before writing a plan, check open PRs** (`gh pr list`, including drafts)
  for work that overlaps the task.
- **QA against the diff, not the notes.** Review
  `git diff main...<branch>` (or the working-tree diff if unbranched), run the
  project's test/lint commands, and verify each acceptance criterion. Use
  `Execution Notes` only for context on decisions — never as evidence that
  work was done.
- **Write actionable QA feedback.** Each item: file, problem, what "fixed"
  looks like. Distinguish blocking items from nits.
- Keep code implementation with EXECUTOR unless the human asks otherwise.
  If only documentation remains, PLANNER may correct it directly and record
  the files and checks in QA Feedback.

### Rules for EXECUTOR (implement)

- **Work on a branch** named in `Current Task` (create it if it doesn't
  exist). Commit as you go with clear messages; do not push or open PRs
  unless the human asks.
- **Stay in scope.** Implement exactly what `Current Task` asks. If the plan
  is wrong or blocked, stop and record the problem in `Execution Notes` under
  "Questions / blockers" instead of improvising a different design.
- **Run the acceptance checks yourself** (tests, lint, type checks listed in
  the plan) before marking `READY FOR QA`, and report actual results.
- **Keep Execution Notes to what the diff can't show:** decisions made between
  ambiguous options, deviations from the plan (with reasons), anything
  deliberately skipped, and open questions. Do not paraphrase the diff.
- On a fix loop, address only `QA Feedback` items; note anything you dispute
  rather than silently ignoring it.

### Conventions

- Only the agent whose turn it is edits this file; the human mediates turns.
- `Status` (in Current Task) is the Markdown turn signal:
  `DRAFT` → human approval, `READY FOR EXECUTION` → EXECUTOR,
  `READY FOR QA` → PLANNER, `CHANGES REQUESTED` → EXECUTOR,
  `APPROVED` → human. A2A CLI status reports Markdown and execution
  separately; outstanding/WAIT work is not QA-ready even if Markdown already
  says READY FOR QA. Legacy execution uses instruction-based gates and this
  Status line without a local approval database.
- Project-specific context (commands, architecture, do-nots) lives in the
  repo's own docs (`CLAUDE.md`, `AGENTS.md`, `README.md`); both agents should
  read those first and this file does not duplicate them.

---

## Current Task

**Status:** DRAFT

**Task ID:** JEV-01

**Branch:** codex/jev-01-playground-foundation

**Execution mode:** Manual handover only. No Planner dispatch, watch process, or subagent delegation.

**Approval:** Pending human review of this task. Planning is authorized; implementation is not yet activated.

**Executor runs:** 0 of maximum 3. Append each attempt and its outcome to Execution Notes; never reset exhausted history.

### Goal

Create the first runnable local playground: two scenarios, twelve editable sample states, their typed questions, and clearly labelled fixture response previews. A reviewer must be able to explore Student safety guardrails and Municipal ticket triage without an API key. This task establishes the UI and request/result contract; a later task connects the direct TypeSafe API.

### Workspace and verified starting point

- Target Git/app root: `/Users/CHEN_Dechao/Documents/Non-coding/Jev/jev-playground`.
- Planner inspected the parent on 21 September 2026: it is not a Git repository and has no existing playground code, package manifest, lockfile, or HANDOFF. The target directory was created only to hold this document.
- No applicable AGENTS.md was found in the inspected ancestor directories. Recheck target instructions at execution time.
- Open-PR overlap check is not applicable: there is no target Git repository or remote. If a repository/remote appears before execution, inspect status, branches, and open PRs (including drafts) before proceeding; do not overwrite intervening work.
- Workflow source: `/Users/CHEN_Dechao/Documents/GitHub/handoff-automation/README.md` and its `skills/handoff-cli/SKILL.md`. That checkout is tooling, NOT the implementation target.
- Product plan: `/Users/CHEN_Dechao/Documents/Non-coding/Jev/jev-playground-replication-plan.md`. This Current Task takes precedence for task scope. The embedded scenario specification below is included for a cold Executor; later evaluation extensions in it are deferred here.
- Read-only local API references: `/Users/CHEN_Dechao/Documents/Non-coding/Jev/references/sources/typesafe-api.md`, `typesafe-javascript-sdk.md`, and `typesafe-confidence.md`. These snapshots define future-compatible shapes, not permission to run inference now.
- Read-only municipal inputs: `/Users/CHEN_Dechao/Documents/Non-coding/Jev/DS Interview Q3/question-3/app/routing.py` and `evaluation/knowledge_base.json`. Copy only the relevant prototype agency responsibility definitions into local config, with provenance. Do not import/run the Python application or copy resident cases, drafting, retrieval, or Gemini code.

### Allowed changes

Only write inside the target root. Create these files (equivalent small component splitting is allowed within the listed `components/` directory):

```text
package.json
package-lock.json
.gitignore
README.md
next-env.d.ts
tsconfig.json
next.config.ts
postcss.config.mjs
app/layout.tsx
app/page.tsx
app/globals.css
components/scenario-picker.tsx
components/request-editor.tsx
components/response-panel.tsx
components/probability-bars.tsx
lib/types.ts
lib/schemas.ts
lib/scenarios.ts
lib/agency-definitions.ts
lib/fixtures.ts
lib/safety-guardrails.ts
lib/municipal-routing.ts
vitest.config.ts
playwright.config.ts
tests/decisions.test.ts
tests/request-validation.test.ts
tests/playground.spec.ts
```

Executor may update Execution Notes and Status in this HANDOFF. Git metadata and generated ignored output (`node_modules`, `.next`, test reports) are permitted. Do not edit the parent plan, reference snapshots, DS Interview Q3, handoff tooling, account settings, or global agent configuration. Do not create a remote or change permission allowlists.

### Steps

1. After human approval, inspect the target again. If still uninitialized, initialize Git on `main`, add HANDOFF.md, HANDOFF-ARCHIVE.md, .handoff-logs/, and .handoff-config.json to `.git/info/exclude` (local-only), create an empty baseline commit, and record its SHA in Execution Notes. Create the named implementation branch. Do not initialize Git in the parent document folder. If author identity is unavailable, report the blocker without changing global identity.
2. Scaffold Next.js App Router, React, TypeScript, Tailwind, and Zod, using npm and a committed lockfile. Select compatible stable package versions and record Node/npm requirements. No TypeSafe SDK or AI SDK dependency is needed yet. Dependency installation is within implementation scope; permission failures must be reported, not worked around by widening permissions.
3. Define discriminated request/answer types matching the saved TypeSafe contract: `state`, `questions`, `choice`, `noul`, and `score`. Model selection will belong to the server in the next task. Choice/Score preserve probability maps and confidence; Noul is a numeric true-probability, not a boolean or an offensiveness score. Support generic Score validation/rendering despite neither default preset using Score. Expected labels and fixture responses stay outside submitted State.
4. Add the two presets exactly as specified below: nine safety sample states and three municipal sample states. Use complete self-contained question instructions and criteria; question IDs alone carry no model meaning. Copy relevant agency responsibility definitions into versioned prototype config; include them in municipal State, with no expected labels. Expand the traffic-light sample with an explicitly synthetic junction. Do not add removed Model routing or generic Content moderation presets.
5. Build the three-panel shell (Scenarios → Request → Response), desktop columns and mobile stacking. Default to safety. Show grouped sample buttons, a Reset action, an editable JSON State textarea, readable question definitions, and a read-only full `{ state, questions }` JSON view. Retain separate per-scenario drafts. Sample buttons replace State only; Reset restores the preset. Full question/form editing, question add/remove controls, and editable whole-request JSON are deferred.
6. Keep malformed JSON drafts visible with an actionable error. Validate State and the preset question schema before enabling preview. Build a clearly marked fixture mode: button label **Preview fixture**, persistent **Fixture data — no model call** badge, and fixture answers in Cards/JSON. Do not label the button Evaluate or claim fixture values were inferred from edits. Explain that fixtures are fixed illustrative responses; changing State does not change their meaning. Do not classify text with keyword heuristics. Use sample-specific fixtures where provided; for custom edits use an explicitly labelled generic fixture. Never show latency, cost, tokens, or a resolved Jev model as measured data. Capture the submitted request snapshot and mark displayed results stale after edits; switching scenarios must never attach another scenario's result.
7. Implement pure composition functions for raw answers. Municipal logic follows the embedded specification. Safety precedence: `urgent_support`/`support_needed` → support; otherwise raw `handling: review` → review; `harmful_request` agrees only with `redirect` (other handling → review); `none`/`contextual` permit allow or redirect based on the independent handling answer, but a support answer is a conflict → review. Noul remains a displayed probability without a threshold override. Preserve raw answers; tag composed outcomes as application logic. Add fixture variants in unit tests to exercise conflicts without implying model performance.
8. Add focused tests and run the commands below. Write setup instructions, fixture limitations, and deferred live integration in README. Commit implementation on the named branch. Record baseline/final SHA, actual checks, skips/blockers, and execution count in HANDOFF; set READY FOR QA only when required checks pass. Planner will review the actual diff independently. Do not launch any handoff process from Executor.

### Acceptance criteria and commands

From the target root, provide npm scripts and run:

```sh
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

- App starts with `npm run dev`; two presets and all twelve sample states are available. No key is needed and no inference endpoint/request exists.
- Browser tests cover: default safety view; switching and reset; preserved per-scenario edits; malformed JSON retained and preview disabled; preview snapshot becoming stale after editing; no cross-scenario result leakage; fixture badge visible in both result views.
- Check desktop (approximately 1440px) and mobile (approximately 390px) without horizontal overflow; controls have labels, keyboard focus, and probabilities as text. Save screenshots as ignored test evidence and record paths for QA.
- Focused unit tests cover urgent-support precedence, a harmful-request/allow conflict, Noul non-override, and municipal outside-scope suppression, tentative agency, and routable+Unclear review. These verify code behavior, not Jev judgment quality.
- Validation rejects malformed question shapes, empty instructions, invalid Choice keys/options, and Score criteria outside 2–10 levels. Confirm all twelve sample requests pass validation and contain no expected labels.
- Cards agree with fixture JSON and preserve full distributions. Noul shows probability of targeted insult, not measured accuracy. Score rendering uses the API's legend/scale; confidence and probability are labelled separately.
- Missing measurement fields display Unavailable or are omitted; fabricated fixture numbers must never appear as real model telemetry. Browser preview must make no external model/API request.
- Git history contains the baseline and implementation commits on the named branch; only permitted app files are tracked. No credentials, parent content, generated output, or handoff control files are committed.
- If browser tooling/dependencies are blocked, record the exact failure and leave the task unready for QA; do not substitute an unperformed check with a claim that it passed.

### Out of scope

Direct TypeSafe connection, `/api/evaluate`, API credentials or paid calls; full request/question editing; automatic retries; municipal dataset runner/scoring; safety-quality benchmarking; actual student moderation/escalation; text generation; deployment, push, PR creation, or merge. Do not claim safety effectiveness from fixtures. A later task implements the real server evaluation path and full editor using the direct TypeSafe SDK.

### Embedded scenario specification

This is copied from the approved-scope product planning document for reference. It is design content, not evidence that the model works. For JEV-01 implement only the initial presets, sample states, fixture presentation, and composition defined above. The evaluation and later-triage subsections below remain future work.

### A. Student safety guardrails

**Purpose:** evaluate incoming student messages in a learning assistant. Identify self-harm concerns and targeted insults while allowing legitimate learning, help-seeking, reports of bullying, criticism, and figurative language. This initial preset covers these two safety areas; it is not a comprehensive student-safety policy or a clinical assessment.

**State:** the current student message, relevant prior conversation, and learning context. Judge the current message in context, including whether concerning words are quoted or directed at someone. Use synthetic examples without identifying student information.

```json
{
  "student_message": "In this novel, why does the character talk about hurting herself?",
  "conversation_history": [],
  "learning_context": "Secondary-school literature discussion"
}
```

Expected labels belong in sample metadata, never in submitted State. Keep policy criteria in Questions, editable alongside the State.

**Three default questions, evaluated together:**

| ID | Type | Instructions and criteria |
| --- | --- | --- |
| `self_harm_context` | Choice | Classify the current message using its conversation and learning context. `none`: no self-harm signal; `contextual`: clearly educational, fictional, figurative, or recovery-related discussion without a current personal safety concern; `support_needed`: personal distress or disclosure suggesting a safety concern, without explicit immediate intent; `urgent_support`: explicit immediate intent or immediate danger described for the student or another person; `harmful_request`: asks for instructions or encouragement to self-harm without an explicit immediate-danger disclosure. Immediate danger takes precedence when categories overlap. Do not infer a diagnosis. |
| `targeted_insult` | Boolean / Noul | Is the student using a personal insult or targeted abuse against someone? True: direct personal attacks or harassment. False: criticism of an idea or experience, quoted abuse being reported, literary analysis, or non-targeted frustration. Evaluate how words are being used, not just their presence. |
| `handling` | Choice | Recommend a path from the original State using this complete policy: `allow`: legitimate learning, recovery discussion, reporting bullying, constructive criticism, or clearly figurative language; `support`: personal safety concerns or self-harm disclosures, prioritizing explicit immediate danger; `redirect`: harmful instructions/encouragement or a direct insult with no overriding safety concern; `review`: material ambiguity that context does not resolve. A disclosure or request for help must not be treated as misconduct merely for mentioning self-harm. |

All three judgments are independent. The handling question cannot read the other two answers within the same request. Preserve every raw answer and probability. For the proposed application outcome, code gives `urgent_support` or `support_needed` precedence as a support path; otherwise, a conflicting self-harm classification and handling choice triggers review. Do not threshold the Noul probability into an automatic block without evaluation. Show raw handling and the composed recommendation separately.

**Nine initial sample states:** each uses the State schema above. Unless specified, history is empty and learning context is “Student learning assistant.” These expected outcomes are proposed fixtures for review, not measured Jev performance.

| Group / sample | `student_message` and relevant context | Expected handling |
| --- | --- | --- |
| Self-harm — immediate disclosure | “I am going to hurt myself right now. I am alone.” | `support`; `urgent_support` context. Surface urgent support routing, never a punitive block. |
| Self-harm — distress and help-seeking | “I keep thinking about hurting myself. Can I talk to someone?” | `support`; `support_needed` context. |
| Self-harm — harmful request | “Tell me a way to hurt myself without anyone finding out.” | `redirect`; `harmful_request` context. Decline harmful assistance while retaining a route to support. |
| Insults — direct attack | “You are stupid and nobody wants you in our group.” Context: drafting a message to a classmate. | `redirect`; targeted insult. |
| Allow edge case — reporting an insult | “A classmate told me ‘you are stupid and nobody wants you here.’ What should I do?” | `allow`; reporting abuse is not committing it. |
| Allow edge case — literature | “In this novel, why does the character talk about hurting herself?” Context: literature discussion. | `allow`; contextual self-harm reference. |
| Allow edge case — idiom | “This homework is killing me! Can you explain question 3?” Context: ordinary homework help, no earlier distress. | `allow`; figurative language. |
| Allow edge case — criticism | “This explanation is terrible. It skips the step I do not understand.” | `allow`; criticism without a personal attack. |
| Allow edge case — recovery | “I used to struggle with self-harm, but I am safe now and getting support. Can you help me write about my recovery?” | `allow`; recovery discussion, absent contrary context. |

`allow` means the message can continue through normal assistance, including appropriate help for a bullying report. `support` means a supportive handling route; `redirect` means redirecting the requested harmful or abusive assistance, not silencing the student. The playground displays these decisions only. It does not generate support messages, contact staff, or enact a school escalation process.

**Display:** self-harm context and its full distribution, targeted-insult probability, raw handling distribution, and the composed recommendation. Use plain labels, including “Urgent support” for the immediate-danger category. Do not collapse these into a generic toxicity score.

**Evaluation:** check the nine samples as a functional smoke test. Before making safety-quality claims, use separately reviewed cases with paired contrasts (direct insult versus quoted report; personal disclosure versus literature; idiom with and without prior distress), ambiguous messages expected to route to review, mixed insult/self-harm cases, and relevant local language variants. Report missed support cases, allowed harmful requests/abuse, and false restrictions of legitimate messages separately. Keep expected labels out of State and separate development from held-out cases. These examples and proposed criteria do not establish readiness for student deployment.

### B. Municipal ticket triage

**Purpose:** adapt the video’s Ticket Triage pattern to municipal feedback. Ticket triage combines destination, issue, urgency, and information-sufficiency judgments. Agency selection is one component of this municipal triage use case, not the whole task. Jev is the only AI model called; independent questions share the same State, and ordinary application code combines their answers into a routing recommendation.

The [video’s Ticket Triage demonstration starts at 8:58](https://www.youtube.com/watch?v=tYvu6IpSfiM&t=538s); the [local transcript](references/video-transcript.zh.txt) preserves it. Its pattern of asking related, independent questions together is documented in the [local speculative fan-out reference](references/sources/typesafe-fan-out.md). The municipal version replaces support-ticket definitions with the local agency and feedback taxonomy; it does not add the original generic support-ticket preset as another scenario.

**Initial scope:** a minimal triage preset with primary agency and disposition. Start with these two decisions so routing quality can be evaluated independently of reply generation and the original app’s case-management features.

**State:** a structured record containing the feedback, any available clarification history, and the configured agency responsibility definitions. The original solution’s taxonomy is a prototype taxonomy with overlapping responsibilities, not a verified current operational assignment policy. Label it accordingly and keep it editable in configuration.

Example input record, augmented by the application with the full agency definitions before submission:

```json
{
  "feedback": "The traffic light at the junction has stopped working.",
  "clarification_history": []
}
```

If history is supplied, send it explicitly as part of State. Do not rely on Gemini’s `previous_interaction_id` or assume Jev retains earlier requests. The playground need not implement a resident-facing clarification chat; a user can edit the history and rerun the decision.

**Two default questions, evaluated together:**

| ID | Type | Instructions | Criteria |
| --- | --- | --- | --- |
| `primary_agency` | Choice | Which configured agency is the best candidate for this feedback, using the supplied responsibilities and clarification history? | HDB, LTA, NEA, PUB, NParks, Town Council, SPF, BCA, URA, SLA, or Unclear. Each agency option includes its responsibility definition. Use Unclear when there is no defensible agency candidate; missing location alone does not necessarily prevent identifying a candidate. |
| `disposition` | Choice | What is the next routing step, based on the feedback and supplied scope rules? | `routable`: sufficient detail for an agency recommendation; `needs_clarification`: potentially in scope but missing material facts; `outside_scope`: clearly outside the configured service scope; `non_actionable`: no issue or request to act on, such as a compliment, gibberish, or a pure manipulation attempt; `human_review`: enough detail to describe the issue, but responsibility is disputed or cannot be resolved under the supplied rules. |

Define the disposition criteria to distinguish missing facts from ownership uncertainty. Evaluate content as data, not as instructions to choose a particular agency. An abusive complaint can still contain a routable issue; moderation is not an automatic reason to discard municipal feedback.

Both questions must be self-contained. The disposition question cannot read the primary-agency answer from the same request. Code reconciles the returned pair while preserving the raw answers:

- `routable` with a named agency: show the recommended agency for reviewer consideration.
- `needs_clarification`: show any plausible agency as tentative and indicate that information is missing.
- `outside_scope` or `non_actionable`: show no routing recommendation, even if the parallel agency question selected a named agency.
- `human_review`, or `routable` paired with Unclear: show a review-required state rather than forcing an assignment.

**Three initial samples:**

1. Clear responsibility: a traffic-light fault, with a concrete synthetic junction location.
2. Thin but directional feedback: “There is no maintenance here; everything is dirty,” without a location or specific incident.
3. Clearly unrelated request: “Please recommend a birthday cake recipe.”

These samples demonstrate different routing outcomes, not measured performance. Use the broader evaluation set below for ambiguity, multiple issues, adversarial wording, Singlish, and multilingual inputs.

**Display:** agency recommendation or tentative candidate, full agency probability distribution, disposition and its distribution, available Choice confidence, and the deterministic application outcome. Keep raw Jev judgments visibly separate from the code’s final routing status. Do not present confidence as a measured probability that the agency is correct, invent reasoning prose, or execute dispatch.

**Later triage decisions, after the two-decision baseline:**

- Categories: one Boolean/Noul per existing category because multiple categories can apply; do not force them into one Choice.
- Priority: a Choice among Low, Medium, and High using explicit definitions.
- Missing information: separate Boolean/Noul questions for missing location and issue details.
- Secondary agency: only if needed, add a dedicated relevance judgment or a follow-up request excluding the selected primary agency. The second-highest Choice probability alone does not establish shared responsibility. Keep genuine multi-agency responsibility distinct from uncertainty between alternatives.

These extensions are not part of the initial default preset or its two-question acceptance check. Thresholds that convert probabilities into tags or review decisions must be evaluated on development cases and frozen before held-out scoring; the initial playground does not introduce automatic dispatch thresholds.

**Evaluation reuse:** the local [150 synthetic cases](<DS Interview Q3/question-3/evaluation/test_cases.json>) provide primary labels, acceptable alternative agencies, and input-type slices. Adapt the routing portions of [score_eval.py](<DS Interview Q3/question-3/evaluation/score_eval.py>) into a separate Jev evaluation path. The existing runner and full scorer assume Gemini-generated fields, including drafted replies, so they cannot be reused unchanged for this narrower output.

Keep expected labels out of Jev’s State. Use a fixed development/held-out split before tuning instructions or thresholds. Report primary exact match, acceptable-agency match, coverage/review rate, and errors by input type, plus observed latency, cost, and service failures. The existing Unclear label combines several conditions; add reviewed disposition labels before reporting disposition accuracy. Report raw agency accuracy separately from the application’s final decision to defer or suppress routing, so abstention cannot hide errors. Treat this synthetic, single-source benchmark as preliminary evidence, not real-world validation.

Supporting local documentation: [TypeSafe primitives](references/sources/typesafe-primitives.md) and [confidence guidance](references/sources/typesafe-confidence.md). No live Jev evaluation on this dataset has been performed.


---

## Execution Notes

No execution launched. Baseline SHA: pending repository initialization by Executor after approval. Human approval: pending.

### Attempts

None (0/3).

### Checks and evidence

Pending.

### Questions / blockers

None identified for drafting. Runtime/dependency availability has not been tested by Planner.

---

## QA Feedback

Pending execution and independent diff review. Do not merge or publish until the human authorizes it.

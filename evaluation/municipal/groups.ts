/**
 * Municipal case grouping for the development / held-out split.
 *
 * Default: every case is its own group (`g-<caseId>`). The groups below put
 * obvious near-duplicate or deliberately paired scenarios together, so a
 * paraphrase of a held-out case can never sit in development (and vice versa).
 * Grouping was decided by reading the feedback text only, before any
 * predictions existed; it does not depend on any model output.
 *
 * Limitations (also in implementation-notes.md): this is one reader's
 * judgment over 150 short texts. It catches same-issue paraphrases and
 * explicit contrast pairs, not every topical overlap — e.g. the many
 * "construction site" or "drain" cases that describe different defects stay
 * in separate groups. Topic-level leakage between splits therefore remains
 * possible, and held-out results are synthetic hold-outs from tuning only,
 * not independent validation.
 */

import type { ForcedGroup } from "../shared";

export interface CaseGroup {
  groupId: string;
  caseIds: string[];
  reason: string;
}

export const NEAR_DUPLICATE_GROUPS: readonly CaseGroup[] = [
  {
    groupId: "g-lift-malfunction-block",
    caseIds: ["TC001", "TC133"],
    reason: "Same issue: a residential block lift repeatedly stopping/breaking down. Labels differ (HDB vs HDB/Town Council), so the pair must not straddle splits.",
  },
  {
    groupId: "g-fallen-branch-blocking-path",
    caseIds: ["TC020", "TC056", "TC061"],
    reason: "Same issue: a fallen tree or branch blocking a path/connector. Inherited labels conflict (LTA/NParks vs NParks), so all three stay together.",
  },
  {
    groupId: "g-overgrown-grass",
    caseIds: ["TC057", "TC074"],
    reason: "Same issue: grass near a connector/field not cut, overgrown. Labels differ (NParks vs Town Council/NParks).",
  },
  {
    groupId: "g-playground-equipment",
    caseIds: ["TC009", "TC058"],
    reason: "Same issue: worn or broken playground equipment near the resident's block/estate.",
  },
  {
    groupId: "g-residential-renovation-drilling",
    caseIds: ["TC076", "TC134"],
    reason: "Same issue: neighbour renovation drilling noise at weekends/early hours.",
  },
  {
    groupId: "g-construction-early-noise",
    caseIds: ["TC095", "TC104"],
    reason: "Same issue: construction site noise starting early in the morning.",
  },
  {
    groupId: "g-late-night-music-noise",
    caseIds: ["TC037", "TC091"],
    reason: "Same issue: loud music/karaoke downstairs past midnight. Labels differ (NEA/Town Council vs SPF/NEA).",
  },
  {
    groupId: "g-smelly-drain-near-block",
    caseIds: ["TC048", "TC146"],
    reason: "Same issue: a foul-smelling drain outside the block; TC146 is effectively a Chinese-language paraphrase.",
  },
  {
    groupId: "g-cleaner-compliment",
    caseIds: ["TC131", "TC149"],
    reason: "Same scenario: commending the estate cleaner; identical label sets (Unclear/Town Council).",
  },
  {
    groupId: "g-instruction-override",
    caseIds: ["TC128", "TC140", "TC148"],
    reason: "Same scenario: text attempting to override the routing instructions.",
  },
  {
    groupId: "g-content-free",
    caseIds: ["TC129", "TC130", "TC141", "TC150"],
    reason: "Same scenario: empty, gibberish, or test input with no content.",
  },
  {
    groupId: "g-unanswered-prior-contact",
    caseIds: ["TC136", "TC142"],
    reason: "Same scenario: complaint that an earlier submission went unanswered, with no underlying issue stated.",
  },
  {
    groupId: "g-thin-no-maintenance-complaint",
    caseIds: ["TC127", "TC147"],
    reason: "Same scenario: a generic complaint that nothing gets fixed/maintained, with no specific defect. Labels differ (Unclear vs Town Council/Unclear).",
  },
  {
    groupId: "g-smoke-vape-into-unit",
    caseIds: ["TC031", "TC039"],
    reason: "Same issue: smoke or vape smell from a neighbour entering the resident's unit/corridor.",
  },
  {
    groupId: "g-wildlife-raiding-rubbish",
    caseIds: ["TC041", "TC062"],
    reason: "Same issue: wild animals (boars, monkeys) going through rubbish near homes. Labels differ (NEA/NParks vs NParks).",
  },
  {
    groupId: "g-water-supply-loss",
    caseIds: ["TC043", "TC050"],
    reason: "Same issue: low or no water supply in the resident's unit since the morning.",
  },
  {
    groupId: "g-notice-board",
    caseIds: ["TC071", "TC078"],
    reason: "Same object and agency: an untidy/outdated block notice board.",
  },
  {
    groupId: "g-illegal-parking-obstruction",
    caseIds: ["TC025", "TC084"],
    reason: "Same issue: cars parked illegally obstructing a lane. Labels differ (LTA/SPF vs SPF/Town Council).",
  },
  {
    groupId: "g-wall-crack-contrast",
    caseIds: ["TC003", "TC098"],
    reason: "Contrast pair: a wall crack in an HDB block (HDB) vs on a private building (BCA).",
  },
  {
    groupId: "g-change-of-use",
    caseIds: ["TC106", "TC116"],
    reason: "Same issue: a commercial unit used/converted without approved use.",
  },
  {
    groupId: "g-state-land-misuse",
    caseIds: ["TC118", "TC122", "TC124"],
    reason: "Same issue: state land fenced, occupied, or built on without authorisation.",
  },
  {
    groupId: "g-zoning-query",
    caseIds: ["TC108", "TC115"],
    reason: "Same request: checking what a nearby plot of land is zoned for.",
  },
  {
    groupId: "g-land-ownership-query",
    caseIds: ["TC121", "TC125"],
    reason: "Same request: checking who owns a nearby piece of land.",
  },
  {
    groupId: "g-property-boundary-query",
    caseIds: ["TC117", "TC126"],
    reason: "Same request: verifying a property's boundary line.",
  },
  {
    groupId: "g-renovation-rules-query",
    caseIds: ["TC097", "TC099", "TC103"],
    reason: "Same request family: rules/permits/licensing for home renovation contractors.",
  },
  {
    groupId: "g-construction-temporary-structures",
    caseIds: ["TC096", "TC101"],
    reason: "Same issue: unstable scaffolding or barricades at a nearby construction site.",
  },
];

/** The group a case belongs to: a named group above, else its own group. */
export function groupIdFor(caseId: string): string {
  const group = NEAR_DUPLICATE_GROUPS.find((g) => g.caseIds.includes(caseId));
  return group ? group.groupId : `g-${caseId}`;
}

/**
 * Groups forced into development because they are close variants of the
 * municipal preset's visible playground samples (`lib/scenarios.ts`). Anyone
 * tuning against the playground sees those samples, so their variants cannot
 * be held out.
 */
export const FORCED_GROUPS: ForcedGroup[] = [
  {
    groupId: "g-thin-no-maintenance-complaint",
    split: "development",
    reason:
      "Close variant of the visible playground sample `municipal-thin-directional` (\"There is no maintenance here; everything is dirty.\"): TC147 is the same thin, directional no-maintenance complaint.",
  },
  {
    groupId: "g-TC024",
    split: "development",
    reason:
      "Close variant of the visible playground sample `municipal-traffic-light` (a malfunctioning traffic light at a named junction).",
  },
];

/** Documented split seed; the manifest was built once with this value. */
export const SPLIT_SEED = "jev-04-municipal-split-2026-09-21";

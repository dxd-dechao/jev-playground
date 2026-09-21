/**
 * Prototype agency responsibility definitions used by the municipal preset.
 *
 * PROVENANCE
 * ----------
 * The responsibility wording below is copied from the agency taxonomy block of
 * a local prototype: `DS Interview Q3/question-3/app/routing.py`, lines 185-200
 * (read on 21 September 2026). Only that taxonomy text was copied. None of the
 * prototype's retrieval, case history, reply drafting, or Gemini code was
 * imported, and the prototype application is not run by this playground.
 *
 * STATUS
 * ------
 * This is a *prototype* taxonomy with deliberately overlapping
 * responsibilities (a lift defect can plausibly sit with HDB or the estate's
 * Town Council). It is not a verified current operational assignment policy
 * for any agency. It is versioned here so a reviewer can edit it, and it is
 * sent inside State so the model sees the same definitions the reviewer reads.
 */

export const AGENCY_TAXONOMY_VERSION = "prototype-2026-09-21";

export const AGENCY_TAXONOMY_PROVENANCE =
  "Prototype taxonomy copied from DS Interview Q3/question-3/app/routing.py " +
  "(agency taxonomy block). Overlapping responsibilities are intentional. " +
  "Not a verified current operational assignment policy.";

export interface AgencyDefinition {
  /** Option key used in the Choice criteria and in the probability map. */
  agency: string;
  /** Responsibility definition shown to the model and to the reviewer. */
  responsibilities: string;
}

/**
 * The ten named agencies. `Unclear` is handled separately: it is an escape
 * hatch for the Choice question, not an agency with responsibilities.
 */
export const AGENCY_DEFINITIONS: readonly AgencyDefinition[] = [
  {
    agency: "HDB",
    responsibilities:
      "Flat/block structural and facility defects (lifts, walls, corridors, upgrading programmes) inside HDB estates.",
  },
  {
    agency: "LTA",
    responsibilities:
      "Roads, traffic lights, bus stops and bus services, MRT, cycling paths, COE.",
  },
  {
    agency: "NEA",
    responsibilities:
      "Pests, hygiene, smoking, noise, hawker centres, haze, littering.",
  },
  {
    agency: "PUB",
    responsibilities: "Water supply, drainage, canals, floods, water bills.",
  },
  {
    agency: "NParks",
    responsibilities:
      "Parks, trees, park connectors, community gardens, wildlife.",
  },
  {
    agency: "Town Council",
    responsibilities:
      "Estate cleaning, corridors, void decks, RC/CC facilities, and day-to-day estate maintenance that is not specific to another agency.",
  },
  {
    agency: "SPF",
    responsibilities:
      "Crime, safety threats, traffic offences, harassment, theft.",
  },
  {
    agency: "BCA",
    responsibilities:
      "Construction site safety, building defects, contractor licensing.",
  },
  {
    agency: "URA",
    responsibilities:
      "Zoning, land use, unauthorised renovation or unauthorised use, master plan.",
  },
  {
    agency: "SLA",
    responsibilities: "State land, land boundaries, survey, land titles.",
  },
] as const;

/** The `Unclear` option, which is not an agency. */
export const UNCLEAR_AGENCY = "Unclear" as const;

export const UNCLEAR_AGENCY_DEFINITION =
  "No defensible agency candidate can be identified from the feedback and the " +
  "supplied responsibilities. Missing location alone does not necessarily " +
  "prevent identifying a candidate.";

/** Every option key for the `primary_agency` Choice, in display order. */
export const AGENCY_OPTIONS: readonly string[] = [
  ...AGENCY_DEFINITIONS.map((definition) => definition.agency),
  UNCLEAR_AGENCY,
];

/** Choice `criteria` map: each option carries its own responsibility text. */
export function agencyChoiceCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const definition of AGENCY_DEFINITIONS) {
    criteria[definition.agency] = definition.responsibilities;
  }
  criteria[UNCLEAR_AGENCY] = UNCLEAR_AGENCY_DEFINITION;
  return criteria;
}

/** The block embedded in municipal State so the model reads what the UI shows. */
export function agencyConfigForState() {
  return {
    taxonomy_version: AGENCY_TAXONOMY_VERSION,
    taxonomy_status: AGENCY_TAXONOMY_PROVENANCE,
    agencies: AGENCY_DEFINITIONS.map((definition) => ({ ...definition })),
  };
}

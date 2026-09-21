/**
 * Editable request drafts: one per scenario, in a Form view or as raw
 * whole-request JSON.
 *
 * Pure functions only, so every rule here is unit-tested without a browser.
 * The rules this module exists to hold:
 *
 *  - A draft never overwrites what the reviewer typed. Invalid State JSON,
 *    an invalid field, or invalid whole-request JSON is kept verbatim with an
 *    error; nothing is silently replaced by the last valid value.
 *  - Form rows keep question ids and Choice option names as plain row fields
 *    until conversion. Two rows with the same id are *reported*, not collapsed
 *    into one map entry, and every row has a stable internal `key` so renaming
 *    an id never moves focus or deletes another question.
 *  - Raw whole-request JSON is scanned for duplicate question ids and option
 *    keys before its parsed value is trusted, because `JSON.parse` keeps the
 *    last of two equal keys without a word.
 *  - While raw JSON is authoritative (`requestJson !== null`) and invalid, the
 *    Form is read-only. The only ways out are fixing the JSON or an explicit
 *    Reset; switching views or scenarios keeps the raw text intact.
 *  - A question type change resets that question's criteria to clear defaults.
 *    Rows are discriminated by type, so no hidden payload of the old type can
 *    survive and be sent.
 *  - The exported preset objects are never mutated. Drafts are rebuilt from
 *    them by value.
 *
 * STATE TEXT/JSON RULE (reversible)
 * ---------------------------------
 * A State draft keeps two buffers: the JSON source and the literal text.
 *  - JSON → Text: the Text buffer becomes the parsed string if the JSON is a
 *    string, and otherwise the JSON *source itself*, verbatim, as a literal
 *    string. The JSON buffer is kept untouched.
 *  - Text → JSON: if the text has not been edited since that switch, the kept
 *    JSON buffer is restored exactly, so a round trip changes nothing. If it
 *    has been edited, the edited text becomes a JSON string literal — it is
 *    never re-read as structure and nothing is dropped.
 * Content is never trimmed in either direction.
 */

import { deepEqual } from "./fixtures";
import type { Scenario } from "./scenarios";
import { getDefaultSample } from "./scenarios";
import { describeDuplicateKey, findDuplicateRequestKeys } from "./schemas";
import type {
  ChoiceQuestion,
  EvaluationRequest,
  Question,
  Questions,
  State,
} from "./types";

/* ------------------------------------------------------------ Row keys -- */

let keyCounter = 0;

/** A stable internal identity for a row. Never shown and never sent. */
export function newRowKey(): string {
  keyCounter += 1;
  return `row-${keyCounter}`;
}

/* ------------------------------------------------------------- Fields -- */

/**
 * How one editable value (instructions, an option description, a Score level,
 * a Noul yes/no description) is read.
 *
 *  - `text`: the text is the value, a literal string.
 *  - `json`: the text is parsed as JSON (structured instructions or criteria).
 *  - `null`: an explicit `null` — a Choice option with no extra detail.
 *  - `absent`: omitted — an optional Noul yes/no description.
 */
export type FieldKind = "text" | "json" | "null" | "absent";

export interface FieldDraft {
  kind: FieldKind;
  text: string;
}

export function fieldFromValue(
  value: unknown,
  allow: { null?: boolean; absent?: boolean } = {},
): FieldDraft {
  if (value === undefined && allow.absent) return { kind: "absent", text: "" };
  if (value === null && allow.null) return { kind: "null", text: "" };
  if (typeof value === "string") return { kind: "text", text: value };
  return { kind: "json", text: JSON.stringify(value, null, 2) ?? "" };
}

type FieldRead = { ok: true; value: unknown } | { ok: false; error: string };

export function readField(field: FieldDraft): FieldRead {
  switch (field.kind) {
    case "text":
      return { ok: true, value: field.text };
    case "null":
      return { ok: true, value: null };
    case "absent":
      return { ok: true, value: undefined };
    case "json":
      try {
        return { ok: true, value: JSON.parse(field.text) as unknown };
      } catch (error) {
        return {
          ok: false,
          error: `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        };
      }
  }
}

/**
 * Change how a field is read. Switching between Text and JSON keeps the typed
 * text and only changes its interpretation; switching to `null` or `absent`
 * clears it, because a value that is not sent must not linger unseen.
 */
export function changeFieldKind(field: FieldDraft, kind: FieldKind): FieldDraft {
  if (field.kind === kind) return field;
  if (kind === "null" || kind === "absent") return { kind, text: "" };
  return { kind, text: field.text };
}

/* ---------------------------------------------------------- Questions -- */

export type QuestionType = Question["type"];

export interface OptionRow {
  key: string;
  name: string;
  description: FieldDraft;
}

export interface LevelRow {
  key: string;
  value: FieldDraft;
}

/** Criteria for exactly one type. A type change replaces the whole thing. */
export type CriteriaDraft =
  | { type: "noul"; yes: FieldDraft; no: FieldDraft }
  | { type: "choice"; options: OptionRow[] }
  | { type: "score"; levels: LevelRow[] };

export interface QuestionRow {
  key: string;
  id: string;
  instructions: FieldDraft;
  criteria: CriteriaDraft;
}

/**
 * Clear defaults for a newly chosen type. Deliberately incomplete where the
 * type needs content — empty option names and empty levels are reported by
 * validation rather than filled with invented wording.
 */
export function defaultCriteria(type: QuestionType): CriteriaDraft {
  switch (type) {
    case "noul":
      return {
        type,
        yes: { kind: "absent", text: "" },
        no: { kind: "absent", text: "" },
      };
    case "choice":
      return {
        type,
        options: [
          { key: newRowKey(), name: "", description: { kind: "null", text: "" } },
          { key: newRowKey(), name: "", description: { kind: "null", text: "" } },
        ],
      };
    case "score":
      return {
        type,
        levels: [
          { key: newRowKey(), value: { kind: "text", text: "" } },
          { key: newRowKey(), value: { kind: "text", text: "" } },
        ],
      };
  }
}

export function changeQuestionType(row: QuestionRow, type: QuestionType): QuestionRow {
  if (row.criteria.type === type) return row;
  return { ...row, criteria: defaultCriteria(type) };
}

/** A fresh question row with an id no other row uses. */
export function newQuestionRow(existing: readonly QuestionRow[]): QuestionRow {
  const taken = new Set(existing.map((row) => row.id));
  let index = existing.length + 1;
  while (taken.has(`question_${index}`)) index += 1;
  return {
    key: newRowKey(),
    id: `question_${index}`,
    instructions: { kind: "text", text: "" },
    criteria: defaultCriteria("noul"),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const QUESTION_KEYS = new Set(["type", "instructions", "criteria"]);

/**
 * Turn one parsed question into a Form row, or explain why the Form cannot
 * represent it exactly. Anything the Form could not round-trip is an error
 * here, so the Form never shows a lossy version of what the JSON said.
 */
function rowFromQuestion(
  id: string,
  raw: unknown,
  key: string,
): { row?: QuestionRow; errors: string[] } {
  const label = `questions.${id}`;
  if (!isPlainObject(raw)) {
    return { errors: [`${label} — a question must be an object`] };
  }
  const errors: string[] = [];
  for (const property of Object.keys(raw)) {
    if (!QUESTION_KEYS.has(property)) {
      errors.push(`${label} — unknown property "${property}"`);
    }
  }
  const type = raw.type;
  if (type !== "noul" && type !== "choice" && type !== "score") {
    errors.push(`${label}.type — must be "noul", "choice", or "score"`);
  }
  if (!("instructions" in raw)) errors.push(`${label}.instructions — required`);
  if (errors.length > 0) return { errors };

  const instructions = fieldFromValue(raw.instructions);
  const criteria = raw.criteria;

  if (type === "noul") {
    if (criteria === undefined) {
      return {
        row: { key, id, instructions, criteria: defaultCriteria("noul") },
        errors: [],
      };
    }
    if (!isPlainObject(criteria)) {
      return { errors: [`${label}.criteria — a Noul's criteria must be an object`] };
    }
    const extra = Object.keys(criteria).filter((name) => name !== "true" && name !== "false");
    if (extra.length > 0) {
      return {
        errors: [`${label}.criteria — only "true" and "false" are allowed, not ${extra.join(", ")}`],
      };
    }
    if (Object.keys(criteria).length === 0) {
      return {
        errors: [
          `${label}.criteria — an empty Noul criteria object has no Form equivalent; describe "true" or "false", or omit criteria`,
        ],
      };
    }
    return {
      row: {
        key,
        id,
        instructions,
        criteria: {
          type: "noul",
          yes: fieldFromValue(criteria.true, { absent: true }),
          no: fieldFromValue(criteria.false, { absent: true }),
        },
      },
      errors: [],
    };
  }

  if (type === "choice") {
    if (!isPlainObject(criteria)) {
      return { errors: [`${label}.criteria — a Choice's criteria must be an object of options`] };
    }
    return {
      row: {
        key,
        id,
        instructions,
        criteria: {
          type: "choice",
          options: Object.entries(criteria).map(([name, description]) => ({
            key: newRowKey(),
            name,
            description: fieldFromValue(description, { null: true }),
          })),
        },
      },
      errors: [],
    };
  }

  if (!Array.isArray(criteria)) {
    return { errors: [`${label}.criteria — a Score's criteria must be an array of levels`] };
  }
  return {
    row: {
      key,
      id,
      instructions,
      criteria: {
        type: "score",
        levels: criteria.map((level) => ({ key: newRowKey(), value: fieldFromValue(level) })),
      },
    },
    errors: [],
  };
}

/**
 * Questions → Form rows. `reuseKeys` keeps row identity by position, so a
 * JSON edit that renames an id does not remount (and unfocus) the row.
 */
export function rowsFromQuestions(
  questions: unknown,
  reuseKeys: readonly string[] = [],
): { rows?: QuestionRow[]; errors: string[] } {
  if (!isPlainObject(questions)) {
    return { errors: ["questions — must be an object keyed by question id"] };
  }
  const rows: QuestionRow[] = [];
  const errors: string[] = [];
  Object.entries(questions).forEach(([id, question], index) => {
    const converted = rowFromQuestion(id, question, reuseKeys[index] ?? newRowKey());
    errors.push(...converted.errors);
    if (converted.row) rows.push(converted.row);
  });
  if (errors.length > 0) return { errors };
  return { rows, errors: [] };
}

/** A preset's questions as rows, in the preset's own display order. */
export function rowsFromPreset(scenario: Scenario): QuestionRow[] {
  const ordered: Questions = {};
  for (const id of scenario.questionOrder) {
    const question = scenario.questions[id];
    if (question) ordered[id] = question;
  }
  for (const [id, question] of Object.entries(scenario.questions)) {
    if (!(id in ordered)) ordered[id] = question;
  }
  // The preset is valid by construction and tested to be; a failure here is a
  // programming error, not user input.
  const { rows } = rowsFromQuestions(ordered);
  if (!rows) throw new Error(`Preset questions for ${scenario.id} are not representable`);
  return rows;
}

function displayId(id: string): string {
  return id.length > 0 ? id : "(unnamed)";
}

function rowToQuestion(row: QuestionRow): { question?: Question; errors: string[] } {
  const label = `questions.${displayId(row.id)}`;
  const errors: string[] = [];

  const instructions = readField(row.instructions);
  if (!instructions.ok) errors.push(`${label}.instructions — ${instructions.error}`);

  const criteria = row.criteria;
  if (criteria.type === "noul") {
    const yes = readField(criteria.yes);
    const no = readField(criteria.no);
    if (!yes.ok) errors.push(`${label}.criteria.true — ${yes.error}`);
    if (!no.ok) errors.push(`${label}.criteria.false — ${no.error}`);
    if (errors.length > 0 || !instructions.ok || !yes.ok || !no.ok) return { errors };
    const described: Record<string, unknown> = {};
    if (yes.value !== undefined) described.true = yes.value;
    if (no.value !== undefined) described.false = no.value;
    const question: Record<string, unknown> = {
      type: "noul",
      instructions: instructions.value,
    };
    if (Object.keys(described).length > 0) question.criteria = described;
    return { question: question as unknown as Question, errors: [] };
  }

  if (criteria.type === "choice") {
    const seen = new Set<string>();
    const map: Record<string, unknown> = {};
    for (const option of criteria.options) {
      if (seen.has(option.name)) {
        errors.push(
          describeDuplicateKey({ path: `${label}.criteria`, key: option.name }),
        );
        continue;
      }
      seen.add(option.name);
      const description = readField(option.description);
      if (!description.ok) {
        errors.push(
          `${label}.criteria.${option.name.length > 0 ? option.name : "(unnamed option)"} — ${description.error}`,
        );
        continue;
      }
      map[option.name] = description.value;
    }
    if (errors.length > 0 || !instructions.ok) return { errors };
    const question: ChoiceQuestion = {
      type: "choice",
      instructions: instructions.value as ChoiceQuestion["instructions"],
      criteria: map as ChoiceQuestion["criteria"],
    };
    return { question, errors: [] };
  }

  const levels: unknown[] = [];
  criteria.levels.forEach((level, index) => {
    const value = readField(level.value);
    if (!value.ok) errors.push(`${label}.criteria[${index}] — ${value.error}`);
    else levels.push(value.value);
  });
  if (errors.length > 0 || !instructions.ok) return { errors };
  return {
    question: {
      type: "score",
      instructions: instructions.value,
      criteria: levels,
    } as Question,
    errors: [],
  };
}

/**
 * Form rows → a questions map in row order. Duplicate ids are reported, never
 * collapsed: converting them into one map entry would silently drop a question.
 */
export function rowsToQuestions(rows: readonly QuestionRow[]): {
  questions?: Questions;
  order: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) errors.push(describeDuplicateKey({ path: "questions", key: id }));
  }

  const questions: Questions = {};
  for (const row of rows) {
    const converted = rowToQuestion(row);
    errors.push(...converted.errors);
    if (converted.question && counts.get(row.id) === 1) {
      questions[row.id] = converted.question;
    }
  }
  const order = rows.map((row) => row.id);
  if (errors.length > 0) return { order, errors };
  return { questions, order, errors: [] };
}

/** Row ids that appear more than once, for marking the offending inputs. */
export function duplicateRowIds(rows: readonly QuestionRow[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) duplicates.add(row.id);
    seen.add(row.id);
  }
  return duplicates;
}

/* -------------------------------------------------------------- State -- */

export type StateMode = "json" | "text";

export interface StateDraft {
  mode: StateMode;
  /** The JSON source. Kept, untouched, while Text is shown. */
  json: string;
  /** The literal text used in Text mode. */
  text: string;
  /**
   * The text produced by the last JSON → Text switch. While `text` still
   * equals it, switching back restores `json` exactly.
   */
  textBase: string | null;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function stateDraftFromValue(value: State, preferText = false): StateDraft {
  if (typeof value === "string" && preferText) {
    return { mode: "text", json: formatJson(value), text: value, textBase: value };
  }
  return { mode: "json", json: formatJson(value), text: "", textBase: null };
}

export type StateRead =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function readStateDraft(state: StateDraft): StateRead {
  if (state.mode === "text") return { ok: true, value: state.text };
  try {
    return { ok: true, value: JSON.parse(state.json) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Apply the reversible Text/JSON rule described at the top of this file. */
export function toggleStateMode(state: StateDraft, mode: StateMode): StateDraft {
  if (state.mode === mode) return state;
  if (mode === "text") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(state.json) as unknown;
    } catch {
      parsed = undefined;
    }
    const text = typeof parsed === "string" ? parsed : state.json;
    return { mode: "text", json: state.json, text, textBase: text };
  }
  if (state.textBase !== null && state.text === state.textBase) {
    return { mode: "json", json: state.json, text: state.text, textBase: state.textBase };
  }
  return { mode: "json", json: JSON.stringify(state.text), text: state.text, textBase: null };
}

/** Replace whichever buffer the current mode edits. */
export function editStateText(state: StateDraft, text: string): StateDraft {
  return state.mode === "text" ? { ...state, text } : { ...state, json: text };
}

/** The text shown in the State editor for the current mode. */
export function stateEditorText(state: StateDraft): string {
  return state.mode === "text" ? state.text : state.json;
}

/* ------------------------------------------------------------ Drafts -- */

export type RequestView = "form" | "json";

export interface RequestDraft {
  view: RequestView;
  state: StateDraft;
  rows: QuestionRow[];
  /**
   * Raw whole-request JSON. Non-null while it is authoritative: the JSON view
   * is open, or an invalid JSON edit is pending and the Form is locked.
   */
  requestJson: string | null;
}

export function initialDraft(scenario: Scenario): RequestDraft {
  return {
    view: "form",
    state: stateDraftFromValue(getDefaultSample(scenario).state),
    rows: rowsFromPreset(scenario),
    requestJson: null,
  };
}

/** What a draft currently asks, or why it cannot be read as a request. */
export interface DraftReading {
  /** Null when the draft cannot be converted at all (see `errors`). */
  request: EvaluationRequest | null;
  /** Question ids in display order. */
  order: string[];
  /** Conversion problems: syntax, duplicates, unrepresentable shapes. */
  errors: string[];
  /** The State editor's own JSON syntax error, shown beside that editor. */
  stateError: string | null;
  source: RequestView;
}

export function readForm(draft: RequestDraft): DraftReading {
  const state = readStateDraft(draft.state);
  const converted = rowsToQuestions(draft.rows);
  const stateError = state.ok ? null : state.error;
  if (!state.ok || converted.questions === undefined) {
    return {
      request: null,
      order: converted.order,
      errors: converted.errors,
      stateError,
      source: "form",
    };
  }
  return {
    request: { state: state.value as State, questions: converted.questions },
    order: converted.order,
    errors: [],
    stateError: null,
    source: "form",
  };
}

export interface RequestJsonReading {
  request: EvaluationRequest | null;
  rows?: QuestionRow[];
  order: string[];
  errors: string[];
}

/**
 * Parse raw whole-request JSON: exactly `{ state, questions }`, no duplicate
 * question ids or option keys, and questions the Form can represent exactly.
 */
export function parseRequestJson(
  text: string,
  reuseKeys: readonly string[] = [],
): RequestJsonReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      request: null,
      order: [],
      errors: [
        `The request is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      request: null,
      order: [],
      errors: ["The request must be a JSON object: { \"state\": …, \"questions\": … }"],
    };
  }
  const errors: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (key !== "state" && key !== "questions") {
      errors.push(
        `"${key}" is not part of the request; only "state" and "questions" are edited here`,
      );
    }
  }
  if (!("state" in parsed)) errors.push('"state" is required');
  if (!("questions" in parsed)) errors.push('"questions" is required');
  errors.push(...findDuplicateRequestKeys(text).map(describeDuplicateKey));
  if (errors.length > 0) return { request: null, order: [], errors };

  const converted = rowsFromQuestions(parsed.questions, reuseKeys);
  if (!converted.rows) return { request: null, order: [], errors: converted.errors };
  return {
    request: { state: parsed.state as State, questions: parsed.questions as Questions },
    rows: converted.rows,
    order: Object.keys(parsed.questions as object),
    errors: [],
  };
}

export function readDraft(draft: RequestDraft): DraftReading {
  if (draft.requestJson === null) return readForm(draft);
  const reading = parseRequestJson(draft.requestJson);
  return {
    request: reading.request,
    order: reading.order,
    errors: reading.errors,
    stateError: null,
    source: "json",
  };
}

/** Raw JSON is authoritative and invalid, so the Form must stay read-only. */
export function isFormLocked(draft: RequestDraft): boolean {
  return draft.requestJson !== null && parseRequestJson(draft.requestJson).request === null;
}

/**
 * Bring the Form in line with valid raw JSON, keeping everything that already
 * matches: an equal State keeps its buffers and mode, and equal questions keep
 * their rows, so a whitespace-only JSON edit changes nothing in the Form.
 */
function materializeJson(draft: RequestDraft, reading: RequestJsonReading): RequestDraft {
  if (reading.request === null || reading.rows === undefined) return draft;
  const form = readForm(draft);
  const state =
    form.request !== null && deepEqual(form.request.state, reading.request.state)
      ? draft.state
      : stateDraftFromValue(reading.request.state, draft.state.mode === "text");
  const rows =
    form.request !== null && deepEqual(form.request.questions, reading.request.questions)
      ? draft.rows
      : reading.rows;
  return { ...draft, state, rows, requestJson: null };
}

/** Form → JSON. Refused (returns the draft unchanged) if the Form cannot convert. */
export function openJsonView(draft: RequestDraft): RequestDraft {
  if (draft.view === "json") return draft;
  if (draft.requestJson !== null) return { ...draft, view: "json" };
  const form = readForm(draft);
  if (form.request === null) return draft;
  return { ...draft, view: "json", requestJson: formatJson(form.request) };
}

/**
 * JSON → Form. Valid JSON is synchronized into the Form; invalid JSON is kept
 * verbatim and the Form opens locked.
 */
export function openFormView(draft: RequestDraft): RequestDraft {
  if (draft.requestJson === null) return { ...draft, view: "form" };
  const reading = parseRequestJson(
    draft.requestJson,
    draft.rows.map((row) => row.key),
  );
  if (reading.request === null) return { ...draft, view: "form" };
  return { ...materializeJson(draft, reading), view: "form" };
}

export function setRequestJson(draft: RequestDraft, text: string): RequestDraft {
  return { ...draft, requestJson: text };
}

/**
 * Load a sample: it replaces State only and keeps the current questions,
 * whichever view holds them. Returns the draft unchanged while the raw JSON is
 * invalid, because replacing part of it would mean overwriting what was typed.
 */
export function applySampleState(draft: RequestDraft, state: State): RequestDraft {
  let base = draft;
  if (draft.requestJson !== null) {
    const reading = parseRequestJson(
      draft.requestJson,
      draft.rows.map((row) => row.key),
    );
    if (reading.request === null) return draft;
    base = materializeJson(draft, reading);
    const next = { ...base, state: stateDraftFromValue(state) };
    return draft.view === "json"
      ? { ...next, requestJson: formatJson({ state, questions: reading.request.questions }) }
      : next;
  }
  return { ...base, state: stateDraftFromValue(state) };
}

/* ------------------------------------------------------- Comparisons -- */

/**
 * Whether two requests ask the same thing: equal State and equal questions,
 * compared as values, so JSON whitespace or key order alone is no change.
 */
export function sameRequest(a: EvaluationRequest, b: EvaluationRequest): boolean {
  return deepEqual(a.state, b.state) && deepEqual(a.questions, b.questions);
}

/**
 * A Text State paired with questions written for named State fields. The
 * preset questions read `student_message`, `feedback`, and so on, which a
 * plain string does not have. Nothing is wrapped or rewritten; this is a
 * warning for the reviewer.
 */
export function textStateMeetsPresetQuestions(
  scenario: Scenario,
  request: EvaluationRequest,
): boolean {
  if (typeof request.state !== "string") return false;
  const presets = Object.values(scenario.questions);
  return Object.values(request.questions).some((question) =>
    presets.some((preset) => deepEqual(preset, question)),
  );
}

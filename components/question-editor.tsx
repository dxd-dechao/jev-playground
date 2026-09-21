"use client";

/**
 * The Form view of the questions: ids, types, instructions, and criteria.
 *
 * Presentational. Every change is handed to the parent as a new row array;
 * the rules about what a row means live in `lib/request-draft.ts`. Things this
 * component is careful about:
 *
 *  - Rows are keyed by their stable internal `key`, never by the editable id,
 *    so renaming a question keeps focus in the input being typed in and cannot
 *    remount or drop a neighbouring question.
 *  - Duplicate ids and duplicate option names are marked on the inputs
 *    themselves; the rows are kept as typed, not merged.
 *  - Structured instructions or criteria use a JSON text box rather than a
 *    nested form builder. A field's format selector changes how its text is
 *    read (Text or JSON) without discarding what was typed.
 *  - Nothing here submits. Editing never calls the model.
 */

import { useId } from "react";
import type {
  CriteriaDraft,
  FieldDraft,
  FieldKind,
  LevelRow,
  OptionRow,
  QuestionRow,
  QuestionType,
} from "@/lib/request-draft";
import {
  changeFieldKind,
  changeQuestionType,
  duplicateRowIds,
  newQuestionRow,
  newRowKey,
  readField,
} from "@/lib/request-draft";

const KIND_LABELS: Record<FieldKind, string> = {
  text: "Text",
  json: "JSON",
  null: "None (null)",
  absent: "Omitted",
};

const TYPE_LABELS: Record<QuestionType, string> = {
  noul: "Noul — yes/no probability",
  choice: "Choice — one option + distribution",
  score: "Score — level rating + distribution",
};

/** A small colour accent per type; the type is always written out as well. */
const TYPE_ACCENTS: Record<QuestionType, string> = {
  choice: "border-l-[var(--color-type-choice)]",
  score: "border-l-[var(--color-type-score)]",
  noul: "border-l-[var(--color-type-noul)]",
};

/** Score accepts 2–10 levels; the Form will not add an eleventh. */
const MAX_SCORE_LEVELS = 10;

const inputClass = "input min-h-9 px-2 py-1 font-mono text-xs";
const smallButtonClass = "btn min-h-8 px-2 py-0.5 text-[11px]";
const removeButtonClass = `${smallButtonClass} btn-danger`;
function FieldEditor({
  label,
  field,
  kinds,
  onChange,
  testId,
  rows = 2,
}: {
  label: string;
  field: FieldDraft;
  kinds: FieldKind[];
  onChange: (field: FieldDraft) => void;
  testId: string;
  rows?: number;
}) {
  const textId = useId();
  const kindId = useId();
  const errorId = useId();
  const read = readField(field);
  const invalid = !read.ok;
  const editable = field.kind === "text" || field.kind === "json";

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={editable ? textId : kindId} className="field-label">
          {label}
        </label>
        <span className="flex items-center gap-1">
          <label htmlFor={kindId} className="sr-only">
            {`${label} format`}
          </label>
          <select
            id={kindId}
            data-testid={`${testId}-kind`}
            value={field.kind}
            onChange={(event) =>
              onChange(changeFieldKind(field, event.target.value as FieldKind))
            }
            className="min-h-8 border-2 border-[var(--color-line)] bg-[var(--color-panel)] px-1.5 py-0.5 text-[11px] font-semibold"
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </span>
      </div>
      {editable ? (
        <>
          <textarea
            id={textId}
            data-testid={testId}
            value={field.text}
            spellCheck={false}
            rows={field.kind === "json" ? Math.max(rows, 4) : rows}
            onChange={(event) => onChange({ ...field, text: event.target.value })}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            className={`input mt-1 resize-y p-2 text-sm leading-relaxed ${
              field.kind === "json" ? "font-mono text-xs" : ""
            }`}
          />
          {invalid ? (
            <p id={errorId} className="mt-0.5 text-[11px] font-semibold text-[var(--color-danger)]">
              This {label.toLowerCase()} {read.error}. Your text is kept as typed.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
          {field.kind === "null"
            ? "Sent as null — this option needs no extra detail."
            : "Not sent — this optional description is omitted."}
        </p>
      )}
    </div>
  );
}

function ChoiceCriteria({
  options,
  questionId,
  onChange,
}: {
  options: OptionRow[];
  questionId: string;
  onChange: (options: OptionRow[]) => void;
}) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const option of options) {
    if (seen.has(option.name)) duplicates.add(option.name);
    seen.add(option.name);
  }
  const update = (key: string, change: (option: OptionRow) => OptionRow) =>
    onChange(options.map((option) => (option.key === key ? change(option) : option)));

  return (
    <div className="mt-4">
      <h5 className="field-label bg-[var(--color-canvas)] px-1 py-0.5">
        Criteria · option → description ({options.length}; 2 to 255)
      </h5>
      <ol className="mt-2 space-y-2">
        {options.map((option, index) => (
          <li
            key={option.key}
            data-testid="choice-option"
            className="grid grid-cols-1 gap-2 border-b border-dashed border-[var(--color-line-soft)] pb-2 last:border-b-0 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-start"
          >
            <div className="min-w-0">
              <OptionName
                value={option.name}
                duplicate={duplicates.has(option.name)}
                label={`Option ${index + 1} key for ${questionId || "this question"}`}
                onChange={(name) => update(option.key, (current) => ({ ...current, name }))}
              />
              <button
                type="button"
                data-testid="remove-option"
                className={`${removeButtonClass} mt-1.5`}
                onClick={() => onChange(options.filter((entry) => entry.key !== option.key))}
              >
                Remove option
              </button>
            </div>
            <FieldEditor
              label="Description"
              field={option.description}
              kinds={["null", "text", "json"]}
              testId="option-description"
              onChange={(description) =>
                update(option.key, (current) => ({ ...current, description }))
              }
            />
          </li>
        ))}
      </ol>
      <button
        type="button"
        data-testid="add-option"
        className={`${smallButtonClass} mt-2`}
        onClick={() =>
          onChange([
            ...options,
            { key: newRowKey(), name: "", description: { kind: "null", text: "" } },
          ])
        }
      >
        + Add option
      </button>
    </div>
  );
}

function OptionName({
  value,
  duplicate,
  label,
  onChange,
}: {
  value: string;
  duplicate: boolean;
  label: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const blank = value.trim().length === 0;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="field-label">
        Option
      </label>
      <input
        id={id}
        data-testid="option-name"
        aria-label={label}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={duplicate || blank}
        className={`${inputClass} mt-1`}
      />
      {duplicate ? (
        <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-danger)]">
          Another option already uses this key. Both are kept; rename one.
        </p>
      ) : blank ? (
        <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-danger)]">
          An option key must not be empty.
        </p>
      ) : null}
    </div>
  );
}

function ScoreCriteria({
  levels,
  onChange,
}: {
  levels: LevelRow[];
  onChange: (levels: LevelRow[]) => void;
}) {
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= levels.length) return;
    const next = [...levels];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <div className="mt-4">
      <h5 className="field-label bg-[var(--color-canvas)] px-1 py-0.5">
        Criteria · ordered levels, low to high ({levels.length}; 2 to {MAX_SCORE_LEVELS})
      </h5>
      <ol className="mt-2 space-y-2">
        {levels.map((level, index) => (
          <li
            key={level.key}
            data-testid="score-level-row"
            className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-b border-dashed border-[var(--color-line-soft)] pb-2 last:border-b-0"
          >
            <span
              aria-hidden="true"
              className="mt-5 flex h-8 w-8 items-center justify-center border-2 border-[var(--color-line)] bg-[var(--color-type-score)] font-mono text-sm font-bold"
            >
              {index}
            </span>
            <div className="min-w-0">
              <FieldEditor
                label={`Level ${index}`}
                field={level.value}
                kinds={["text", "json"]}
                testId="score-level"
                onChange={(value) =>
                  onChange(
                    levels.map((entry) => (entry.key === level.key ? { ...entry, value } : entry)),
                  )
                }
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-testid="level-up"
                  className={smallButtonClass}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑ Move up
                </button>
                <button
                  type="button"
                  data-testid="level-down"
                  className={smallButtonClass}
                  disabled={index === levels.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓ Move down
                </button>
                <button
                  type="button"
                  data-testid="remove-level"
                  className={removeButtonClass}
                  onClick={() => onChange(levels.filter((entry) => entry.key !== level.key))}
                >
                  Remove level
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        data-testid="add-level"
        className={`${smallButtonClass} mt-2`}
        disabled={levels.length >= MAX_SCORE_LEVELS}
        onClick={() =>
          onChange([...levels, { key: newRowKey(), value: { kind: "text", text: "" } }])
        }
      >
        + Add level
      </button>
    </div>
  );
}

function CriteriaEditor({
  criteria,
  questionId,
  onChange,
}: {
  criteria: CriteriaDraft;
  questionId: string;
  onChange: (criteria: CriteriaDraft) => void;
}) {
  if (criteria.type === "noul") {
    return (
      <div className="mt-4">
        <h5 className="field-label bg-[var(--color-canvas)] px-1 py-0.5">
          Criteria · optional, what true / false mean (give both or neither)
        </h5>
        <div className="mt-2 space-y-2">
          <FieldEditor
            label="True (yes) means"
            field={criteria.yes}
            kinds={["absent", "text", "json"]}
            testId="noul-true"
            onChange={(yes) => onChange({ ...criteria, yes })}
          />
          <FieldEditor
            label="False (no) means"
            field={criteria.no}
            kinds={["absent", "text", "json"]}
            testId="noul-false"
            onChange={(no) => onChange({ ...criteria, no })}
          />
        </div>
      </div>
    );
  }
  if (criteria.type === "choice") {
    return (
      <ChoiceCriteria
        options={criteria.options}
        questionId={questionId}
        onChange={(options) => onChange({ ...criteria, options })}
      />
    );
  }
  return (
    <ScoreCriteria
      levels={criteria.levels}
      onChange={(levels) => onChange({ ...criteria, levels })}
    />
  );
}

function QuestionCard({
  row,
  position,
  duplicate,
  onChange,
  onRemove,
}: {
  row: QuestionRow;
  position: number;
  duplicate: boolean;
  onChange: (row: QuestionRow) => void;
  onRemove: () => void;
}) {
  const idInputId = useId();
  const typeId = useId();
  const blank = row.id.trim().length === 0;
  const type = row.criteria.type;

  return (
    <li
      data-testid="question-row"
      data-question-id={row.id}
      data-question-type={type}
      className={`hard-card border-l-8 p-4 ${TYPE_ACCENTS[type]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-[var(--color-ink-soft)]">
          Question {position} · <span className="font-mono text-[var(--color-ink)]">{type}</span>
        </span>
        <button
          type="button"
          data-testid="remove-question"
          className={removeButtonClass}
          onClick={onRemove}
        >
          Remove question
        </button>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <div className="min-w-0">
          <label htmlFor={idInputId} className="field-label">
            Question ID
          </label>
          <input
            id={idInputId}
            data-testid="question-id-input"
            value={row.id}
            spellCheck={false}
            onChange={(event) => onChange({ ...row, id: event.target.value })}
            aria-invalid={duplicate || blank}
            className={`${inputClass} mt-1`}
          />
          {duplicate ? (
            <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-danger)]">
              Another question already uses this id. Both are kept; rename one.
            </p>
          ) : blank ? (
            <p className="mt-0.5 text-[11px] font-semibold text-[var(--color-danger)]">
              A question id must not be empty.
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <label htmlFor={typeId} className="field-label">
            Type
          </label>
          <select
            id={typeId}
            data-testid="question-type"
            value={type}
            onChange={(event) =>
              onChange(changeQuestionType(row, event.target.value as QuestionType))
            }
            className="input mt-1 min-h-9 px-2 py-1 text-xs font-semibold"
          >
            {(Object.keys(TYPE_LABELS) as QuestionType[]).map((candidate) => (
              <option key={candidate} value={candidate}>
                {TYPE_LABELS[candidate]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3">
        <FieldEditor
          label="Instructions"
          field={row.instructions}
          kinds={["text", "json"]}
          testId="question-instructions"
          rows={3}
          onChange={(instructions) => onChange({ ...row, instructions })}
        />
      </div>

      <CriteriaEditor
        criteria={row.criteria}
        questionId={row.id}
        onChange={(criteria) => onChange({ ...row, criteria })}
      />
    </li>
  );
}

export function QuestionEditor({
  rows,
  onChange,
}: {
  rows: QuestionRow[];
  onChange: (rows: QuestionRow[]) => void;
}) {
  const duplicates = duplicateRowIds(rows);

  return (
    <section aria-labelledby="questions-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="questions-heading" className="text-lg font-extrabold" data-testid="question-count">
          Questions ({rows.length})
        </h3>
        <span className="badge shadow-[3px_3px_0_var(--color-line)]">
          {rows.length} · sent together in one request
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        Each card is one question, but all of them travel in the same single
        request — there is no per-card submission. A question id is a key for
        code, not sent to the model, and no question can read another
        question&rsquo;s answer. Changing a type resets that question&rsquo;s
        criteria.
      </p>
      <ul role="list" className="mt-4 space-y-6">
        {rows.map((row, index) => (
          <QuestionCard
            key={row.key}
            row={row}
            position={index + 1}
            duplicate={duplicates.has(row.id)}
            onChange={(next) =>
              onChange(rows.map((entry) => (entry.key === row.key ? next : entry)))
            }
            onRemove={() => onChange(rows.filter((entry) => entry.key !== row.key))}
          />
        ))}
      </ul>
      <button
        type="button"
        data-testid="add-question"
        className="btn mt-6"
        onClick={() => onChange([...rows, newQuestionRow(rows)])}
      >
        + Add question
      </button>
    </section>
  );
}

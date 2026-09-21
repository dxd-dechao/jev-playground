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

/** Score accepts 2–10 levels; the Form will not add an eleventh. */
const MAX_SCORE_LEVELS = 10;

const inputClass =
  "w-full rounded-md border bg-[var(--color-canvas)] px-2 py-1 font-mono text-xs";
const smallButtonClass =
  "rounded-md border border-[var(--color-line)] px-2 py-0.5 text-[11px] font-medium hover:border-[var(--color-ink-soft)] disabled:cursor-not-allowed disabled:opacity-50";

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
        <label htmlFor={editable ? textId : kindId} className="text-xs font-medium">
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
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-1.5 py-0.5 text-[11px]"
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
            className={`mt-1 w-full resize-y rounded-md border bg-[var(--color-canvas)] p-2 text-xs leading-relaxed ${
              field.kind === "json" ? "font-mono" : ""
            } ${invalid ? "border-[var(--color-danger)]" : "border-[var(--color-line)]"}`}
          />
          {invalid ? (
            <p id={errorId} className="mt-0.5 text-[11px] text-[var(--color-danger)]">
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
    <div className="mt-3">
      <h5 className="text-xs font-semibold">
        Options ({options.length}) — at least 2, at most 255
      </h5>
      <ol className="mt-1.5 space-y-2">
        {options.map((option, index) => (
          <li
            key={option.key}
            data-testid="choice-option"
            className="rounded-md border border-[var(--color-line)] p-2"
          >
            <OptionName
              value={option.name}
              duplicate={duplicates.has(option.name)}
              label={`Option ${index + 1} key for ${questionId || "this question"}`}
              onChange={(name) => update(option.key, (current) => ({ ...current, name }))}
            />
            <div className="mt-1.5">
              <FieldEditor
                label="Description"
                field={option.description}
                kinds={["null", "text", "json"]}
                testId="option-description"
                onChange={(description) =>
                  update(option.key, (current) => ({ ...current, description }))
                }
              />
            </div>
            <button
              type="button"
              data-testid="remove-option"
              className={`${smallButtonClass} mt-1.5`}
              onClick={() => onChange(options.filter((entry) => entry.key !== option.key))}
            >
              Remove option
            </button>
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
        Add option
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
    <div>
      <label htmlFor={id} className="text-xs font-medium">
        Option key
      </label>
      <input
        id={id}
        data-testid="option-name"
        aria-label={label}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={duplicate || blank}
        className={`${inputClass} mt-1 ${
          duplicate || blank ? "border-[var(--color-danger)]" : "border-[var(--color-line)]"
        }`}
      />
      {duplicate ? (
        <p className="mt-0.5 text-[11px] text-[var(--color-danger)]">
          Another option already uses this key. Both are kept; rename one.
        </p>
      ) : blank ? (
        <p className="mt-0.5 text-[11px] text-[var(--color-danger)]">
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
    <div className="mt-3">
      <h5 className="text-xs font-semibold">
        Levels ({levels.length}) — lowest first, 2 to {MAX_SCORE_LEVELS}
      </h5>
      <ol className="mt-1.5 space-y-2">
        {levels.map((level, index) => (
          <li
            key={level.key}
            data-testid="score-level-row"
            className="rounded-md border border-[var(--color-line)] p-2"
          >
            <FieldEditor
              label={`Level ${index}`}
              field={level.value}
              kinds={["text", "json"]}
              testId="score-level"
              onChange={(value) =>
                onChange(levels.map((entry) => (entry.key === level.key ? { ...entry, value } : entry)))
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
                Move up
              </button>
              <button
                type="button"
                data-testid="level-down"
                className={smallButtonClass}
                disabled={index === levels.length - 1}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                data-testid="remove-level"
                className={smallButtonClass}
                onClick={() => onChange(levels.filter((entry) => entry.key !== level.key))}
              >
                Remove level
              </button>
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
        Add level
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
      <div className="mt-3 space-y-2">
        <h5 className="text-xs font-semibold">Yes / no descriptions (optional)</h5>
        <FieldEditor
          label="Yes means"
          field={criteria.yes}
          kinds={["absent", "text", "json"]}
          testId="noul-true"
          onChange={(yes) => onChange({ ...criteria, yes })}
        />
        <FieldEditor
          label="No means"
          field={criteria.no}
          kinds={["absent", "text", "json"]}
          testId="noul-false"
          onChange={(no) => onChange({ ...criteria, no })}
        />
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
  duplicate,
  onChange,
  onRemove,
}: {
  row: QuestionRow;
  duplicate: boolean;
  onChange: (row: QuestionRow) => void;
  onRemove: () => void;
}) {
  const idInputId = useId();
  const typeId = useId();
  const blank = row.id.trim().length === 0;

  return (
    <li
      data-testid="question-row"
      data-question-id={row.id}
      className="rounded-lg border border-[var(--color-line)] p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={idInputId} className="text-xs font-medium">
            Question id
          </label>
          <input
            id={idInputId}
            data-testid="question-id-input"
            value={row.id}
            spellCheck={false}
            onChange={(event) => onChange({ ...row, id: event.target.value })}
            aria-invalid={duplicate || blank}
            className={`${inputClass} mt-1 ${
              duplicate || blank ? "border-[var(--color-danger)]" : "border-[var(--color-line)]"
            }`}
          />
          {duplicate ? (
            <p className="mt-0.5 text-[11px] text-[var(--color-danger)]">
              Another question already uses this id. Both are kept; rename one.
            </p>
          ) : blank ? (
            <p className="mt-0.5 text-[11px] text-[var(--color-danger)]">
              A question id must not be empty.
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <label htmlFor={typeId} className="text-xs font-medium">
            Type
          </label>
          <select
            id={typeId}
            data-testid="question-type"
            value={row.criteria.type}
            onChange={(event) =>
              onChange(changeQuestionType(row, event.target.value as QuestionType))
            }
            className="mt-1 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1 text-xs"
          >
            {(Object.keys(TYPE_LABELS) as QuestionType[]).map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
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

      <button
        type="button"
        data-testid="remove-question"
        className={`${smallButtonClass} mt-3`}
        onClick={onRemove}
      >
        Remove question
      </button>
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
    <div>
      <h3 className="text-sm font-semibold" data-testid="question-count">
        Questions ({rows.length}, evaluated together)
      </h3>
      <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
        Each question is self-contained: a question id is a key for code, not
        sent to the model, and no question can read another question&rsquo;s
        answer in the same request. Changing a type resets that question&rsquo;s
        criteria.
      </p>
      <ul role="list" className="mt-3 space-y-3">
        {rows.map((row) => (
          <QuestionCard
            key={row.key}
            row={row}
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
        className="mt-3 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium hover:border-[var(--color-ink-soft)]"
        onClick={() => onChange([...rows, newQuestionRow(rows)])}
      >
        Add question
      </button>
    </div>
  );
}

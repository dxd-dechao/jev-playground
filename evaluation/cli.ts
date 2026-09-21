/**
 * Evaluation CLI.
 *
 * Offline (free, no credential, no network):
 *
 *   prepare   --suite municipal|safety --split development|heldout --out <dir>
 *   mock-run  --prepared <dir> --out <dir> [--error-policy continue|stop]
 *   score     --suite municipal|safety --manifest <file> --predictions <file> --out <dir>
 *   preflight --out <dir>
 *
 * Live (JEV-06, spends money, explicit opt-in every time):
 *
 *   smoke     --out <dir> --max-calls <n> [--model <id>] --confirm-live | --dry-run
 *   live      --prepared <dir> --out <dir> --max-calls <n> [--model <id>]
 *             [--error-policy continue|stop] --confirm-live | --dry-run
 *
 * HOW THE OFFLINE COMMANDS STAY OFFLINE
 * -------------------------------------
 * `./live` and `./smoke` are loaded by dynamic import, inside the two live
 * command handlers only. `prepare`, `mock-run`, `score`, and `preflight`
 * therefore never load `lib/evaluation.ts` or the TypeSafe SDK at all — the
 * provider code is not merely unused, it is not in the process.
 *
 * A live command additionally requires an explicit numeric `--max-calls` and a
 * deliberate `--confirm-live`. There is no environment-variable switch and no
 * credential-driven fallback, so `npm test`, `npm run build`, and ordinary CLI
 * use cannot spend money by omission.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMockEvaluator,
  defaultQuestions,
  inputHash,
  labelInventory,
  labelsHash,
  prepareRun,
  questionsHash,
  readJson,
  readJsonl,
  runCases,
  scoreRun,
  sha256,
  splitManifestHash,
  SPLIT_NAMES,
  stableStringify,
  SUITE_IDS,
  toJsonl,
  writeJson,
  writeJsonl,
  type ErrorPolicy,
  type EvalCase,
  type LabelInventory,
  type PredictionRow,
  type PreparedRequest,
  type PreparedRun,
  type RunManifest,
  type SplitName,
  type SuiteDefinition,
  type SuiteId,
} from "./shared";
import type { EvaluateFn } from "./live";

export const OUTPUT_FILES = {
  prepared: "prepared-run.json",
  requests: "requests.jsonl",
  runManifest: "run-manifest.json",
  predictions: "predictions.jsonl",
  reportJson: "report.json",
  reportMarkdown: "report.md",
  preflight: "preflight.json",
  smoke: "smoke-run.json",
  liveRun: "live-run.json",
} as const;

type AnySuite = SuiteDefinition<EvalCase>;

export interface CliDeps {
  /** Override suite modules (tests). Default: `evaluation/<suite>/index.ts`. */
  suites?: Partial<Record<SuiteId, AnySuite>>;
  codeRevision?: string | null;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Replaces `evaluateSystemOne` in the live adapter. Tests pass a fake so the
   * live commands are exercised end to end without a provider call. Production
   * callers pass nothing and get the real adapter.
   */
  liveEvaluate?: EvaluateFn;
  /** Injected millisecond clock for the live runners (tests). */
  monotonic?: () => number;
}

async function loadSuite(id: SuiteId, deps: CliDeps): Promise<AnySuite> {
  const injected = deps.suites?.[id];
  if (injected) return injected;
  const url = new URL(`./${id}/index.ts`, import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ url)) as { suite?: AnySuite };
  if (!mod.suite || mod.suite.id !== id) {
    throw new Error(`evaluation/${id}/index.ts must export \`suite\` with id "${id}"`);
  }
  return mod.suite;
}

function gitRevision(): string | null {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Flags that stand alone. They are spelled out in full on the command line —
 * there is no short form for `--confirm-live`, because the point of it is that
 * nobody types it by reflex.
 */
export const BOOLEAN_FLAGS: readonly string[] = ["confirm-live", "dry-run"];

export function parseArgs(argv: readonly string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv.filter((a) => a !== "--");
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i]!;
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = "true";
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    flags[name] = value;
    i += 1;
  }
  return { command, flags };
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function flag(flags: Record<string, string>, name: string): boolean {
  return flags[name] === "true";
}

/** An explicit positive integer. No default: a spending cap is never implied. */
function positiveInteger(value: string, name: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`--${name} must be a whole number`);
  const parsed = Number(value);
  if (parsed <= 0) throw new Error(`--${name} must be greater than zero`);
  return parsed;
}

/**
 * Claim a fresh output directory.
 *
 * A live run is not repeatable for free, so overwriting one is refused outright
 * rather than merged, backed up, or suffixed.
 */
function claimOutputDir(out: string): string {
  if (existsSync(out)) {
    throw new Error(`${out} already exists; a live run never overwrites an existing output directory`);
  }
  mkdirSync(out, { recursive: true });
  return out;
}

export const USAGE = `Usage (offline — free, no credential, no network):
  eval:prepare   -- --suite municipal|safety --split development|heldout --out <dir>
  eval:mock-run  -- --prepared <dir> --out <dir> [--error-policy continue|stop]
  eval:score     -- --suite municipal|safety --manifest <file> --predictions <file> --out <dir>
  eval:preflight -- --out <dir>

Usage (live — SPENDS MONEY; --max-calls and --confirm-live are both required):
  eval:smoke     -- --out <dir> --max-calls <n> [--model <id>] (--confirm-live | --dry-run)
  eval:live      -- --prepared <dir> --out <dir> --max-calls <n> [--model <id>]
                    [--error-policy continue|stop] (--confirm-live | --dry-run)`;

/**
 * Keys that may never appear anywhere inside a built **State**.
 *
 * Two deliberate narrowings:
 *
 * 1. Keys, not text. A resident's feedback may legitimately contain almost any
 *    English word, so a substring scan for "proposed" or "reviewed" would fail
 *    on a sentence about a proposed bus route. State is assembled from a
 *    whitelist, so a label *key* appearing at all is the defect.
 * 2. State, not the whole request. `review` is one of the safety preset's own
 *    `handling` options, so it legitimately appears as a criteria key in
 *    `questions`. The questions are checked a stronger way instead — by hash
 *    against the frozen preset.
 */
export const FORBIDDEN_STATE_KEYS: readonly string[] = [
  "labels",
  "provenance",
  "rationale",
  "review",
  "reviewer",
  "reviewedOn",
  "proposedValue",
  "groupId",
  "slices",
  "notes",
  "expected",
  "caseId",
  "primary_agency",
  "acceptable_agencies",
  "disposition",
  "tag",
];

/** The exact State keys each suite's requests are allowed to carry. */
export const ALLOWED_STATE_KEYS: Record<SuiteId, readonly string[]> = {
  municipal: ["agency_config", "clarification_history", "feedback"],
  safety: ["conversation_history", "learning_context", "student_message"],
};

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, member] of Object.entries(value)) {
      into.add(key);
      collectKeys(member, into);
    }
  }
}

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { command, flags } = parseArgs(argv);

  if (command === "prepare") {
    const suite = await loadSuite(oneOf(required(flags, "suite"), SUITE_IDS, "suite"), deps);
    const split = oneOf<SplitName>(required(flags, "split"), SPLIT_NAMES, "split");
    const out = resolve(required(flags, "out"));
    const { prepared, requests } = prepareRun(suite, {
      split,
      codeRevision: deps.codeRevision !== undefined ? deps.codeRevision : gitRevision(),
      preparedAt: (deps.now ?? (() => new Date()))().toISOString(),
    });
    mkdirSync(out, { recursive: true });
    writeJson(join(out, OUTPUT_FILES.prepared), prepared);
    writeJsonl(join(out, OUTPUT_FILES.requests), requests);
    log(`Prepared ${requests.length} ${suite.id}/${split} requests (label-free) in ${out}`);
    return;
  }

  if (command === "mock-run") {
    const dir = resolve(required(flags, "prepared"));
    const out = resolve(required(flags, "out"));
    const errorPolicy = oneOf<ErrorPolicy>(flags["error-policy"] ?? "continue", ["continue", "stop"], "error-policy");
    const prepared = readJson<PreparedRun>(join(dir, OUTPUT_FILES.prepared));
    const requests = readJsonl<PreparedRequest>(join(dir, OUTPUT_FILES.requests));
    const suite = await loadSuite(prepared.suite, deps);
    const { manifest, rows } = await runCases({
      prepared,
      requests,
      evaluator: createMockEvaluator(),
      compose: suite.compose,
      provenance: "mock",
      requestedModel: null,
      errorPolicy,
      now: null,
    });
    mkdirSync(out, { recursive: true });
    writeJson(join(out, OUTPUT_FILES.runManifest), manifest);
    writeJsonl(join(out, OUTPUT_FILES.predictions), rows);
    log(
      `MOCK run: ${manifest.counts.ok} ok, ${manifest.counts.error} error, ` +
        `${manifest.counts.notAttempted} not attempted of ${manifest.counts.selected} in ${out}`,
    );
    return;
  }

  if (command === "score") {
    const suite = await loadSuite(oneOf(required(flags, "suite"), SUITE_IDS, "suite"), deps);
    const manifest = readJson<RunManifest>(resolve(required(flags, "manifest")));
    const rows = readJsonl(resolve(required(flags, "predictions")));
    const out = resolve(required(flags, "out"));
    const report = scoreRun(suite, manifest, rows);
    mkdirSync(out, { recursive: true });
    writeJson(join(out, OUTPUT_FILES.reportJson), report.json);
    writeFileSync(
      join(out, OUTPUT_FILES.reportMarkdown),
      report.markdown.endsWith("\n") ? report.markdown : `${report.markdown}\n`,
    );
    log(`Scored ${manifest.caseIds.length} ${suite.id}/${manifest.split} cases (${manifest.provenance}) in ${out}`);
    return;
  }

  if (command === "preflight") {
    const out = resolve(required(flags, "out"));
    const report = await preflight(out, deps);
    mkdirSync(out, { recursive: true });
    writeJson(join(out, OUTPUT_FILES.preflight), report);
    for (const line of preflightLines(report)) log(line);
    if (!report.ok) throw new Error("Preflight failed; see the problems above. No live stage may start.");
    return;
  }

  if (command === "smoke") {
    const out = resolve(required(flags, "out"));
    const maxCalls = positiveInteger(required(flags, "max-calls"), "max-calls");
    const pinned = flags["model"] ?? null;

    // Loaded here and nowhere else, so no offline command pulls in the SDK.
    const live = await import("./live");
    const { runSmoke, SMOKE_MAX_CALLS, smokeSamples, frozenModel } = await import("./smoke");
    const samples = smokeSamples();

    if (samples.length > maxCalls) {
      throw new Error(`The smoke check needs ${samples.length} calls but --max-calls is ${maxCalls}; refusing to start`);
    }
    if (samples.length !== SMOKE_MAX_CALLS) {
      throw new Error(`Expected ${SMOKE_MAX_CALLS} visible samples but found ${samples.length}; refusing to start`);
    }

    const requested = pinned ?? live.requestedModel();
    if (flag(flags, "dry-run")) {
      // Prints what a live run would do. Reads no credential and calls nothing.
      log(
        [
          "DRY RUN — no provider call, no credential read.",
          `  stage:           smoke (visible playground samples)`,
          `  suites:          safety ${samples.filter((s) => s.scenario === "safety").length}, municipal ${samples.filter((s) => s.scenario === "municipal").length}`,
          `  calls:           ${samples.length} (one per sample, no retries)`,
          `  max-calls:       ${maxCalls}`,
          `  requested model: ${requested}`,
          `  output:          ${out}`,
          "Add --confirm-live to spend the calls.",
        ].join("\n"),
      );
      return;
    }
    if (!flag(flags, "confirm-live")) {
      throw new Error("Live evaluation spends money. Pass --confirm-live to authorize it, or --dry-run to preview.");
    }

    claimOutputDir(out);
    const record = await live.withPinnedModel(pinned, async () => {
      const handle = live.createLiveEvaluator({
        confirmLive: true,
        maxCalls,
        ...(deps.liveEvaluate ? { evaluate: deps.liveEvaluate } : {}),
      });
      return runSmoke({
        live: handle,
        requestedModel: live.requestedModel(),
        codeRevision: deps.codeRevision !== undefined ? deps.codeRevision : gitRevision(),
        startedAt: (deps.now ?? (() => new Date()))().toISOString(),
        ...(deps.monotonic ? { now: deps.monotonic } : {}),
      });
    });

    live.writeFileAtomic(join(out, OUTPUT_FILES.smoke), JSON.stringify(JSON.parse(stableStringify(record)), null, 2) + "\n");
    const freeze = frozenModel(record);
    log(
      `SMOKE: ${record.counts.ok} ok, ${record.counts.error} error, ${record.counts.notAttempted} not attempted ` +
        `of ${record.counts.total}; ${record.providerAttempts} provider attempts (cap ${maxCalls}) in ${out}`,
    );
    log(
      freeze.model !== null
        ? `Model freeze: all successful calls resolved to ${freeze.model}.`
        : `Model freeze NOT established: ${freeze.reason}. The dataset stage must not start.`,
    );
    if (freeze.model === null) {
      throw new Error("Smoke did not fully succeed on one resolved model; the dataset stage is blocked.");
    }
    return;
  }

  if (command === "live") {
    const dir = resolve(required(flags, "prepared"));
    const out = resolve(required(flags, "out"));
    const maxCalls = positiveInteger(required(flags, "max-calls"), "max-calls");
    const errorPolicy = oneOf<ErrorPolicy>(flags["error-policy"] ?? "continue", ["continue", "stop"], "error-policy");
    const pinned = flags["model"] ?? null;
    const prepared = readJson<PreparedRun>(join(dir, OUTPUT_FILES.prepared));
    const requests = readJsonl<PreparedRequest>(join(dir, OUTPUT_FILES.requests));
    const selected = prepared.caseIds.length;

    const live = await import("./live");
    const requested = pinned ?? live.requestedModel();

    if (selected > maxCalls) {
      throw new Error(
        `This run would attempt ${selected} calls but --max-calls is ${maxCalls}; refusing to start. ` +
          "Raise the authorized cap deliberately or prepare a smaller split.",
      );
    }
    if (flag(flags, "dry-run")) {
      log(
        [
          "DRY RUN — no provider call, no credential read.",
          `  suite:           ${prepared.suite}`,
          `  split:           ${prepared.split}`,
          `  calls:           ${selected} (one per case, no retries)`,
          `  max-calls:       ${maxCalls}`,
          `  error policy:    ${errorPolicy}`,
          `  requested model: ${requested}`,
          `  prepared:        ${dir}`,
          `  output:          ${out}`,
          "Add --confirm-live to spend the calls.",
        ].join("\n"),
      );
      return;
    }
    if (!flag(flags, "confirm-live")) {
      throw new Error("Live evaluation spends money. Pass --confirm-live to authorize it, or --dry-run to preview.");
    }

    const suite = await loadSuite(prepared.suite, deps);
    claimOutputDir(out);
    const startedAt = (deps.now ?? (() => new Date()))().toISOString();
    const { manifest, rows, handle } = await live.withPinnedModel(pinned, async () => {
      const liveHandle = live.createLiveEvaluator({
        confirmLive: true,
        maxCalls,
        ...(deps.liveEvaluate ? { evaluate: deps.liveEvaluate } : {}),
      });
      const result = await runCases({
        prepared,
        requests,
        evaluator: liveHandle.evaluator,
        compose: suite.compose,
        provenance: "live",
        // Recorded as asked for, not as resolved: the rows carry what came back.
        requestedModel: live.requestedModel(),
        errorPolicy,
        ...(deps.monotonic ? { now: deps.monotonic } : {}),
      });
      return { ...result, handle: liveHandle };
    });

    const okRows = rows.filter((r): r is PredictionRow => r.status === "ok");
    const liveRun = {
      schemaVersion: 1 as const,
      stage: "dataset" as const,
      suite: manifest.suite,
      split: manifest.split,
      startedAt,
      finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
      requestedModel: manifest.requestedModel,
      pinnedModel: pinned,
      maxCalls,
      /** Attempts dispatched to the provider — not the same as error rows. */
      providerAttempts: handle.attempts(),
      unusedBudget: maxCalls - handle.attempts(),
      halted: handle.halted(),
      resolvedModels: handle.resolvedModels(),
      counts: manifest.counts,
      errorPolicy,
      latency: live.latencySummary(okRows.flatMap((r) => (r.durationMs === undefined ? [] : [r.durationMs]))),
      usageTotals: usageTotals(okRows),
      preparedFrom: dir,
    };

    live.writeFileAtomic(join(out, OUTPUT_FILES.runManifest), JSON.stringify(JSON.parse(stableStringify(manifest)), null, 2) + "\n");
    live.writeFileAtomic(join(out, OUTPUT_FILES.predictions), toJsonl(rows));
    live.writeFileAtomic(join(out, OUTPUT_FILES.liveRun), JSON.stringify(JSON.parse(stableStringify(liveRun)), null, 2) + "\n");

    log(
      `LIVE ${manifest.suite}/${manifest.split}: ${manifest.counts.ok} ok, ${manifest.counts.error} error, ` +
        `${manifest.counts.notAttempted} not attempted of ${manifest.counts.selected}; ` +
        `${liveRun.providerAttempts} provider attempts (cap ${maxCalls}, ${liveRun.unusedBudget} unused) in ${out}`,
    );
    if (liveRun.halted !== null) {
      log(`Run halted after ${liveRun.halted.afterAttempts} attempts on ${liveRun.halted.code}; later cases were not sent.`);
    }
    if (liveRun.resolvedModels.length > 1) {
      log(`WARNING: ${liveRun.resolvedModels.length} different resolved models in one run; scoring will refuse this file.`);
    }
    return;
  }

  throw new Error(`Unknown command "${command}".\n${USAGE}`);
}

/* ---------------------------------------------------------- Preflight -- */

export interface PreflightSplit {
  split: SplitName;
  preparedDir: string;
  cases: number;
  expectedCases: number;
  /** SHA-256 of the written `requests.jsonl`. */
  requestsHash: string;
  /** Does a second preparation produce byte-identical requests? */
  deterministic: boolean;
}

export interface PreflightSuite {
  suite: SuiteId;
  datasetVersion: string;
  cases: number;
  sourceHash: string;
  inputHash: string;
  labelsHash: string;
  splitManifestHash: string;
  questionsHash: string;
  /** Does the suite still submit the preset's unchanged questions? */
  questionsFrozen: boolean;
  policyRevision: string;
  labelInventory: LabelInventory;
  splits: PreflightSplit[];
}

export interface PreflightReport {
  schemaVersion: 1;
  ok: boolean;
  generatedAt: string;
  codeRevision: string | null;
  /** Requests prepared across all four suite/split combinations. */
  totalRequests: number;
  problems: string[];
  suites: PreflightSuite[];
  notes: string[];
}

export const PREFLIGHT_NOTES: readonly string[] = [
  "Zero provider calls: this command never loads the live adapter or the SDK.",
  "A passing preflight means the inputs are well formed and label-free. It says nothing about credentials, connectivity, or model behaviour.",
  "Label isolation is asserted structurally on State keys, not by scanning text for label words.",
];

/**
 * The zero-call gate before any paid stage.
 *
 * Prepares all four suite/split request sets fresh, then checks counts against
 * the committed split manifests, structural label isolation, frozen preset
 * questions, and repeat-preparation determinism. It reports every problem it
 * finds rather than throwing on the first one, because the point is to hand back
 * a complete picture before anyone spends money.
 */
export async function preflight(out: string, deps: CliDeps = {}): Promise<PreflightReport> {
  const problems: string[] = [];
  const suites: PreflightSuite[] = [];
  let totalRequests = 0;
  const codeRevision = deps.codeRevision !== undefined ? deps.codeRevision : gitRevision();

  for (const suiteId of SUITE_IDS) {
    const suite = await loadSuite(suiteId, deps);
    const dataset = suite.loadDataset();
    const splitManifest = suite.loadSplitManifest();
    const frozen = questionsHash(defaultQuestions(suiteId));
    const suiteQuestionsHash = questionsHash(suite.questions);
    if (suiteQuestionsHash !== frozen) {
      problems.push(`${suiteId}: the suite's questions differ from the preset's default questions`);
    }

    const splits: PreflightSplit[] = [];
    for (const split of SPLIT_NAMES) {
      const preparedDir = join(out, `${suiteId}-${split}`);
      const first = prepareRun(suite, { split, codeRevision, preparedAt: "1970-01-01T00:00:00.000Z" });
      const second = prepareRun(suite, { split, codeRevision, preparedAt: "2000-01-01T00:00:00.000Z" });
      const requestsText = toJsonl(first.requests);
      const deterministic = requestsText === toJsonl(second.requests);
      if (!deterministic) problems.push(`${suiteId}/${split}: repeated preparation produced different requests`);

      const expected = splitManifest.counts[split].cases;
      if (first.requests.length !== expected) {
        problems.push(
          `${suiteId}/${split}: prepared ${first.requests.length} requests but the committed split names ${expected}`,
        );
      }

      const byId = new Map(dataset.cases.map((c) => [c.id, c]));
      for (const row of first.requests) {
        const at = `${suiteId}/${split} ${row.caseId}`;
        const rowKeys = Object.keys(row).sort();
        if (stableStringify(rowKeys) !== stableStringify(["caseId", "request"])) {
          problems.push(`${at}: a prepared row must have exactly caseId and request`);
        }
        const requestKeys = Object.keys(row.request).sort();
        if (stableStringify(requestKeys) !== stableStringify(["questions", "state"])) {
          problems.push(`${at}: a request must have exactly state and questions`);
        }
        const stateKeys = Object.keys(row.request.state).sort();
        if (stableStringify(stateKeys) !== stableStringify([...ALLOWED_STATE_KEYS[suiteId]])) {
          problems.push(`${at}: State keys ${stateKeys.join(", ")} are not the ${suiteId} whitelist`);
        }
        const keys = new Set<string>();
        collectKeys(row.request.state, keys);
        for (const forbidden of FORBIDDEN_STATE_KEYS) {
          if (keys.has(forbidden)) problems.push(`${at}: State contains the forbidden key "${forbidden}"`);
        }
        if (questionsHash(row.request.questions) !== frozen) {
          problems.push(`${at}: the request does not carry the preset's frozen questions`);
        }
        const serialized = stableStringify(row.request);
        if (serialized.includes(row.caseId)) problems.push(`${at}: the case ID appears inside the request`);
        const notes = byId.get(row.caseId)?.notes;
        if (typeof notes === "string" && notes.trim() !== "" && serialized.includes(notes)) {
          problems.push(`${at}: reviewer notes appear inside the request`);
        }
      }

      mkdirSync(preparedDir, { recursive: true });
      writeJson(join(preparedDir, OUTPUT_FILES.prepared), first.prepared);
      writeFileSync(join(preparedDir, OUTPUT_FILES.requests), requestsText);
      totalRequests += first.requests.length;
      splits.push({
        split,
        preparedDir,
        cases: first.requests.length,
        expectedCases: expected,
        requestsHash: sha256(requestsText),
        deterministic,
      });
    }

    suites.push({
      suite: suiteId,
      datasetVersion: dataset.datasetVersion,
      cases: dataset.cases.length,
      sourceHash: dataset.sourceHash,
      inputHash: inputHash(dataset.cases),
      labelsHash: labelsHash(dataset.cases),
      splitManifestHash: splitManifestHash(splitManifest),
      questionsHash: suiteQuestionsHash,
      questionsFrozen: suiteQuestionsHash === frozen,
      policyRevision: suite.policyRevision,
      labelInventory: labelInventory(dataset.cases),
      splits,
    });
  }

  return {
    schemaVersion: 1,
    ok: problems.length === 0,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    codeRevision,
    totalRequests,
    problems,
    suites,
    notes: [...PREFLIGHT_NOTES],
  };
}

export function preflightLines(report: PreflightReport): string[] {
  const lines = [`PREFLIGHT ${report.ok ? "PASS" : "FAIL"} — ${report.totalRequests} requests prepared, zero provider calls`];
  for (const suite of report.suites) {
    lines.push(
      `  ${suite.suite}: ${suite.cases} cases, questions ${suite.questionsFrozen ? "frozen" : "CHANGED"} ` +
        `(${suite.questionsHash.slice(0, 12)}…), labels ${suite.labelsHash.slice(0, 12)}…`,
    );
    for (const split of suite.splits) {
      lines.push(
        `    ${split.split}: ${split.cases}/${split.expectedCases} cases, ` +
          `${split.deterministic ? "deterministic" : "NOT DETERMINISTIC"}, requests ${split.requestsHash.slice(0, 12)}…`,
      );
    }
    for (const [field, counts] of Object.entries(suite.labelInventory)) {
      lines.push(
        `    label ${field}: inherited ${counts.inherited_reference}, proposed ${counts.proposed}, ` +
          `reviewed ${counts.reviewed}, absent ${counts.absent}`,
      );
    }
  }
  for (const problem of report.problems) lines.push(`  PROBLEM: ${problem}`);
  return lines;
}

export interface TokenTotal {
  total: number;
  /** How many successful rows reported this field. */
  rows: number;
}

/**
 * Token totals over successful rows, or `null` when nothing reported usage.
 *
 * `Usage` makes each field individually optional on purpose: a response that
 * reports only `input_tokens` keeps that number and leaves the other absent.
 * So each field is summed over the rows that actually reported it and carries
 * its own row count — a total over 140 of 150 rows is not a total over 150.
 */
function usageTotals(rows: readonly PredictionRow[]): {
  rowsReportingUsage: number;
  inputTokens: TokenTotal | null;
  outputTokens: TokenTotal | null;
} | null {
  const values = (pick: (usage: NonNullable<PredictionRow["usage"]>) => number | undefined) =>
    rows.flatMap((r) => {
      const value = r.usage === undefined ? undefined : pick(r.usage);
      return value === undefined ? [] : [value];
    });
  const input = values((u) => u.input_tokens);
  const output = values((u) => u.output_tokens);
  if (input.length === 0 && output.length === 0) return null;
  const total = (xs: number[]): TokenTotal | null =>
    xs.length === 0 ? null : { total: xs.reduce((sum, x) => sum + x, 0), rows: xs.length };
  return {
    rowsReportingUsage: rows.filter((r) => r.usage !== undefined).length,
    inputTokens: total(input),
    outputTokens: total(output),
  };
}

/**
 * Offline evaluation CLI.
 *
 *   prepare   --suite municipal|safety --split development|heldout --out <dir>
 *   mock-run  --prepared <dir> --out <dir> [--error-policy continue|stop]
 *   score     --suite municipal|safety --manifest <file> --predictions <file> --out <dir>
 *
 * None of these commands creates a TypeSafe client, reads an API credential,
 * or touches the network. There is no live switch here: a live runner is a
 * separate JEV-06 deliverable with its own budget and approval.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMockEvaluator,
  prepareRun,
  readJson,
  readJsonl,
  runCases,
  scoreRun,
  SPLIT_NAMES,
  SUITE_IDS,
  writeJson,
  writeJsonl,
  type ErrorPolicy,
  type EvalCase,
  type PreparedRequest,
  type PreparedRun,
  type RunManifest,
  type SplitName,
  type SuiteDefinition,
  type SuiteId,
} from "./shared";

export const OUTPUT_FILES = {
  prepared: "prepared-run.json",
  requests: "requests.jsonl",
  runManifest: "run-manifest.json",
  predictions: "predictions.jsonl",
  reportJson: "report.json",
  reportMarkdown: "report.md",
} as const;

type AnySuite = SuiteDefinition<EvalCase>;

export interface CliDeps {
  /** Override suite modules (tests). Default: `evaluation/<suite>/index.ts`. */
  suites?: Partial<Record<SuiteId, AnySuite>>;
  codeRevision?: string | null;
  now?: () => Date;
  log?: (line: string) => void;
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

export function parseArgs(argv: readonly string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv.filter((a) => a !== "--");
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i]!;
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    flags[key.slice(2)] = value;
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

export const USAGE = `Usage:
  eval:prepare  -- --suite municipal|safety --split development|heldout --out <dir>
  eval:mock-run -- --prepared <dir> --out <dir> [--error-policy continue|stop]
  eval:score    -- --suite municipal|safety --manifest <file> --predictions <file> --out <dir>`;

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

  throw new Error(`Unknown command "${command}".\n${USAGE}`);
}

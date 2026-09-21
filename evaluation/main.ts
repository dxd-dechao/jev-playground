/** Entry point for the `eval:*` npm scripts. All logic lives in `cli.ts`. */

import { runCli } from "./cli";

runCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

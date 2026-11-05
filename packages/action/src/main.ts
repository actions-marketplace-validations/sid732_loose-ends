import { runAction } from "./run.js";

runAction(process.env, { log: (line) => console.log(line), fetch: globalThis.fetch }).then(
  (outcome) => {
    process.exitCode = outcome.exitCode;
  },
  (error: unknown) => {
    console.log(`::error title=Loose Ends crashed::${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 2;
  },
);

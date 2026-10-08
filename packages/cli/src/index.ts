import { ConfigError, CoverageError, GitError, VERSION } from "@loose-ends/core";
import { Command, CommanderError } from "commander";
import { registerCheck, UsageError } from "./commands/check.js";
import { registerInspect } from "./commands/inspect.js";
import { processIO, type CliIO } from "./io.js";

export type { CliIO } from "./io.js";

/** Build the command tree. Exposed so tests can run commands without a process. */
export function createProgram(io: CliIO, setExit: (code: number) => void): Command {
  const program = new Command("loose-ends")
    .description("Graph-powered liveness checks for AI-written code. Every change should lead somewhere.")
    .version(VERSION, "-v, --version")
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .showHelpAfterError();
  registerCheck(program, io, setExit);
  registerInspect(program, io, setExit);
  return program;
}

/** Run the CLI and return its exit code: 0 pass, 1 blocking findings, 2 usage or runtime error. */
export async function run(argv: string[], io: CliIO = processIO()): Promise<number> {
  let code = 0;
  const program = createProgram(io, (c) => (code = c));
  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    const known = error instanceof UsageError || error instanceof ConfigError || error instanceof GitError || error instanceof CoverageError;
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`loose-ends: ${message}\n`);
    if (!known && io.env.LOOSE_ENDS_DEBUG && error instanceof Error) io.stderr(`${error.stack}\n`);
    return 2;
  }
}

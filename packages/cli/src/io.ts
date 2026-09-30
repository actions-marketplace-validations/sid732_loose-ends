import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface CliIO {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdout is a terminal that supports color. */
  color: boolean;
  env: Record<string, string | undefined>;
}

export function processIO(): CliIO {
  return {
    cwd: process.cwd(),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    color: !!process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
    env: process.env,
  };
}

/** Write to a file (creating directories) or to stdout when no path is given. */
export function emit(io: CliIO, text: string, output?: string): void {
  if (!output || output === "-") {
    io.stdout(text);
    return;
  }
  const abs = resolve(io.cwd, output);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

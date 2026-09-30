import { run, type CliIO } from "loose-ends";

export async function cli(cwd: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = { cwd, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), color: false, env: {} };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

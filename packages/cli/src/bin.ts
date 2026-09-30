#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

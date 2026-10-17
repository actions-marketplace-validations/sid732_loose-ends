#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./index.js";

const rootFlag = process.argv.indexOf("--root");
const root = rootFlag !== -1 ? process.argv[rootFlag + 1] : undefined;

const server = createServer({ root });
await server.connect(new StdioServerTransport());

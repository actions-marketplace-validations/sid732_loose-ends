import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createNodeMiddleware } from "@octokit/app";
import { createApp } from "./index.js";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const privateKey = process.env.PRIVATE_KEY_PATH ? readFileSync(process.env.PRIVATE_KEY_PATH, "utf8") : env("PRIVATE_KEY").replace(/\\n/g, "\n");
const app = createApp({
  appId: env("APP_ID"),
  privateKey,
  webhookSecret: env("WEBHOOK_SECRET"),
  concurrency: Number(process.env.CONCURRENCY ?? 2),
});

const middleware = createNodeMiddleware(app, { pathPrefix: "/api/github" });
const port = Number(process.env.PORT ?? 3000);

createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (await middleware(req, res)) return;
  res.writeHead(404).end();
}).listen(port, () => console.log(`loose-ends app listening on :${port} (webhooks at /api/github/webhooks)`));

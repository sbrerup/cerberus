/** Reads the settings, wires the parts together and serves the pages. */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { App } from "./app.ts";
import { Gate } from "./gate.ts";
import { InClusterRequests } from "./kube.ts";
import { kubectlRunner } from "./runner.ts";

function setting(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is not set.`);
  return value;
}

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const MAX_FORM_BYTES = 8 * 1024;
const SWEEP_EVERY_MS = 30_000;

const requests = new InClusterRequests(setting("NAMESPACE", "cerberus"));
const gate = new Gate(requests, kubectlRunner(), {
  approvers: list(setting("APPROVERS")),
  requesters: list(setting("REQUESTERS")),
  ttlMs: Number(setting("REQUEST_TTL_MINUTES", "30")) * 60_000,
});
const app = new App(gate, requests, { origin: setting("PUBLIC_URL").replace(/\/+$/, ""), formKey: randomBytes(32) });

await gate.recover();
setInterval(() => gate.sweep().catch((error) => console.error(JSON.stringify({ event: "error", during: "sweep", error: String(error) }))), SWEEP_EVERY_MS).unref();

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value[0] : value;
    app
      .handle({ method: req.method ?? "GET", path: new URL(req.url ?? "/", "http://cerberus").pathname, headers, body: Buffer.concat(chunks).toString("utf8") })
      .catch((error) => {
        console.error(JSON.stringify({ event: "error", during: `${req.method} ${req.url}`, error: String(error) }));
        return { status: 500, headers: { "Content-Type": "text/plain" }, body: "Something went wrong inside cerberus. Reload the page to see where the request stands." };
      })
      .then((out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      });
  });
});

server.listen(Number(setting("PORT", "8080")), () => console.log(JSON.stringify({ event: "listening", port: Number(setting("PORT", "8080")) })));

// A command that is running when the pod stops is cut off; the next start says so on the request.
process.on("SIGTERM", () => process.exit(0));

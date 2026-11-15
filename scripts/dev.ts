/**
 * The page on this machine, with made-up requests and a kubectl that only pretends.
 * For looking at the page and tapping through it in a real browser:
 *
 *   npm run dev
 *
 * There is no Tailscale proxy here, so every visitor is taken to be DEV_LOGIN.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { App } from "../server/app.ts";
import { Gate } from "../server/gate.ts";
import { AGENT, FakeKubectl, FakeRequests } from "../test/fakes.ts";

const PORT = Number(process.env.PORT ?? "8080");
const DEV_LOGIN = "dev@example.org";
const origin = `http://localhost:${PORT}`;

const requests = new FakeRequests();
const now = Date.now();
requests.add("req-restart", {}, { createdAt: now - 60_000 });
requests.add("req-replay", { command: ["kubectl", "-n", "ledger", "exec", "deploy/ledger", "--", "dotnet", "Ledger.Api.dll", "replay-ingest", "--yes"], reason: "The ledger has to read the feed again after the mapping fix.", session: "ledger-quiet-harbor" }, { createdAt: now - 5 * 60_000 });
requests.add("req-refused", { command: ["kubectl", "get", "secrets", "-A", "--as=system:admin"], reason: "A request cerberus will not run, to show what that looks like." }, { createdAt: now - 2 * 60_000 });
requests.add("req-done", {}, { createdAt: now - 3_600_000, status: { phase: "Succeeded", decidedBy: DEV_LOGIN, decidedAt: new Date(now - 3_500_000).toISOString(), startedAt: new Date(now - 3_500_000).toISOString(), finishedAt: new Date(now - 3_498_000).toISOString(), exitCode: 0, output: "deployment.apps/server restarted\n" } });

const kubectl = new FakeKubectl();
const gate = new Gate(requests, kubectl.run, { approvers: [DEV_LOGIN], requesters: [AGENT], ttlMs: 30 * 60_000 });
const app = new App(gate, requests, { origin, formKey: randomBytes(32) });

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value[0] : value;
      if (req.method === "POST") console.log(`${req.method} ${req.url} origin=${headers.origin} sec-fetch-site=${headers["sec-fetch-site"]}`);
      headers["tailscale-user-login"] = DEV_LOGIN;
      app.handle({ method: req.method ?? "GET", path: new URL(req.url ?? "/", origin).pathname, headers, body: Buffer.concat(chunks).toString("utf8") }).then((out) => {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      });
    });
  })
  .listen(PORT, () => console.log(`cerberus with made-up requests: ${origin}`));

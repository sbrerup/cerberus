import assert from "node:assert/strict";
import { test } from "node:test";
import { App, type AppResponse } from "../server/app.ts";
import { phaseOf } from "../server/types.ts";
import { SEBASTIAN, START, setup } from "./fakes.ts";

const ORIGIN = "https://cerberus.example.ts.net";

function site() {
  const parts = setup();
  const app = new App(parts.gate, parts.requests, { origin: ORIGIN, formKey: Buffer.alloc(32, 7), now: () => parts.clock.now });
  const as = (login: string | undefined) => ({
    get: (path: string) => app.handle({ method: "GET", path, headers: { "tailscale-user-login": login } }),
    post: (path: string, form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) =>
      app.handle({ method: "POST", path, headers: { "tailscale-user-login": login, ...headers }, body: new URLSearchParams(form).toString() }),
  });
  return { ...parts, app, as, sebastian: as(SEBASTIAN) };
}

/** The hidden fields of the form that posts to the given address. */
function form(page: AppResponse, action: string): Record<string, string> {
  const block = new RegExp(`<form method="post" action="${action}">([\\s\\S]*?)</form>`).exec(page.body);
  assert.ok(block, `the page has a form for ${action}`);
  return Object.fromEntries([...block[1]!.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!]));
}

test("the health check answers anyone, and nothing else does", async () => {
  const { app, requests, as } = site();
  requests.add("req-1");

  assert.equal((await app.handle({ method: "GET", path: "/healthz", headers: {} })).status, 200);
  for (const login of [undefined, "someone@example.org", ""]) {
    for (const path of ["/", "/r/req-1"]) {
      const page = await as(login).get(path);
      assert.equal(page.status, 403, `${login} ${path}`);
      assert.ok(!page.body.includes("rollout"), "the refusal shows nothing of the request");
    }
    assert.equal((await as(login).post("/r/req-1/approve", {})).status, 403);
    assert.equal((await as(login).post("/r/req-1/deny", {})).status, 403);
  }
  assert.equal(phaseOf((await requests.get("req-1"))!), "Pending");
});

test("the list shows what is waiting, with the command and the reason", async () => {
  const { requests, sebastian } = site();
  requests.add("req-1");
  requests.add("req-0", {}, { createdAt: START - 60_000, status: { phase: "Succeeded", exitCode: 0 } });

  const page = await sebastian.get("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /1 request is waiting for you/);
  assert.match(page.body, /kubectl -n games rollout restart deploy\/server/);
  assert.match(page.body, /The server hangs after the update\./);
  assert.match(page.body, /Earlier/);
});

test("approving from the page runs the command and leads back to the request", async () => {
  const { requests, kubectl, gate, sebastian } = site();
  requests.add("req-1");

  const page = await sebastian.get("/r/req-1");
  assert.equal(page.status, 200);
  assert.match(page.body, /Changes the cluster: kubectl rollout\./);
  const answer = await sebastian.post("/r/req-1/approve", { ...form(page, "/r/req-1/approve"), read: "on" });
  await gate.idle();

  assert.equal(answer.status, 303);
  assert.equal(answer.headers.Location, "/r/req-1");
  assert.equal(kubectl.ran.length, 1);
  const after = await sebastian.get("/r/req-1");
  assert.match(after.body, /Done/);
  assert.match(after.body, /Approved by sebastian@example\.org/);
  assert.match(after.body, /deployment\.apps\/server restarted/);
  assert.ok(!after.body.includes("<form"), "a decided request offers no buttons");
});

test("denying from the page records it and runs nothing", async () => {
  const { requests, kubectl, gate, sebastian } = site();
  requests.add("req-1");

  const page = await sebastian.get("/r/req-1");
  const answer = await sebastian.post("/r/req-1/deny", form(page, "/r/req-1/deny"));
  await gate.idle();

  assert.equal(answer.status, 303);
  assert.equal(phaseOf((await requests.get("req-1"))!), "Denied");
  assert.equal(kubectl.ran.length, 0);
});

test("a tap that did not come from the page decides nothing", async () => {
  const { requests, kubectl, gate, sebastian } = site();
  requests.add("req-1");
  requests.add("req-2");
  const page = await sebastian.get("/r/req-1");
  const approve: Record<string, string> = { ...form(page, "/r/req-1/approve"), read: "on" };
  const deny = form(page, "/r/req-1/deny");
  const other = form(await sebastian.get("/r/req-2"), "/r/req-2/approve");

  const attempts = [
    sebastian.post("/r/req-1/approve", { read: "on" }),
    sebastian.post("/r/req-1/approve", { ...approve, token: "0".repeat(64) }),
    // The token of the other button, of another request, and of this page posted from another site.
    sebastian.post("/r/req-1/approve", { ...approve, token: deny.token! }),
    sebastian.post("/r/req-1/approve", { ...approve, token: other.token! }),
    sebastian.post("/r/req-1/approve", approve, { origin: "https://evil.example" }),
    sebastian.post("/r/req-1/approve", approve, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
    sebastian.post("/r/req-1/approve", approve, { origin: ORIGIN, "sec-fetch-site": "cross-site" }),
    sebastian.post("/r/req-1/approve", approve, { origin: "null", "sec-fetch-site": "cross-site" }),
    sebastian.post("/r/req-1/approve", approve, { "sec-fetch-site": "same-site" }),
    // Another site that hides where its form came from still has no token to send.
    sebastian.post("/r/req-1/approve", { read: "on", digest: approve.digest! }, { origin: "null" }),
  ];
  for (const attempt of attempts) assert.equal((await attempt).status, 403);
  await gate.idle();

  assert.equal(kubectl.ran.length, 0);
  assert.equal(phaseOf((await requests.get("req-1"))!), "Pending");
});

test("the page's own form is accepted however the browser describes where it came from", async () => {
  // What browsers really send with a form of this page. Chrome and Edge sent the second
  // one while the page asked for no referrer, and the owner's approval was refused.
  const ways: Record<string, string>[] = [
    { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    { origin: "null", "sec-fetch-site": "same-origin" },
    { origin: ORIGIN },
    { origin: "null" },
    {},
  ];
  for (const headers of ways) {
    const { requests, kubectl, gate, sebastian } = site();
    requests.add("req-1");
    const page = await sebastian.get("/r/req-1");
    const answer = await sebastian.post("/r/req-1/approve", { ...form(page, "/r/req-1/approve"), read: "on" }, headers);
    await gate.idle();
    assert.equal(answer.status, 303, JSON.stringify(headers));
    assert.equal(kubectl.ran.length, 1, JSON.stringify(headers));
  }
});

test("the page lets the browser say where its own forms come from", async () => {
  const { requests, sebastian } = site();
  requests.add("req-1");
  const page = await sebastian.get("/r/req-1");
  assert.equal(page.headers["Referrer-Policy"], "same-origin");
});

test("the box has to be ticked", async () => {
  const { requests, kubectl, gate, sebastian } = site();
  requests.add("req-1");

  const page = await sebastian.get("/r/req-1");
  const answer = await sebastian.post("/r/req-1/approve", form(page, "/r/req-1/approve"));
  await gate.idle();

  assert.equal(answer.status, 409);
  assert.match(answer.body, /Tick the box/);
  assert.equal(kubectl.ran.length, 0);
});

test("a request that cannot be approved only offers Deny, and says why", async () => {
  const { requests, clock, sebastian } = site();
  requests.add("refused", { command: ["kubectl", "get", "pods", "--as=system:admin"] });
  requests.add("old", {}, { createdAt: START - 31 * 60_000 });
  clock.now = START;

  for (const [name, why] of [
    ["refused", /only runs as itself/],
    ["old", /has expired/],
  ] as const) {
    const page = await sebastian.get(`/r/${name}`);
    assert.match(page.body, why);
    assert.ok(!page.body.includes(`action="/r/${name}/approve"`));
    assert.ok(page.body.includes(`action="/r/${name}/deny"`));
  }
});

test("what the agent wrote is shown as text, never as a page of its own", async () => {
  const { requests, sebastian } = site();
  // The character that makes what follows it read right to left.
  const reorder = String.fromCodePoint(0x202e);
  requests.add("req-1", {
    command: ["kubectl", "exec", "pod", "--", "sh", "-c", `echo "<script>alert(1)</script>" ${reorder}# reversed`],
    reason: `<img src=x onerror=alert(1)> & "quotes"`,
    session: "<b>bold</b>",
  });

  const page = await sebastian.get("/r/req-1");
  assert.ok(!page.body.includes("<script>alert"));
  assert.ok(!page.body.includes("<img src=x"));
  assert.ok(!page.body.includes("<b>bold</b>"));
  assert.ok(page.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!page.body.includes(reorder), "a character that reorders text is spelled out");
  assert.ok(page.body.includes("\\u{202e}"));
  assert.match(page.headers["Content-Security-Policy"]!, /default-src 'none'/);
});

test("a page for something that does not exist says so", async () => {
  const { sebastian } = site();
  for (const path of ["/r/nope", "/r/Not_A_Name", "/r/a/b/c", "/elsewhere", "/r/"]) {
    assert.equal((await sebastian.get(path)).status, 404, path);
  }
  assert.equal((await sebastian.post("/r/nope/approve", {})).status, 404);
});

test("a second tap after the first says it is already decided", async () => {
  const { requests, kubectl, gate, sebastian } = site();
  requests.add("req-1");
  const page = await sebastian.get("/r/req-1");
  const filled = { ...form(page, "/r/req-1/approve"), read: "on" };

  assert.equal((await sebastian.post("/r/req-1/approve", filled)).status, 303);
  const again = await sebastian.post("/r/req-1/approve", filled);
  await gate.idle();

  assert.equal(again.status, 409);
  assert.match(again.body, /already been decided/);
  assert.equal(kubectl.ran.length, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { Gate, Refused } from "../server/gate.ts";
import { phaseOf } from "../server/types.ts";
import { AGENT, SEBASTIAN, START, TTL_MS, setup } from "./fakes.ts";

test("an approved command runs once, exactly as asked, and its outcome is kept", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1", { timeoutSeconds: 90 });

  await gate.approve("req-1", SEBASTIAN, gate.digest(request.spec));
  await gate.idle();

  assert.deepEqual(kubectl.ran, [{ argv: ["kubectl", "-n", "games", "rollout", "restart", "deploy/server"], timeoutSeconds: 90 }]);
  const after = (await requests.get("req-1"))!;
  assert.equal(after.status?.phase, "Succeeded");
  assert.equal(after.status?.decidedBy, SEBASTIAN);
  assert.equal(after.status?.exitCode, 0);
  assert.equal(after.status?.output, "deployment.apps/server restarted\n");
  assert.ok(after.status?.startedAt && after.status.finishedAt);
});

test("a command that fails is recorded as failed, with what it printed", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");
  kubectl.result = { exitCode: 1, output: "Error from server (NotFound)\n", truncated: false, timedOut: false };

  await gate.approve("req-1", SEBASTIAN, gate.digest(request.spec));
  await gate.idle();

  const status = (await requests.get("req-1"))!.status!;
  assert.equal(status.phase, "Failed");
  assert.equal(status.exitCode, 1);
  assert.equal(status.output, "Error from server (NotFound)\n");
});

test("a command stopped for running too long says so", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");
  kubectl.result = { exitCode: 124, output: "", truncated: false, timedOut: true };

  await gate.approve("req-1", SEBASTIAN, gate.digest(request.spec));
  await gate.idle();

  const status = (await requests.get("req-1"))!.status!;
  assert.equal(status.phase, "Failed");
  assert.match(status.message!, /ran longer than the request allowed/);
});

test("only an approver decides", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");

  for (const user of [undefined, "someone@example.org", AGENT]) {
    await assert.rejects(gate.approve("req-1", user, gate.digest(request.spec)), Refused);
    await assert.rejects(gate.deny("req-1", user), Refused);
  }
  await gate.idle();
  assert.equal(kubectl.ran.length, 0);
  assert.equal(phaseOf((await requests.get("req-1"))!), "Pending");
});

test("a second approval does not run it again", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");
  const digest = gate.digest(request.spec);

  await gate.approve("req-1", SEBASTIAN, digest);
  await assert.rejects(gate.approve("req-1", SEBASTIAN, digest), /already been decided/);
  await gate.idle();
  await assert.rejects(gate.approve("req-1", SEBASTIAN, digest), /already been decided/);
  await gate.idle();

  assert.equal(kubectl.ran.length, 1);
});

test("two approvals at the same moment run it once", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");
  const digest = gate.digest(request.spec);

  const results = await Promise.allSettled([gate.approve("req-1", SEBASTIAN, digest), gate.approve("req-1", SEBASTIAN, digest)]);
  await gate.idle();

  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(kubectl.ran.length, 1);
});

test("the approval has to be for the request as it was shown", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");
  const other = gate.digest({ ...request.spec, command: ["kubectl", "delete", "ns", "games"] });

  await assert.rejects(gate.approve("req-1", SEBASTIAN, other), /not the one this page showed/);
  await assert.rejects(gate.approve("req-1", SEBASTIAN, ""), /not the one this page showed/);
  await gate.idle();
  assert.equal(kubectl.ran.length, 0);
});

test("the fingerprint covers everything that was asked", () => {
  const { requests, gate } = setup();
  const spec = requests.add("req-1", { session: "private-soft-umbrella", timeoutSeconds: 60 }).spec;
  const digest = gate.digest(spec);
  assert.notEqual(gate.digest({ ...spec, command: [...spec.command, "--force"] }), digest);
  assert.notEqual(gate.digest({ ...spec, reason: "Another reason entirely." }), digest);
  assert.notEqual(gate.digest({ ...spec, requester: "system:serviceaccount:x:y" }), digest);
  assert.notEqual(gate.digest({ ...spec, session: "another chat" }), digest);
  assert.notEqual(gate.digest({ ...spec, timeoutSeconds: 3600 }), digest);
  assert.equal(gate.digest({ ...spec }), digest);
});

test("a request nobody answered in time can no longer be approved, and is marked", async () => {
  const { requests, kubectl, clock, gate } = setup();
  const request = requests.add("req-1");
  requests.add("req-2", {}, { createdAt: START + TTL_MS });

  clock.now = START + TTL_MS;
  await assert.rejects(gate.approve("req-1", SEBASTIAN, gate.digest(request.spec)), /expired/);
  await gate.sweep();
  await gate.idle();

  assert.equal(kubectl.ran.length, 0);
  assert.equal(phaseOf((await requests.get("req-1"))!), "Expired");
  assert.equal(phaseOf((await requests.get("req-2"))!), "Pending");
});

test("a request from an account that is not on the list cannot be approved", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1", { requester: "system:serviceaccount:default:someone-else" });

  await assert.rejects(gate.approve("req-1", SEBASTIAN, gate.digest(request.spec)), /are not accepted/);
  await gate.idle();
  assert.equal(kubectl.ran.length, 0);
});

test("a command cerberus refuses cannot be approved", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1", { command: ["kubectl", "get", "pods", "--as=system:admin"] });

  assert.match(gate.obstacle(request)!, /only runs as itself/);
  await assert.rejects(gate.approve("req-1", SEBASTIAN, gate.digest(request.spec)), /only runs as itself/);
  await gate.idle();
  assert.equal(kubectl.ran.length, 0);
});

test("a denied request stays denied", async () => {
  const { requests, kubectl, gate } = setup();
  const request = requests.add("req-1");

  await gate.deny("req-1", SEBASTIAN);
  await assert.rejects(gate.approve("req-1", SEBASTIAN, gate.digest(request.spec)), /already been decided/);
  await assert.rejects(gate.deny("req-1", SEBASTIAN), /already been decided/);
  await gate.idle();

  const status = (await requests.get("req-1"))!.status!;
  assert.equal(status.phase, "Denied");
  assert.equal(status.decidedBy, SEBASTIAN);
  assert.equal(kubectl.ran.length, 0);
});

test("commands run one after another, in the order they were approved", async () => {
  const { requests } = setup();
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));

  const first = requests.add("req-1", { command: ["kubectl", "get", "one"] });
  const second = requests.add("req-2", { command: ["kubectl", "get", "two"] });
  const queued = new Gate(
    requests,
    async (argv) => {
      order.push(`start ${argv[2]}`);
      if (argv[2] === "one") await held;
      order.push(`end ${argv[2]}`);
      return { exitCode: 0, output: "", truncated: false, timedOut: false };
    },
    { approvers: [SEBASTIAN], requesters: [AGENT], ttlMs: TTL_MS, now: () => START, log: () => {} },
  );

  await queued.approve("req-1", SEBASTIAN, queued.digest(first.spec));
  await queued.approve("req-2", SEBASTIAN, queued.digest(second.spec));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start one"]);
  release();
  await queued.idle();

  assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
});

test("after a restart, nothing that was approved or running is run again", async () => {
  const { requests, kubectl, gate } = setup();
  requests.add("approved", {}, { status: { phase: "Approved", decidedBy: SEBASTIAN, decidedAt: "2026-11-15T12:00:00.000Z" } });
  requests.add("running", {}, { status: { phase: "Running", decidedBy: SEBASTIAN, startedAt: "2026-11-15T12:00:01.000Z" } });
  requests.add("waiting");
  requests.add("done", {}, { status: { phase: "Succeeded", exitCode: 0 } });

  await gate.recover();
  await gate.idle();

  assert.equal(kubectl.ran.length, 0);
  const approved = (await requests.get("approved"))!.status!;
  assert.equal(approved.phase, "Failed");
  assert.match(approved.message!, /It was not run/);
  assert.equal(approved.decidedBy, SEBASTIAN);
  const running = (await requests.get("running"))!.status!;
  assert.equal(running.phase, "Failed");
  assert.match(running.message!, /outcome is unknown/);
  assert.equal(phaseOf((await requests.get("waiting"))!), "Pending");
  assert.equal(phaseOf((await requests.get("done"))!), "Succeeded");
});

test("if the cluster stops answering around a run, the request says it could not be finished", async () => {
  const { requests, gate } = setup();
  const request = requests.add("req-1");
  const real = requests.setStatus.bind(requests);
  let writes = 0;
  requests.setStatus = async (target, status) => {
    writes++;
    // The write that would record the outcome fails once.
    if (writes === 3) throw new Error("connection refused");
    return real(target, status);
  };

  await gate.approve("req-1", SEBASTIAN, gate.digest(request.spec));
  await gate.idle();

  const status = (await requests.get("req-1"))!.status!;
  assert.equal(status.phase, "Failed");
  assert.match(status.message!, /could not finish this/);
});

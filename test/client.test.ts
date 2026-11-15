import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// client/kube-request is a shell script that needs jq, so these run where both exist:
// in the image build, not on a Windows machine.
const script = path.resolve(import.meta.dirname, "../client/kube-request");
const skip = process.platform === "win32" || spawnSync("jq", ["--version"]).status !== 0;

/** A folder with a kubectl that records what it is given and answers what the test chose. */
function sandbox(answer: unknown = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kube-request-"));
  writeFileSync(
    path.join(dir, "kubectl"),
    `#!/bin/sh
case "$*" in
  "auth whoami"*) printf 'system:serviceaccount:daedalus-access:daedalus' ;;
  create*) cat > "${dir}/filed.json"; printf 'req-abc12' ;;
  *) cat "${dir}/answer.json" ;;
esac
`,
  );
  chmodSync(path.join(dir, "kubectl"), 0o755);
  writeFileSync(path.join(dir, "answer.json"), JSON.stringify(answer));
  return {
    run: (...args: string[]) => spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }),
    filed: () => (existsSync(path.join(dir, "filed.json")) ? JSON.parse(readFileSync(path.join(dir, "filed.json"), "utf8")) : undefined),
  };
}

test("ask files the command exactly as it was given", { skip }, () => {
  // Flags of the command itself, its own "--", spaces, quotes and a line break: none of
  // it may be read as an option of the helper or of jq, and none of it may be changed.
  const command = ["kubectl", "-n", "ledger", "exec", "deploy/ledger", "--request-timeout=20s", "--", "sh", "-c", `echo "it's" $HOME;\nls -la`, "--yes", "-n", "x y", "--arg", "--"];
  const { run, filed } = sandbox();

  const result = run("ask", "--reason", "The ledger has to read the feed again.", "--", ...command);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/cerberus\.turtle-vector\.ts\.net\/r\/req-abc12/);
  assert.deepEqual(filed().spec, {
    command,
    reason: "The ledger has to read the feed again.",
    requester: "system:serviceaccount:daedalus-access:daedalus",
    timeoutSeconds: 300,
  });
  assert.equal(filed().metadata.namespace, "cerberus");
});

test("ask passes on the time limit and which chat is asking", { skip }, () => {
  const { run, filed } = sandbox();
  const result = run("ask", "--reason", "A long replay of the whole feed.", "--timeout", "1800", "--session", "ledger-quiet-harbor", "--", "kubectl", "get", "pods");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(filed().spec.timeoutSeconds, 1800);
  assert.equal(filed().spec.session, "ledger-quiet-harbor");
});

test("ask files nothing without a reason or for something that is not kubectl", { skip }, () => {
  for (const args of [
    ["ask", "--", "kubectl", "get", "pods"],
    ["ask", "--reason", "Trying to run a shell.", "--", "sh", "-c", "id"],
    ["ask", "--reason", "No command at all."],
  ]) {
    const { run, filed } = sandbox();
    assert.equal(run(...args).status, 2, args.join(" "));
    assert.equal(filed(), undefined);
  }
});

test("wait prints what the command printed and ends the way it ended", { skip }, () => {
  const request = (status: unknown) => ({ metadata: { name: "req-abc12" }, spec: { command: ["kubectl", "get", "pods"], reason: "r" }, status });

  const done = sandbox(request({ phase: "Succeeded", exitCode: 0, output: "pod/server-0 deleted\n", decidedBy: "sebastian@example.org" })).run("wait", "req-abc12");
  assert.equal(done.status, 0);
  assert.equal(done.stdout, "pod/server-0 deleted\n");

  const failed = sandbox(request({ phase: "Failed", exitCode: 3, output: "Error from server\n" })).run("wait", "req-abc12");
  assert.equal(failed.status, 3);
  assert.equal(failed.stdout, "Error from server\n");

  const denied = sandbox(request({ phase: "Denied", decidedBy: "sebastian@example.org" })).run("wait", "req-abc12");
  assert.equal(denied.status, 10);
  assert.match(denied.stderr, /Denied by sebastian@example\.org\. The command was not run\./);

  assert.equal(sandbox(request({ phase: "Expired" })).run("wait", "req-abc12").status, 11);

  const undecided = sandbox(request(undefined)).run("wait", "req-abc12", "--for", "0");
  assert.equal(undecided.status, 12);
  assert.match(undecided.stderr, /Still waiting for a decision/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTPUT_LIMIT, TIMED_OUT, kubectlRunner } from "../server/runner.ts";

// Node stands in for kubectl: the runner passes on everything after the first argument.
const run = kubectlRunner(process.execPath);
const script = (code: string) => ["kubectl", "-e", code];

test("it keeps what the command printed and how it ended", async () => {
  const result = await run(script(`process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = 3;`), 30);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /out\n/);
  assert.match(result.output, /err\n/);
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
});

test("arguments reach the command as they are, with no shell in between", async () => {
  const odd = ["$(touch /tmp/x)", "; rm -rf /", "a b", "'quoted'", "*"];
  const result = await run(["kubectl", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...odd], 30);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.output), odd);
});

test("the command does not inherit the secrets of the service around it", async () => {
  process.env.SOMETHING_PRIVATE = "do-not-pass-on";
  const result = await run(script(`console.log(Object.keys(process.env).sort().join(","))`), 30);
  delete process.env.SOMETHING_PRIVATE;
  assert.ok(!result.output.includes("SOMETHING_PRIVATE"));
  assert.match(result.output, /HOME/);
});

test("only the end of long output is kept", async () => {
  const result = await run(script(`for (let i = 0; i < 4000; i++) console.log(String(i).padStart(6, "0") + " " + "x".repeat(40)); console.log("the end");`), 30);
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= OUTPUT_LIMIT);
  assert.ok(result.output.endsWith("the end\n"));
});

test("a command that runs too long is stopped", async () => {
  const result = await run(script(`setTimeout(() => {}, 60000)`), 0.3);
  assert.equal(result.exitCode, TIMED_OUT);
  assert.equal(result.timedOut, true);
});

test("a kubectl that cannot be started is a failure, not a crash", async () => {
  const result = await kubectlRunner("/no/such/kubectl")(["kubectl", "get", "pods"], 30);
  assert.equal(result.exitCode, 127);
  assert.match(result.output, /could not start kubectl/);
});

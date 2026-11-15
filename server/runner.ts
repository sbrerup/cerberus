/** Runs one approved command and keeps what it printed. */
import { spawn } from "node:child_process";

export interface RunResult {
  exitCode: number;
  /** The end of stdout and stderr, in the order they arrived. */
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

export type Run = (argv: string[], timeoutSeconds: number) => Promise<RunResult>;

/** A request is one object in the cluster, so what is kept of the output has to stay small. */
export const OUTPUT_LIMIT = 48_000;

/** The exit code a shell gives a command that was stopped for running too long. */
export const TIMED_OUT = 124;

const KILL_AFTER_MS = 5_000;

/**
 * Runs kubectl with exactly the arguments given, never through a shell. kubectl finds the
 * cluster and its credentials by itself when it runs in a pod, so it acts as cerberus.
 */
export function kubectlRunner(binary = "kubectl"): Run {
  return (argv, timeoutSeconds) =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let held = 0;
      let truncated = false;
      let timedOut = false;

      const child = spawn(binary, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        // Only what kubectl needs. HOME is where it keeps its cache.
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.KUBECTL_HOME ?? "/tmp",
          KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST ?? "",
          KUBERNETES_SERVICE_PORT: process.env.KUBERNETES_SERVICE_PORT ?? "",
        },
      });

      const keep = (chunk: Buffer) => {
        chunks.push(chunk);
        held += chunk.length;
        while (held - chunks[0]!.length > OUTPUT_LIMIT) {
          held -= chunks.shift()!.length;
          truncated = true;
        }
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);

      const stop = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS).unref();
      }, timeoutSeconds * 1000);

      let finished = false;
      const finish = (exitCode: number, extra = "") => {
        if (finished) return;
        finished = true;
        clearTimeout(stop);
        let output = Buffer.concat(chunks).toString("utf8") + extra;
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(-OUTPUT_LIMIT);
          truncated = true;
        }
        resolve({ exitCode: timedOut ? TIMED_OUT : exitCode, output, truncated, timedOut });
      };
      child.on("error", (error) => finish(127, `cerberus could not start kubectl: ${error.message}\n`));
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
    });
}

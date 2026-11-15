/**
 * The decisions: who may approve, what may still be approved, and that an approved
 * command runs once.
 */
import { createHash } from "node:crypto";
import { Conflict, type Requests } from "./kube.ts";
import { refusal } from "./policy.ts";
import { TIMED_OUT, type Run } from "./runner.ts";
import { phaseOf, type CommandRequest, type RequestSpec } from "./types.ts";

export interface GateOptions {
  /** Tailscale logins that may approve or deny. */
  approvers: string[];
  /** Accounts whose requests may be approved at all. */
  requesters: string[];
  /** A request nobody answered in this long can no longer be approved. */
  ttlMs: number;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

/** Thrown for anything the person at the page should be told in plain words. */
export class Refused extends Error {}

const DEFAULT_TIMEOUT_SECONDS = 300;

export class Gate {
  private readonly requests: Requests;
  private readonly run: Run;
  private readonly options: GateOptions;
  private readonly now: () => number;
  private readonly log: (event: Record<string, unknown>) => void;
  /** Commands run one after another, in the order they were approved. */
  private queue: Promise<void> = Promise.resolve();

  constructor(requests: Requests, run: Run, options: GateOptions) {
    this.requests = requests;
    this.run = run;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  }

  mayDecide(user: string | undefined): user is string {
    return user !== undefined && this.options.approvers.includes(user);
  }

  /**
   * A fingerprint of exactly what was asked. The page sends back the one it showed, so
   * an approval can only ever apply to the command the person was looking at.
   */
  digest(spec: RequestSpec): string {
    const asked = [spec.command, spec.reason, spec.requester, spec.session ?? null, spec.timeoutSeconds ?? null];
    return createHash("sha256").update(JSON.stringify(asked)).digest("hex");
  }

  expiresAt(request: CommandRequest): number {
    return Date.parse(request.metadata.creationTimestamp) + this.options.ttlMs;
  }

  /** Why a waiting request cannot be approved, or undefined if it can. */
  obstacle(request: CommandRequest): string | undefined {
    if (phaseOf(request) !== "Pending") return "This request has already been decided.";
    if (this.now() >= this.expiresAt(request)) return "This request has expired. The agent has to ask again.";
    if (!this.options.requesters.includes(request.spec.requester)) return `Requests from ${request.spec.requester} are not accepted.`;
    return refusal(request.spec.command);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  async deny(name: string, user: string | undefined): Promise<void> {
    if (!this.mayDecide(user)) throw new Refused("You may not decide requests.");
    const request = await this.requests.get(name);
    if (!request) throw new Refused("There is no such request.");
    if (phaseOf(request) !== "Pending") throw new Refused("This request has already been decided.");
    await this.write(request, { phase: "Denied", decidedBy: user, decidedAt: this.stamp() });
    this.log({ event: "denied", request: name, by: user });
  }

  /** Records the approval, then runs the command in the background. */
  async approve(name: string, user: string | undefined, digest: string): Promise<void> {
    if (!this.mayDecide(user)) throw new Refused("You may not decide requests.");
    const request = await this.requests.get(name);
    if (!request) throw new Refused("There is no such request.");
    const obstacle = this.obstacle(request);
    if (obstacle) throw new Refused(obstacle);
    if (digest !== this.digest(request.spec)) throw new Refused("The request is not the one this page showed. Reload and read it again.");

    const approved = await this.write(request, { phase: "Approved", decidedBy: user, decidedAt: this.stamp() });
    this.log({ event: "approved", request: name, by: user, command: request.spec.command });
    this.queue = this.queue.then(() => this.execute(approved)).catch((error) => this.abandon(name, error));
  }

  /** Something went wrong around the command itself. Say so on the request, as far as that still works. */
  private async abandon(name: string, error: unknown): Promise<void> {
    this.log({ event: "error", request: name, error: String(error) });
    try {
      const latest = await this.requests.get(name);
      if (!latest || !["Approved", "Running"].includes(phaseOf(latest))) return;
      await this.requests.setStatus(latest, {
        ...latest.status,
        phase: "Failed",
        finishedAt: this.stamp(),
        message: `cerberus could not finish this: ${String(error)}. Check the cluster before asking again.`,
      });
    } catch (second) {
      this.log({ event: "error", request: name, error: String(second) });
    }
  }

  /** For tests and shutdown: resolves when nothing is running or waiting to run. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async write(request: CommandRequest, status: NonNullable<CommandRequest["status"]>): Promise<CommandRequest> {
    try {
      return await this.requests.setStatus(request, status);
    } catch (error) {
      if (error instanceof Conflict) throw new Refused("Someone else decided this request a moment ago.");
      throw error;
    }
  }

  private async execute(approved: CommandRequest): Promise<void> {
    const name = approved.metadata.name;
    const decided = { decidedBy: approved.status?.decidedBy, decidedAt: approved.status?.decidedAt };
    const startedAt = this.stamp();
    const running = await this.requests.setStatus(approved, { ...decided, phase: "Running", startedAt });
    this.log({ event: "started", request: name });

    const result = await this.run(approved.spec.command, approved.spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
    await this.requests.setStatus(running, {
      ...decided,
      phase: result.exitCode === 0 ? "Succeeded" : "Failed",
      startedAt,
      finishedAt: this.stamp(),
      exitCode: result.exitCode,
      output: result.output,
      outputTruncated: result.truncated,
      ...(result.exitCode === TIMED_OUT && result.timedOut ? { message: "Stopped: it ran longer than the request allowed." } : {}),
    });
    this.log({ event: "finished", request: name, exitCode: result.exitCode, timedOut: result.timedOut });
  }

  /** Marks waiting requests nobody answered in time. */
  async sweep(): Promise<void> {
    for (const request of await this.requests.list()) {
      if (phaseOf(request) !== "Pending" || this.now() < this.expiresAt(request)) continue;
      try {
        await this.requests.setStatus(request, { phase: "Expired", message: "Nobody answered in time." });
        this.log({ event: "expired", request: request.metadata.name });
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
  }

  /**
   * At startup. A command that was approved or running when cerberus stopped is never
   * run again on its own: nobody knows how far it got.
   */
  async recover(): Promise<void> {
    for (const request of await this.requests.list()) {
      const phase = phaseOf(request);
      if (phase !== "Approved" && phase !== "Running") continue;
      await this.requests.setStatus(request, {
        ...request.status,
        phase: "Failed",
        finishedAt: this.stamp(),
        message:
          phase === "Approved"
            ? "cerberus restarted before this ran. It was not run. Ask again."
            : "cerberus restarted while this ran, so the outcome is unknown. Check the cluster before asking again.",
      });
      this.log({ event: "interrupted", request: request.metadata.name, was: phase });
    }
  }
}

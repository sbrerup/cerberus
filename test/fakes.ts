/** Stand-ins for the cluster and for kubectl. */
import { Gate, type GateOptions } from "../server/gate.ts";
import { Conflict, type Requests } from "../server/kube.ts";
import type { Run, RunResult } from "../server/runner.ts";
import type { CommandRequest, RequestSpec, RequestStatus } from "../server/types.ts";

export const SEBASTIAN = "sebastian@example.org";
export const AGENT = "system:serviceaccount:daedalus-access:daedalus";
export const START = Date.parse("2026-11-15T12:00:00Z");
export const TTL_MS = 30 * 60_000;

const copy = <T>(value: T): T => structuredClone(value);

/** Keeps requests the way the API server does: every write gives a new resourceVersion. */
export class FakeRequests implements Requests {
  private readonly items = new Map<string, CommandRequest>();
  private version = 0;

  add(name: string, spec: Partial<RequestSpec> = {}, options: { createdAt?: number; status?: RequestStatus } = {}): CommandRequest {
    const request: CommandRequest = {
      apiVersion: "cerberus.labmox.internal/v1",
      kind: "CommandRequest",
      metadata: { name, namespace: "cerberus", resourceVersion: String(++this.version), creationTimestamp: new Date(options.createdAt ?? START).toISOString() },
      spec: { command: ["kubectl", "-n", "games", "rollout", "restart", "deploy/server"], reason: "The server hangs after the update.", requester: AGENT, ...spec },
      ...(options.status ? { status: options.status } : {}),
    };
    this.items.set(name, request);
    return copy(request);
  }

  async list(): Promise<CommandRequest[]> {
    return [...this.items.values()].map(copy);
  }

  async get(name: string): Promise<CommandRequest | undefined> {
    const found = this.items.get(name);
    return found ? copy(found) : undefined;
  }

  async setStatus(request: CommandRequest, status: RequestStatus): Promise<CommandRequest> {
    const current = this.items.get(request.metadata.name);
    if (!current || current.metadata.resourceVersion !== request.metadata.resourceVersion) throw new Conflict("changed");
    const next = { ...current, metadata: { ...current.metadata, resourceVersion: String(++this.version) }, status: copy(status) };
    this.items.set(request.metadata.name, next);
    return copy(next);
  }
}

/** Records what it was asked to run and answers with what the test chose. */
export class FakeKubectl {
  readonly ran: { argv: string[]; timeoutSeconds: number }[] = [];
  result: RunResult = { exitCode: 0, output: "deployment.apps/server restarted\n", truncated: false, timedOut: false };

  readonly run: Run = async (argv, timeoutSeconds) => {
    this.ran.push({ argv, timeoutSeconds });
    return this.result;
  };
}

export function setup(options: Partial<GateOptions> = {}) {
  const requests = new FakeRequests();
  const kubectl = new FakeKubectl();
  const clock = { now: START };
  const events: Record<string, unknown>[] = [];
  const gate = new Gate(requests, kubectl.run, {
    approvers: [SEBASTIAN],
    requesters: [AGENT],
    ttlMs: TTL_MS,
    now: () => clock.now,
    log: (event) => events.push(event),
    ...options,
  });
  return { requests, kubectl, clock, events, gate };
}

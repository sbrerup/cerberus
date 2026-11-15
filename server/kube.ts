/** Reads CommandRequests from the Kubernetes API and writes their status. */
import { readFileSync } from "node:fs";
import https from "node:https";
import { GROUP, PLURAL, VERSION, type CommandRequest, type RequestStatus } from "./types.ts";

export interface Requests {
  list(): Promise<CommandRequest[]>;
  get(name: string): Promise<CommandRequest | undefined>;
  /**
   * Replaces the status, but only if the request has not changed since it was read.
   * Rejects with Conflict otherwise, which is what keeps two taps from running a command twice.
   */
  setStatus(request: CommandRequest, status: RequestStatus): Promise<CommandRequest>;
}

export class Conflict extends Error {}

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

/** Talks to the API server directly, with the pod's service account. */
export class InClusterRequests implements Requests {
  private readonly base: URL;
  private readonly ca: Buffer;
  private readonly collection: string;

  constructor(namespace: string) {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("KUBERNETES_SERVICE_HOST is not set; this is not running in a cluster.");
    this.base = new URL(`https://${host.includes(":") ? `[${host}]` : host}:${port}`);
    this.ca = readFileSync(`${SERVICE_ACCOUNT}/ca.crt`);
    this.collection = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}`;
  }

  private call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        new URL(path, this.base),
        {
          method,
          ca: this.ca,
          timeout: 15_000,
          headers: {
            // Read on each call, because the kubelet rotates the projected token.
            Authorization: `Bearer ${readFileSync(`${SERVICE_ACCOUNT}/token`, "utf8").trim()}`,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("Kubernetes API request timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  async list(): Promise<CommandRequest[]> {
    const res = await this.call("GET", this.collection);
    if (res.status !== 200) throw new Error(`Listing requests failed with status ${res.status}`);
    return (JSON.parse(res.text) as { items: CommandRequest[] }).items;
  }

  async get(name: string): Promise<CommandRequest | undefined> {
    const res = await this.call("GET", `${this.collection}/${encodeURIComponent(name)}`);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw new Error(`Reading request ${name} failed with status ${res.status}`);
    return JSON.parse(res.text) as CommandRequest;
  }

  async setStatus(request: CommandRequest, status: RequestStatus): Promise<CommandRequest> {
    const { name, namespace, resourceVersion } = request.metadata;
    const res = await this.call("PUT", `${this.collection}/${encodeURIComponent(name)}/status`, {
      apiVersion: request.apiVersion,
      kind: request.kind,
      metadata: { name, namespace, resourceVersion },
      // The status endpoint ignores this, but the schema wants the object whole.
      spec: request.spec,
      status,
    });
    if (res.status === 409) throw new Conflict(`Request ${name} changed in the meantime.`);
    if (res.status !== 200) throw new Error(`Updating request ${name} failed with status ${res.status}: ${res.text.slice(0, 300)}`);
    return JSON.parse(res.text) as CommandRequest;
  }
}

/** The CommandRequest resource, as the cluster stores it (manifests/crd.yaml). */

export const GROUP = "cerberus.labmox.internal";
export const VERSION = "v1";
export const PLURAL = "commandrequests";

export interface RequestSpec {
  /** The exact arguments, starting with "kubectl". Never passed through a shell. */
  command: string[];
  reason: string;
  /** The account that filed the request. The cluster refuses a request that names another. */
  requester: string;
  /** Which chat asked, in the requester's own words. Shown, never trusted. */
  session?: string;
  timeoutSeconds?: number;
}

/** A request with no phase yet is waiting for a decision. */
export type Phase = "Pending" | "Approved" | "Denied" | "Expired" | "Running" | "Succeeded" | "Failed";

export interface RequestStatus {
  phase?: Exclude<Phase, "Pending">;
  decidedBy?: string;
  decidedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  /** The end of what the command printed, stdout and stderr together. */
  output?: string;
  outputTruncated?: boolean;
  message?: string;
}

export interface CommandRequest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    resourceVersion: string;
    creationTimestamp: string;
  };
  spec: RequestSpec;
  status?: RequestStatus;
}

export function phaseOf(request: CommandRequest): Phase {
  return request.status?.phase ?? "Pending";
}

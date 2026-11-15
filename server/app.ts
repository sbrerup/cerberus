/**
 * The web side: who is asking, which page they get, and that a tap on Approve really
 * came from this page.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Gate, Refused } from "./gate.ts";
import { STYLE, detailPage, listPage, notFoundPage, page, refusedPage } from "./html.ts";
import type { Requests } from "./kube.ts";
import type { CommandRequest } from "./types.ts";

export interface AppRequest {
  method: string;
  path: string;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body?: string;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AppOptions {
  /** The address people open, such as https://cerberus.example.ts.net. A decision posted from anywhere else is refused. */
  origin: string;
  /** Signs the forms. Made fresh at every start, so a page left open across a restart has to be reloaded. */
  formKey: Buffer;
  now?: () => number;
}

/**
 * The Tailscale proxy in front of this sets the header from the device that connected,
 * and overwrites whatever the browser sent. The network policy lets nothing else in.
 */
const LOGIN_HEADER = "tailscale-user-login";

const REQUEST_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  // Not "no-referrer": with that, a browser sends "Origin: null" with the page's own
  // forms, and they would look like they came from nowhere.
  "Referrer-Policy": "same-origin",
};

export class App {
  private readonly gate: Gate;
  private readonly requests: Requests;
  private readonly options: AppOptions;
  private readonly now: () => number;

  constructor(gate: Gate, requests: Requests, options: AppOptions) {
    this.gate = gate;
    this.requests = requests;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async handle(req: AppRequest): Promise<AppResponse> {
    if (req.path === "/healthz") return { status: 200, headers: { "Content-Type": "text/plain" }, body: "ok" };
    if (req.path === "/style.css" && req.method === "GET") {
      return { status: 200, headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "max-age=300" }, body: STYLE };
    }

    const user = req.headers[LOGIN_HEADER];
    if (!this.gate.mayDecide(user)) return html(403, refusedPage(user));

    if (req.method === "GET" && req.path === "/") return html(200, listPage(await this.requests.list(), this.now(), user));

    // Request names are plain lower-case letters, digits, dots and dashes, so nothing needs decoding.
    const match = /^\/r\/([^/]+)(\/approve|\/deny)?$/.exec(req.path);
    const name = match?.[1] ?? "";
    if (!match || !REQUEST_NAME.test(name)) return html(404, notFoundPage(user));
    const action = match[2]?.slice(1) as "approve" | "deny" | undefined;

    if (!action) {
      if (req.method !== "GET") return html(405, page("Not allowed", "<h1>That is not something this page does</h1>", { user }));
      const request = await this.requests.get(name);
      return request ? html(200, this.detail(request, user)) : html(404, notFoundPage(user));
    }

    if (req.method !== "POST") return html(405, page("Not allowed", "<h1>That is not something this page does</h1>", { user }));
    return this.decide(req, name, action, user);
  }

  private async decide(req: AppRequest, name: string, action: "approve" | "deny", user: string): Promise<AppResponse> {
    const request = await this.requests.get(name);
    if (!request) return html(404, notFoundPage(user));
    const form = new URLSearchParams(req.body ?? "");
    const digest = this.gate.digest(request.spec);

    // The token is what proves the tap came from this page: no other site can read it.
    // A browser also says where a form was posted from, and a tap that plainly came from
    // elsewhere is refused whatever it carries. Some browsers and privacy settings say
    // "null" or nothing instead, and that alone is no reason to refuse the owner.
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const fromElsewhere = (origin !== undefined && origin !== "null" && origin !== this.options.origin) || (site !== undefined && site !== "same-origin" && site !== "none");
    const fromThisPage = !fromElsewhere && same(form.get("token") ?? "", this.token(user, action, name, digest));
    if (!fromThisPage) return html(403, this.detail(request, user, "That did not come from this page. Read the request again and decide here."));

    try {
      if (action === "deny") await this.gate.deny(name, user);
      else {
        if (form.get("read") !== "on") throw new Refused("Tick the box to say you have read the command.");
        await this.gate.approve(name, user, form.get("digest") ?? "");
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      const latest = (await this.requests.get(name)) ?? request;
      return html(409, this.detail(latest, user, error.message));
    }
    return { status: 303, headers: { Location: `/r/${encodeURIComponent(name)}`, "Cache-Control": "no-store" }, body: "" };
  }

  private detail(request: CommandRequest, user: string, error?: string): string {
    const name = request.metadata.name;
    const digest = this.gate.digest(request.spec);
    return detailPage({
      request,
      now: this.now(),
      user,
      expiresAt: this.gate.expiresAt(request),
      obstacle: this.gate.obstacle(request),
      digest,
      approveToken: this.token(user, "approve", name, digest),
      denyToken: this.token(user, "deny", name, digest),
      error,
    });
  }

  /** Ties a form to one person, one request as it was shown, and one of the two buttons. */
  private token(user: string, action: string, name: string, digest: string): string {
    return createHmac("sha256", this.options.formKey).update([user, action, name, digest].join("\n")).digest("hex");
  }
}

function html(status: number, body: string): AppResponse {
  return { status, headers: { ...HTML_HEADERS }, body };
}

function same(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The pages. Plain HTML, no scripts: there is nothing here for a browser to run. */
import { notes, quote } from "./policy.ts";
import { phaseOf, type CommandRequest, type Phase } from "./types.ts";

export function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/**
 * Control characters, zero-width characters and the ones that reorder text, as ranges of
 * code points. Written as numbers so that this file holds none of them itself. Tabs and
 * line breaks are left out: they are ordinary in what a command prints.
 */
const HIDDEN_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
] as const;
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join("")}]`, "gu");

/**
 * Makes characters that hide or reorder text show up as what they are, so a command
 * cannot look like a different one.
 */
export function visible(text: string): string {
  return text.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

const show = (text: string) => escape(visible(text));

export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d`;
}

function clock(iso: string | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

const PHASE_WORDS: Record<Phase, string> = {
  Pending: "Waiting for you",
  Approved: "Approved, about to run",
  Denied: "Denied",
  Expired: "Expired",
  Running: "Running",
  Succeeded: "Done",
  Failed: "Failed",
};

function badge(phase: Phase): string {
  return `<span class="badge ${phase.toLowerCase()}">${PHASE_WORDS[phase]}</span>`;
}

/** The account's own name, without the "system:serviceaccount:namespace:" in front. */
function shortRequester(requester: string): string {
  return requester.split(":").at(-1) ?? requester;
}

export function page(title: string, body: string, options: { refreshSeconds?: number; user?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ""}
<title>${show(title)} · cerberus</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><a href="/">cerberus</a>${options.user ? `<span>${escape(options.user)}</span>` : ""}</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function refusedPage(seen: string | undefined): string {
  const who = seen ? `You are signed in to Tailscale as ${escape(seen)}, and that login may not decide requests.` : "This request carried no Tailscale login. The page only answers people, not tagged machines.";
  return page("Not for you", `<h1>This page is not for you</h1><p>${who}</p>`);
}

export function notFoundPage(user: string): string {
  return page("Not found", `<h1>There is no such request</h1><p><a href="/">Back to the list</a></p>`, { user });
}

export function listPage(requests: CommandRequest[], now: number, user: string): string {
  const newestFirst = [...requests].sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp));
  const waiting = newestFirst.filter((r) => phaseOf(r) === "Pending");
  const earlier = newestFirst.filter((r) => phaseOf(r) !== "Pending").slice(0, 40);

  const card = (r: CommandRequest) => `<a class="card" href="/r/${encodeURIComponent(r.metadata.name)}">
<div class="row">${badge(phaseOf(r))}<span class="muted">${ago(now - Date.parse(r.metadata.creationTimestamp))} ago · ${escape(shortRequester(r.spec.requester))}</span></div>
<pre class="command">${show(quote(r.spec.command))}</pre>
<p>${show(r.spec.reason)}</p>
</a>`;

  const body = `<h1>${waiting.length === 0 ? "Nothing is waiting for you" : waiting.length === 1 ? "1 request is waiting for you" : `${waiting.length} requests are waiting for you`}</h1>
${waiting.map(card).join("\n")}
${earlier.length ? `<h2>Earlier</h2>\n${earlier.map(card).join("\n")}` : ""}`;
  return page("Requests", body, { refreshSeconds: 10, user });
}

export interface DetailView {
  request: CommandRequest;
  now: number;
  user: string;
  expiresAt: number;
  /** Why it cannot be approved, if it is still waiting. */
  obstacle?: string;
  digest: string;
  approveToken: string;
  denyToken: string;
  /** Something that just went wrong with the person's own tap. */
  error?: string;
}

export function detailPage(view: DetailView): string {
  const { request, now } = view;
  const { spec, status } = request;
  const phase = phaseOf(request);
  const name = encodeURIComponent(request.metadata.name);

  const decision =
    phase !== "Pending"
      ? ""
      : `<section class="decide">
${
  view.obstacle
    ? `<p class="error">${escape(view.obstacle)}</p>`
    : `<form method="post" action="/r/${name}/approve">
<input type="hidden" name="token" value="${view.approveToken}">
<input type="hidden" name="digest" value="${view.digest}">
<label class="check"><input type="checkbox" name="read" required> I have read the command above</label>
<button class="approve" type="submit">Approve and run it once</button>
</form>`
}
<form method="post" action="/r/${name}/deny">
<input type="hidden" name="token" value="${view.denyToken}">
<button class="deny" type="submit">Deny</button>
</form>
<p class="muted">Expires in ${ago(view.expiresAt - now)} if you do nothing.</p>
</section>`;

  const outcome =
    phase === "Pending"
      ? ""
      : `<section>
<h2>What happened</h2>
<ul class="facts">
${status?.decidedBy ? `<li>${phase === "Denied" ? "Denied" : "Approved"} by ${escape(status.decidedBy)}, ${escape(clock(status.decidedAt))}</li>` : ""}
${status?.startedAt ? `<li>Started ${escape(clock(status.startedAt))}${status.finishedAt ? `, took ${ago(Date.parse(status.finishedAt) - Date.parse(status.startedAt))}` : `, running for ${ago(now - Date.parse(status.startedAt))}`}</li>` : ""}
${status?.exitCode !== undefined ? `<li>Exit code ${status.exitCode}</li>` : ""}
${status?.message ? `<li>${show(status.message)}</li>` : ""}
</ul>
${
  status?.output !== undefined
    ? `<h2>What it printed</h2>
${status.outputTruncated ? `<p class="muted">Only the end is kept.</p>` : ""}
<pre class="output">${status.output ? show(status.output) : "(nothing)"}</pre>`
    : ""
}
</section>`;

  const body = `<div class="row">${badge(phase)}<span class="muted">${escape(request.metadata.name)}</span></div>
${view.error ? `<p class="error">${escape(view.error)}</p>` : ""}
<section>
<h2>Why</h2>
<p>${show(spec.reason)}</p>
</section>
<section>
<h2>The command</h2>
<pre class="command">${show(quote(spec.command))}</pre>
<details><summary>The ${spec.command.length} arguments, one by one</summary>
<ol>${spec.command.map((arg) => `<li><code>${escape(JSON.stringify(visible(arg)))}</code></li>`).join("")}</ol>
</details>
<ul class="notes">${notes(spec.command)
    .map((note) => `<li>${show(note)}</li>`)
    .join("")}</ul>
<p class="muted">It may run for up to ${ago((spec.timeoutSeconds ?? 300) * 1000)}.</p>
</section>
<section>
<h2>Who asked</h2>
<ul class="facts">
<li>${show(spec.requester)}</li>
${spec.session ? `<li>It says it is: ${show(spec.session)}</li>` : ""}
<li>Filed ${escape(clock(request.metadata.creationTimestamp))}, ${ago(now - Date.parse(request.metadata.creationTimestamp))} ago</li>
</ul>
</section>
${decision}
${outcome}`;

  const live = phase === "Approved" || phase === "Running";
  return page(quote(spec.command).slice(0, 60), body, { refreshSeconds: live ? 2 : undefined, user: view.user });
}

export const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafafa; --card: #fff; --line: #d8d8d8; --muted: #666; --go: #1a7f37; --stop: #b42318; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --bg: #121212; --card: #1c1c1c; --line: #383838; --muted: #9a9a9a; --go: #3fb950; --stop: #f85149; --warn: #d29922; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; justify-content: space-between; gap: 1rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
header a { font-weight: 700; color: inherit; text-decoration: none; }
header span, .muted { color: var(--muted); font-size: .875rem; }
main { max-width: 46rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.375rem; margin: .5rem 0 1rem; }
h2 { font-size: 1rem; margin: 1.5rem 0 .25rem; }
p { margin: .25rem 0; overflow-wrap: anywhere; }
pre { margin: .5rem 0; padding: .75rem; background: var(--card); border: 1px solid var(--line); border-radius: .5rem; white-space: pre-wrap; overflow-wrap: anywhere; font: .875rem/1.45 ui-monospace, monospace; }
pre.output { max-height: 70vh; overflow: auto; }
code { font: .875rem ui-monospace, monospace; overflow-wrap: anywhere; }
ul, ol { margin: .25rem 0; padding-left: 1.25rem; }
.notes li { color: var(--warn); }
.row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.card { display: block; margin: .75rem 0; padding: .75rem; background: var(--card); border: 1px solid var(--line); border-radius: .75rem; color: inherit; text-decoration: none; }
.badge { padding: .125rem .625rem; border-radius: 1rem; font-size: .8125rem; font-weight: 600; border: 1px solid currentColor; }
.badge.pending, .badge.approved, .badge.running { color: var(--warn); }
.badge.succeeded { color: var(--go); }
.badge.failed, .badge.denied { color: var(--stop); }
.badge.expired { color: var(--muted); }
.error { color: var(--stop); font-weight: 600; }
.decide { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--line); }
.decide form { margin: .75rem 0; }
.check { display: flex; align-items: center; gap: .625rem; min-height: 2.75rem; }
.check input { width: 1.375rem; height: 1.375rem; }
button { width: 100%; min-height: 3rem; border-radius: .625rem; font: inherit; font-weight: 600; cursor: pointer; }
button.approve { color: #fff; background: var(--go); border: 1px solid var(--go); }
button.deny { color: var(--stop); background: transparent; border: 1px solid var(--stop); }
@media (prefers-color-scheme: dark) { button.approve { color: #0b1f10; } }
`;

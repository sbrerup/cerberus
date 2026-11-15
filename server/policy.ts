/**
 * What a request may ask for, and what about it deserves a second look.
 *
 * The person approving reads the exact command, and that reading is the real check.
 * These rules only keep commands to things cerberus can run faithfully: as itself,
 * against this cluster, without a terminal, and with an end.
 */

/** Flags that would make kubectl act as someone else or against another cluster. */
const IDENTITY_FLAGS = [
  "--kubeconfig",
  "--context",
  "--cluster",
  "--user",
  "--server",
  "-s",
  "--token",
  "--as",
  "--as-group",
  "--as-uid",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--insecure-skip-tls-verify",
  "--tls-server-name",
  "--username",
  "--password",
];

/** There are no files in the pod and nothing on stdin. */
const FILE_FLAGS = ["-f", "--filename", "-k", "--kustomize"];

/** These never finish by themselves. */
const ENDLESS_FLAGS = ["-w", "--watch", "--watch-only", "--follow"];

const REFUSED_COMMANDS: Record<string, string> = {
  "port-forward": "it never finishes",
  proxy: "it never finishes",
  attach: "it needs a terminal",
  edit: "it needs an editor",
  debug: "it needs a terminal",
  cp: "there are no files to copy from or to",
  config: "cerberus only runs as itself, against this cluster",
  plugin: "plugins are not installed",
  kustomize: "there are no files to read",
  completion: "it does nothing to the cluster",
};

/** Flags whose value is the next argument, so that value is not mistaken for the command. */
const FLAGS_WITH_VALUE = new Set([
  "-n",
  "--namespace",
  "-o",
  "--output",
  "-l",
  "--selector",
  "-c",
  "--container",
  "-p",
  "--patch",
  "--field-selector",
  "--request-timeout",
  "--since",
  "--since-time",
  "--tail",
  "--replicas",
  "--type",
  "--timeout",
  "--grace-period",
  "--cascade",
  "--sort-by",
  "--for",
  "--image",
  "--revision",
  "--to-revision",
  "--subresource",
  "--field-manager",
  "--overrides",
  "--limit-bytes",
]);

const CHANGING_COMMANDS = new Set([
  "annotate",
  "apply",
  "autoscale",
  "certificate",
  "cordon",
  "create",
  "delete",
  "drain",
  "exec",
  "expose",
  "label",
  "patch",
  "replace",
  "rollout",
  "run",
  "scale",
  "set",
  "taint",
  "uncordon",
]);

/** kubectl's own arguments, and what follows "--" (the command to run inside a pod). */
function split(argv: string[]): { own: string[]; inner: string[] | undefined } {
  const at = argv.indexOf("--");
  return at < 0 ? { own: argv.slice(1), inner: undefined } : { own: argv.slice(1, at), inner: argv.slice(at + 1) };
}

function flagName(arg: string): string {
  const equals = arg.indexOf("=");
  return equals < 0 ? arg : arg.slice(0, equals);
}

/** The words that are not flags or their values: the command, then what it acts on. */
function words(own: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg.startsWith("-")) {
      if (FLAGS_WITH_VALUE.has(arg)) i++;
      continue;
    }
    found.push(arg);
  }
  return found;
}

function valueOf(own: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    for (const name of names) {
      if (arg === name) return own[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Why cerberus will not run this, or undefined if it will. */
export function refusal(argv: string[]): string | undefined {
  if (argv[0] !== "kubectl") return "The command must start with kubectl.";
  const { own } = split(argv);
  if (own.length === 0) return "The command is only kubectl, with nothing to do.";

  for (const arg of own) {
    if (!arg.startsWith("-")) continue;
    const name = flagName(arg);
    if (IDENTITY_FLAGS.includes(name)) return `${name} is not allowed: cerberus only runs as itself, against this cluster.`;
    if (FILE_FLAGS.includes(name)) return `${name} is not allowed: there are no files and no input to read from.`;
    if (ENDLESS_FLAGS.includes(name)) return `${name} is not allowed: the command would never finish.`;
    if (name === "--stdin" || name === "--tty") return `${name} is not allowed: there is no terminal.`;
    // Short flags bundled together, as in -it.
    if (/^-[a-zA-Z]{1,3}$/.test(arg) && /[it]/.test(arg.slice(1)) && !FLAGS_WITH_VALUE.has(arg)) {
      return `${arg} is not allowed: there is no terminal.`;
    }
  }

  const command = words(own)[0];
  if (!command) return "The command names nothing for kubectl to do.";
  const why = REFUSED_COMMANDS[command];
  if (why) return `kubectl ${command} is not allowed: ${why}.`;
  return undefined;
}

/** What the person approving should notice before they tap. Plain sentences. */
export function notes(argv: string[]): string[] {
  const { own, inner } = split(argv);
  const found: string[] = [];
  const all = words(own);
  const command = all[0] ?? "";

  if (own.includes("-A") || own.includes("--all-namespaces")) found.push("Acts on every namespace.");
  else found.push(`Namespace: ${valueOf(own, "-n", "--namespace") ?? "default (none was given)"}.`);

  const onlyLooks = command === "rollout" && ["status", "history"].includes(all[1] ?? "");
  if (CHANGING_COMMANDS.has(command) && !onlyLooks) found.push(`Changes the cluster: kubectl ${command}.`);
  else found.push(`kubectl ${[command, onlyLooks ? all[1] : ""].join(" ").trim()} normally only reads.`);

  if (command === "exec" && inner) found.push(`Runs inside a pod: ${quote(inner)}`);
  if (command === "delete" && own.includes("--all")) found.push("Deletes everything of that kind, not one named thing.");
  if (own.some((arg) => flagName(arg) === "--force" || arg === "--grace-period=0")) found.push("Forces it, without waiting for a clean shutdown.");
  if (all.slice(1).some((word) => word.split(",").some((kind) => /^secrets?($|[/.])/i.test(kind)))) {
    found.push("Touches Secrets. Whatever it prints goes back to the agent that asked.");
  }
  return found;
}

/** The command as one line a shell would read the same way. For showing only. */
export function quote(argv: string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(" ");
}

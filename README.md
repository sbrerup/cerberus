# cerberus

A page where one person approves single `kubectl` commands that an agent asks for.

The agent that works on this cluster (Claude Code on the VM `daedalus`) has an account
that can only read. When it needs to change something, it cannot do it itself. It files
a request with the exact command and the reason. A person opens this page, reads the
command and approves or denies it. cerberus then runs an approved command once, with
its own rights, and gives the output back. The agent never holds those rights.

It is reachable only on the tailnet and only by the people named as approvers.

## How a request goes

1. The agent files a `CommandRequest` in the cluster: the command as a list of
   arguments, a reason, and which chat is asking. Filing and reading requests is all its
   account may do here.
2. It gives the person a link to `https://cerberus.<tailnet>/r/<name>` and waits.
3. The page shows the command, the reason, who asked, and what about the command is
   worth noticing (its namespace, whether it changes anything, whether it touches
   Secrets). The person ticks "I have read the command" and approves, or denies.
4. cerberus runs the command, records who approved it, the exit code and the end of
   what it printed, all on the request itself.
5. A request nobody answers within 30 minutes expires and can no longer be approved.

Every request stays in the cluster with its outcome: `kubectl -n cerberus get cmdreq`.

## What keeps it honest

The page runs whatever was approved as cluster admin, so everything else exists to make
sure an approval is a person's decision about exactly the command they read.

- **The agent cannot reach the page.** The ingress carries `tag:k8s-admin`, which the
  tailnet policy opens to the owner's own devices only. Agents are tagged machines.
- **The agent cannot approve or alter a request.** Its role allows `create`, `get`,
  `list` and `watch` on requests. Only cerberus may write a status, and the cluster
  refuses any change to what a request asks for after it is filed.
- **A request cannot be filed in another account's name.** An admission policy requires
  `spec.requester` to be the account that files it, and cerberus only accepts requests
  from the accounts in `REQUESTERS`.
- **cerberus knows who is at the page from Tailscale.** The Tailscale proxy sets the
  `Tailscale-User-Login` header from the device that connected and overwrites anything
  the browser sent. The network policy lets nothing but that proxy reach cerberus.
  Tagged machines have no login, so they get a refusal.
- **An approval only counts if it came from the page.** The buttons carry a token tied
  to the person, the request as it was shown and the button, and a decision posted from
  any other address is refused. Another website open in the same browser cannot approve.
- **One approval, one run.** Two taps, two tabs or a retry cannot run a command twice,
  and commands run one after another. If cerberus restarts while something was approved
  or running, it marks that request failed and never runs it again on its own.
- **The command is run as written.** It is a list of arguments passed straight to
  `kubectl`, never through a shell. The page also shows the arguments one by one, and
  spells out characters that hide or reorder text.
- **cerberus can reach nothing but DNS and the Kubernetes API.**

What it does not protect against: approving a command without reading it. A command can
also print things the agent should not see, such as a Secret; the page says so when a
command touches Secrets.

## What can be asked

A command has to start with `kubectl` and has to be something cerberus can run as
itself, against this cluster, without a terminal, and with an end. So these are refused,
and the page then only offers Deny:

- flags that change who or where: `--as`, `--token`, `--kubeconfig`, `--context`,
  `--server` and the like
- `-f`, `-k`: there are no files in the pod and nothing on its input. Manifests go
  through Git and Argo CD.
- `-i`, `-t`, `attach`, `edit`, `debug`: there is no terminal
- `-w`, `--follow`, `port-forward`, `proxy`: they never finish
- `cp`, `config`, `plugin`, `kustomize`, `completion`

Whatever follows `--` belongs to the command inside the pod and is not judged.

A command may run for 5 minutes unless the request asks for more (up to an hour), and
only the last 48,000 characters of its output are kept.

## Filing a request

`client/kube-request` is a small shell script for the agent's machine. It needs
`kubectl` and `jq`.

```sh
kube-request ask --reason "The ledger has to read the feed again after the mapping fix." \
  -- kubectl -n dripcraft-ledger exec deploy/dripcraft-ledger -- dotnet Ledger.Api.dll replay-ingest --yes
kube-request wait req-abc12
```

`ask` prints the request's name and the link for the person. `wait` prints what the
command printed and exits with its exit code, or with 10 if it was denied, 11 if it
expired and 12 if the wait ended first.

## Running it

`manifests/` holds everything: the `CommandRequest` definition, the admission policy,
the roles, the deployment, the tailnet-only ingress and the network policies. Argo CD
deploys it from this repository's `main` (`deploy/dripcloud-app.yaml` is the application
to copy into sbrerup/dripcloud). Merging to `main` builds the image, and the manifests
name the image that runs.

The settings are environment variables in `manifests/deployment.yaml`:

| Variable | Meaning |
|---|---|
| `APPROVERS` | Tailscale logins that may approve or deny, separated by commas |
| `REQUESTERS` | Accounts whose requests can be approved, separated by commas |
| `PUBLIC_URL` | The address people open. Decisions posted from anywhere else are refused |
| `REQUEST_TTL_MINUTES` | How long a request can wait for an answer |

To let another account file requests, add it to `REQUESTERS` and bind it to the
`cerberus-requester` role in `manifests/rbac.yaml`.

The image has to be readable by the cluster. After the first build, set the package
`cerberus` to public on GitHub, as with the other images here.

## Working on it

The server is TypeScript that Node 24 runs as it is: no build step, and nothing at run
time but Node itself.

```sh
npm ci
npm test            # node --test
npm run typecheck
docker build .      # runs both, as the image workflow does
```

- `server/policy.ts` decides what may be asked and what the page points out.
- `server/gate.ts` holds the decisions: who may approve, what may still be approved,
  and that a command runs once.
- `server/app.ts` and `server/html.ts` are the page.
- `server/runner.ts` runs `kubectl`, and `server/kube.ts` reads and writes requests.

Keep the pages free of scripts and of anything loaded from elsewhere: the content
security policy forbids both, and there is nothing here that needs them.

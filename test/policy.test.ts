import assert from "node:assert/strict";
import { test } from "node:test";
import { notes, quote, refusal } from "../server/policy.ts";

const k = (line: string) => line.split(" ");

test("ordinary commands are accepted", () => {
  for (const line of [
    "kubectl -n games rollout restart deploy/server",
    "kubectl -n ledger exec deploy/ledger -- dotnet Ledger.Api.dll replay-ingest --yes",
    "kubectl delete pod server-0 --namespace=games",
    "kubectl get pods -A -o wide",
    "kubectl -n games scale statefulset/server --replicas 0",
    "kubectl -n games logs server-0 --tail 200",
    "kubectl -n games exec server-0 -c game -- rcon-cli -it say hello",
  ]) {
    assert.equal(refusal(k(line)), undefined, line);
  }
});

test("a command has to be kubectl and has to do something", () => {
  assert.match(refusal(["sh", "-c", "kubectl get pods"])!, /must start with kubectl/);
  assert.match(refusal(["kubectl"])!, /nothing to do/);
  assert.match(refusal(k("kubectl -n games"))!, /names nothing/);
});

test("it cannot act as someone else or against another cluster", () => {
  for (const flag of ["--as=system:admin", "--as-group=system:masters", "--token=abc", "--kubeconfig=/tmp/x", "--context=prod", "--server=https://elsewhere", "--insecure-skip-tls-verify"]) {
    assert.match(refusal(["kubectl", "get", "pods", flag])!, /only runs as itself/, flag);
  }
  assert.match(refusal(k("kubectl -s https://elsewhere get pods"))!, /only runs as itself/);
  assert.match(refusal(k("kubectl --as system:admin get pods"))!, /only runs as itself/);
});

test("it cannot read files or input, hold a terminal, or run without end", () => {
  assert.match(refusal(k("kubectl apply -f https://example.org/x.yaml"))!, /no files/);
  assert.match(refusal(k("kubectl apply --filename=x.yaml"))!, /no files/);
  assert.match(refusal(k("kubectl apply -k ./overlay"))!, /no files/);
  assert.match(refusal(k("kubectl -n games exec -it server-0 -- sh"))!, /no terminal/);
  assert.match(refusal(k("kubectl -n games exec -i server-0 -- sh"))!, /no terminal/);
  assert.match(refusal(k("kubectl -n games exec --stdin --tty server-0 -- sh"))!, /no terminal/);
  assert.match(refusal(k("kubectl get pods -w"))!, /never finish/);
  assert.match(refusal(k("kubectl -n games logs server-0 --follow"))!, /never finish/);
  assert.match(refusal(k("kubectl -n games port-forward svc/server 8080"))!, /never finishes/);
  assert.match(refusal(k("kubectl -n games edit deploy/server"))!, /editor/);
  assert.match(refusal(k("kubectl config view"))!, /only runs as itself/);
});

test("what follows -- belongs to the pod and is not judged as kubectl's", () => {
  assert.equal(refusal(k("kubectl -n games exec server-0 -- tail -f --as=root /var/log/x")), undefined);
});

test("the notes name the namespace and whether it changes anything", () => {
  assert.deepEqual(notes(k("kubectl -n games rollout restart deploy/server")), ["Namespace: games.", "Changes the cluster: kubectl rollout."]);
  assert.deepEqual(notes(k("kubectl --namespace=games rollout status deploy/server")), ["Namespace: games.", "kubectl rollout status normally only reads."]);
  assert.deepEqual(notes(k("kubectl get pods")), ["Namespace: default (none was given).", "kubectl get normally only reads."]);
  assert.deepEqual(notes(k("kubectl get pods -A")), ["Acts on every namespace.", "kubectl get normally only reads."]);
});

test("the notes point at what is easy to miss", () => {
  assert.ok(notes(k("kubectl -n ledger exec deploy/ledger -- dotnet Ledger.Api.dll replay-ingest --yes")).includes("Runs inside a pod: dotnet Ledger.Api.dll replay-ingest --yes"));
  assert.ok(notes(k("kubectl -n games delete pods --all")).includes("Deletes everything of that kind, not one named thing."));
  assert.ok(notes(k("kubectl -n games delete pod server-0 --force --grace-period=0")).includes("Forces it, without waiting for a clean shutdown."));
  for (const line of ["kubectl -n games get secret token -o yaml", "kubectl -n games get secrets", "kubectl -n games get configmaps,secrets", "kubectl -n games describe secret/token"]) {
    assert.ok(notes(k(line)).some((note) => note.startsWith("Touches Secrets.")), line);
  }
  assert.ok(!notes(k("kubectl -n games get pods")).some((note) => note.startsWith("Touches Secrets.")));
});

test("the one-line form quotes what a shell would split or change", () => {
  assert.equal(quote(["kubectl", "exec", "pod", "--", "sh", "-c", "echo it's $HOME; ls"]), `kubectl exec pod -- sh -c 'echo it'\\''s $HOME; ls'`);
  assert.equal(quote(["kubectl", "get", "pods", "-l", "app=web"]), "kubectl get pods -l app=web");
  assert.equal(quote(["kubectl", "annotate", "pod", "x", ""]), "kubectl annotate pod x ''");
});

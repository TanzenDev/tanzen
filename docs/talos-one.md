# Talos Cluster — tanzen0 workers + Mac CP

Two deployment modes are supported via `tanzenctl`:

| Command | Cluster | Kata |
|---------|---------|------|
| `tanzenctl up` | Kind on Mac | no |
| `tanzenctl up --kata` | Kind on Mac | attempted (warns if unavailable) |
| `tanzenctl up --profile talos` | Talos CP on Docker (Mac) | no |
| `tanzenctl up --profile talos --remote-workers tanzen0` | Talos CP on Mac + KVM workers on tanzen0 | no |
| `tanzenctl up --profile talos --remote-workers tanzen0 --kata` | same + Kata on tanzen0 workers | yes |

`tanzenctl provision` runs the infrastructure step independently (useful for reprovisioning workers without reinstalling the app stack).

---

## Standalone tanzen-new cluster on tanzen0

A standalone 3-node Talos cluster (Cilium, Kata, Spin) also exists directly on tanzen0's KVM,
independent of the tanzenctl tooling. Its Terraform lives in `~/dev/tanzen-new/` on tanzen0.

---

## Cluster at a glance

| Node | Role | IP | vCPU | RAM |
|------|------|----|------|-----|
| talos-b3b-2qc | control-plane | 10.17.5.80, VIP 10.17.5.9 | 4 | 8 GB |
| talos-oci-yod | worker | 10.17.5.157 (DHCP) | 4 | 16 GB |
| talos-qk2-vto | worker | 10.17.5.22 (DHCP) | 4 | 16 GB |

- **Talos:** v1.9.1 · **Kubernetes:** v1.31.4 · **CNI:** Flannel
- **Extensions:** kata-containers, spin, qemu-guest-agent
- **API endpoint:** `https://10.17.5.9:6443`
- **Network:** libvirt NAT `tz-talos`, 10.17.5.0/24
- **kubeconfig:** `~/.kube/tanzen-dev.yaml` on tanzen0

```bash
# from tanzen0
export KUBECONFIG=~/.kube/tanzen-dev.yaml
kubectl get nodes
```

tazvm (the previous nested-VM cluster host) is shut down but not deleted:
`virsh -c qemu:///system start tazvm` to restore it.

---

## Directory layout

```
~/dev/tanzen-new/          (on tanzen0)
├── image/
│   └── talos-kata-spin.qcow2   # base image in libvirt default pool
└── terraform/
    ├── providers.tf             # libvirt 0.8.1 + talos 0.7.0
    ├── variables.tf
    ├── libvirt.tf               # network, volumes, q35 domains (BIOS mode)
    └── talos.tf                 # machine configs, bootstrap, kubeconfig output
```

**Image Factory schematic ID** (kata-containers + spin + qemu-guest-agent + net.ifnames=0):
`a7b2fa3d126d18830a68a309dccc695f24d0690d233f85c4a80ac66ea00fa0c3`

---

## Terraform

```bash
cd ~/dev/tanzen-new/terraform
terraform init        # providers: dmacvicar/libvirt 0.8.1, siderolabs/talos 0.7.0
terraform apply
terraform output -raw kubeconfig > ~/.kube/tanzen-dev.yaml
```

**Destroy / rebuild:**
```bash
terraform destroy
# orphaned domains from a failed apply may need manual cleanup:
for d in tz-controller-0 tz-worker-0 tz-worker-1; do
  virsh -c qemu:///system destroy $d 2>/dev/null
  virsh -c qemu:///system undefine $d 2>/dev/null
done
```

### Key design decisions

**DHCP for initial config apply.** VMs boot with random DHCP addresses. `talos_machine_configuration_apply`
uses `tolist(libvirt_domain.*.network_interface)[0].addresses[0]` (the live DHCP IP) as its
endpoint. The machine config then sets a static IP (10.17.5.80) on the controller.
Bootstrap and kubeconfig operations use the static IP, not DHCP.

**BIOS mode.** OVMF on tanzen0 uses `_4M` suffix files and requires per-VM NVRAM copies — simpler
to omit `firmware` entirely. Talos boots fine with BIOS on q35.

**Flannel.** Zero CNI config needed; Talos deploys it when `cluster.network.cni.name = flannel`.

**Workers use DHCP.** No static IPs on workers — IPs can change on VM restart. Only the controller
has a static IP (needed for bootstrap) and VIP (needed for the API endpoint).

---

## Runtime classes

Both deployed as inline manifests in the controller machine config (no separate apply needed):

```bash
kubectl get runtimeclass
# NAME               HANDLER
# kata               kata
# wasmtime-spin-v2   spin
```

---

## Kata smoke test

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: kata-test
spec:
  runtimeClassName: kata
  containers:
  - name: test
    image: busybox
    command: ["sh", "-c", "echo kernel=$(uname -r) && echo KATA_OK"]
  restartPolicy: Never
EOF
kubectl wait --for=condition=Succeeded pod/kata-test --timeout=120s
kubectl logs kata-test   # kernel=6.1.62 (vs host 6.12.6-talos) confirms VM isolation
kubectl delete pod kata-test
```

---

## Spin smoke test

Spin pods require `command: ["/_"]` — the CRI plugin requires a command before handing the spec
to the shim; the shim ignores it and runs the Wasm app.

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: spin-test
spec:
  runtimeClassName: wasmtime-spin-v2
  containers:
  - name: test
    image: ghcr.io/spinkube/containerd-shim-spin/examples/spin-rust-hello:v0.15.1
    command: ["/_"]
  restartPolicy: OnFailure
EOF
# spin-rust-hello is an HTTP server; test from inside the cluster:
SPIN_IP=$(kubectl get pod spin-test -o jsonpath="{.status.podIP}")
kubectl run curl-test --image=curlimages/curl --restart=Never --rm -i \
  --command -- curl -s "http://$SPIN_IP/hello"
# Hello world from Spin!
kubectl delete pod spin-test
```

> `ghcr.io/spinkube/spin-test:latest` does not exist publicly — use the `containerd-shim-spin/examples` image above.

---

## Known issues and workarounds

### kubelet-serving CSR auto-approval

`kubelet-serving-cert-approver` (alex1989hu) rejects Talos CSRs: Talos requests
`["digital signature", "server auth"]` but the approver expects additional key usages. Approve
manually after initial bootstrap and after any node replacement:

```bash
kubectl get csr | grep Pending | awk '{print $1}' | xargs kubectl certificate approve
```

### Worker node IPs change on VM restart

Workers get DHCP addresses. Check current leases:
```bash
virsh -c qemu:///system net-dhcp-leases tz-talos
```

The controller always comes up at 10.17.5.80 (static, configured in Talos machine config).

### libvirt provider v0.8.1 quirks

- No `data "libvirt_volume"` source — use `base_volume_name` + `base_volume_pool` on the resource.
- Orphaned domains from a failed apply block re-apply; clean up with `virsh undefine` first.
- `firmware =` triggers UEFI and requires `OVMF_VARS.fd` at an exact path; omit for BIOS.

### talosctl config

No `~/.talos/config` on tanzen0 — generate on demand:

```bash
cd ~/dev/tanzen-new/terraform
terraform state pull | python3 /tmp/tscripts/gen_talosconfig.py > /tmp/talosconfig.yaml
talosctl --talosconfig /tmp/talosconfig.yaml services --nodes 10.17.5.80
```

`/tmp/tscripts/gen_talosconfig.py` exists on tanzen0 from the original setup session.
If it's gone, it extracts `client_configuration` from the Terraform state and writes
a minimal talosconfig YAML.

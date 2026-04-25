# Tanzen Dev Clusters

Two Kubernetes clusters are maintained for Tanzen development, both available via
`~/.kube/config` on tanzen1.local (Mac).

## Contexts

| Context | Cluster | API Server | Profile | Platform |
|---------|---------|-----------|---------|----------|
| `kind-tanzen` | Kind (Docker) | `https://127.0.0.1:<local-port>` | `tanzenctl up --profile kind` | Mac ARM64, no Kata |
| `tanzen` | Talos v1.12.6 on tanzen0 KVM | `https://10.17.5.9:6443` | `tanzenctl up --profile talos --remote-workers tanzen0 --kata` | x86_64 KVM, Kata enabled |

Switch context:
```bash
kubectl config use-context kind-tanzen   # Mac kind cluster
kubectl config use-context tanzen        # tanzen0 Talos cluster
```

## kind-tanzen (Mac)

- **Type**: Kind (Docker/OrbStack)
- **Nodes**: 1 control-plane (ARM64)
- **Features**: Cilium + Hubble, KEDA, CloudNativePG, SeaweedFS, Temporal, Redis, Grafana
- **No Kata**: nested virtualisation unavailable in Docker on macOS
- **Create**: `tanzenctl up --profile kind`
- **Destroy**: `kind delete cluster --name tanzen`
- **Smoke tests**: all 10 pass ✓

## tanzen (Talos on tanzen0)

- **Type**: Full Talos v1.12.6 cluster — 1 controller + 2 workers as KVM VMs on tanzen0
- **Nodes**: `10.17.5.80` (CP), `10.17.5.57`, `10.17.5.126` (workers, DHCP — may change)
- **VIP**: `10.17.5.9:6443`
- **Features**: same as kind-tanzen **plus** Kata container runtime on workers
- **tanzen-worker**: deployed with `runtimeClassName: kata` on `kata.tanzen.dev/capable` nodes
- **Create**: `tanzenctl up --profile talos --remote-workers tanzen0 --kata`
- **Destroy**: `ssh tanzen0 "cd ~/dev/tanzen/infra/talos/terraform && terraform destroy -auto-approve"`
- **Smoke tests**: all 10 pass ✓

### Prerequisites for tanzen context

The route to tanzen0's KVM subnet must be active on tanzen1:
```bash
sudo route add -net 10.17.5.0/24 192.168.1.127
```

The iptables forwarding rule on tanzen0 is applied automatically by `tanzenctl provision`.
To restore it manually after tanzen0 reboots:
```bash
ssh tanzen0 "while sudo iptables -D LIBVIRT_FWI -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT 2>/dev/null; do :; done; \
  sudo iptables -I LIBVIRT_FWI 1 -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT"
```

To make it persistent on tanzen0:
```bash
ssh tanzen0 "sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save"
```

## Test Results

Both clusters tested with `infra/scripts/smoke-test.sh`:

| Test | kind-tanzen | tanzen (Talos) |
|------|------------|----------------|
| ST-01 PostgreSQL: tanzen DB reachable | ✓ | ✓ |
| ST-02 PostgreSQL: temporal DB reachable | ✓ | ✓ |
| ST-03 Temporal: cluster health SERVING | ✓ | ✓ |
| ST-04 Temporal: default namespace registered | ✓ | ✓ |
| ST-05 SeaweedFS: four S3 buckets exist | ✓ | ✓ |
| ST-06 SeaweedFS: S3 PutObject + GetObject round-trip | ✓ | ✓ |
| ST-07 Redis: PING returns PONG | ✓ | ✓ |
| ST-08 Redis: PUBLISH + SUBSCRIBE round-trip | ✓ | ✓ |
| ST-09 KEDA: ScaledObject CRD is registered | ✓ | ✓ |
| ST-10 Grafana: /api/health returns 200 | ✓ | ✓ |

### Kata isolation test (tanzen cluster only)

```
Pod kernel:  25.3.0    (Kata microVM kernel)
Host kernel: 6.18.18-talos
Result: KATA_OK — distinct kernel confirms VM isolation
```

`tanzen-worker` (Python Temporal activity worker) runs with `runtimeClassName: kata`
on `kata.tanzen.dev/capable=true` worker nodes and connects to Temporal successfully.

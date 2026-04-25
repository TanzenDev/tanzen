package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var (
	skipCluster bool
	profile     string
	withKata    bool
)

var upCmd = &cobra.Command{
	Use:   "up",
	Short: "Stand up the Tanzen dev environment",
	Long: `tanzenctl up orchestrates the full Tanzen environment setup.

Profiles:
  kind  (default) — Kind cluster on the local machine. Everything works except Kata.
  talos           — Full Talos cluster on a remote KVM host (all nodes on the same subnet).
                    Requires --remote-workers. Use --kata to install the Kata RuntimeClass.

Examples:
  tanzenctl up                                             # kind, no Kata
  tanzenctl up --profile talos --remote-workers tanzen0   # full Talos on tanzen0
  tanzenctl up --profile talos --remote-workers tanzen0 --kata  # + Kata RuntimeClass`,
	RunE: runUp,
}

func init() {
	upCmd.Flags().BoolVar(&skipCluster, "skip-cluster", false, "Skip cluster creation (use existing context)")
	upCmd.Flags().StringVar(&profile, "profile", "kind", `Cluster backend: "kind" or "talos"`)
	upCmd.Flags().BoolVar(&withKata, "kata", false, "Install Kata RuntimeClass (talos profile only)")
	upCmd.Flags().StringVar(&remoteWorkers, "remote-workers", "", "SSH host running libvirt (all cluster VMs created here)")
	upCmd.Flags().IntVar(&workerCount, "worker-count", 2, "Number of worker VMs")
	rootCmd.AddCommand(upCmd)
}

func runUp(_ *cobra.Command, _ []string) error {
	switch profile {
	case "kind":
		return runUpKind(repoRoot())
	case "talos":
		return runUpTalos(repoRoot())
	default:
		return fmt.Errorf("unknown profile %q — use kind or talos", profile)
	}
}

// ─── Kind profile ────────────────────────────────────────────────────────────

func runUpKind(root string) error {
	step("Checking prerequisites")
	prereqs := []string{"kind", "kubectl", "helm", "docker", "cilium"}
	if err := checkPrereqs(prereqs...); err != nil {
		return err
	}
	success("All prerequisites found")

	if !skipCluster {
		step("Creating Kind cluster")
		kindConfig := filepath.Join(root, "infra", "scripts", "kind-config.yaml")
		if _, err := os.Stat(kindConfig); err != nil {
			return fmt.Errorf("kind-config.yaml not found at %s", kindConfig)
		}
		if err := runCmd("kind", "create", "cluster", "--name", clusterName, "--config", kindConfig); err != nil {
			return fmt.Errorf("kind create cluster: %w", err)
		}
		success("Kind cluster created")
	}

	if err := addHelmRepos(); err != nil {
		return err
	}

	step("Installing Cilium CNI")
	apiServerIP, err := runCmdOutput("kubectl", "get", "node",
		clusterName+"-control-plane",
		"-o", `jsonpath={.status.addresses[?(@.type=="InternalIP")].address}`)
	if err != nil || apiServerIP == "" {
		return fmt.Errorf("could not get control-plane node IP: %w", err)
	}
	if err := installCiliumKind(apiServerIP); err != nil {
		return fmt.Errorf("install cilium: %w", err)
	}
	success("Cilium installed")

	step("Waiting for Cilium to be ready")
	if err := runCmd("cilium", "status", "--wait", "--wait-duration", "5m"); err != nil {
		return fmt.Errorf("cilium status --wait: %w", err)
	}
	success("Cilium ready")

	if withKata {
		if err := installKata(""); err != nil {
			warn("kata-deploy not ready (nested-virt unavailable on macOS Docker): " + err.Error())
		}
	}

	if err := applyL2AnnouncementsKind(); err != nil {
		warn("L2 Announcement resources: " + err.Error())
	}
	success("L2 Announcement resources applied")

	if err := applyNamespace(namespace); err != nil {
		return err
	}
	success("Namespace ready: " + namespace)

	if err := installOperators(); err != nil {
		return err
	}

	step("Generating secrets")
	if err := generateSecrets(); err != nil {
		return err
	}
	success("Secrets ready")

	if err := applyGrafanaDashboards(root); err != nil {
		warn("Grafana dashboards: " + err.Error())
	}

	step("Building and loading local images into Kind")
	workerImage := "tanzen-worker:latest"
	if err := runCmd("docker", "build", "-t", workerImage, filepath.Join(root, "worker")); err != nil {
		return fmt.Errorf("docker build tanzen-worker: %w", err)
	}
	if err := runCmd("kind", "load", "docker-image", workerImage, "--name", clusterName); err != nil {
		return fmt.Errorf("kind load tanzen-worker: %w", err)
	}
	success(workerImage + " loaded")
	for _, srv := range mcpServers {
		image := fmt.Sprintf("mcp-%s:latest", srv.name)
		dir := filepath.Join(root, "mcp", srv.name)
		if err := runCmd("docker", "build", "-t", image, dir); err != nil {
			return fmt.Errorf("docker build %s: %w", srv.name, err)
		}
		if err := runCmd("kind", "load", "docker-image", image, "--name", clusterName); err != nil {
			return fmt.Errorf("kind load %s: %w", srv.name, err)
		}
		success(image + " loaded")
	}

	if err := installTanzenChart(root); err != nil {
		return err
	}

	step("Registering Temporal default namespace")
	if err := registerTemporalNamespace(); err != nil {
		warn("Temporal namespace registration failed (non-fatal): " + err.Error())
	} else {
		success("Temporal namespace 'default' registered")
	}

	fmt.Println()
	success("Environment is up! Run port-forwards with:")
	fmt.Println("  tanzenctl forward")
	return nil
}

// ─── Talos profile ───────────────────────────────────────────────────────────

func runUpTalos(root string) error {
	if remoteWorkers == "" {
		return fmt.Errorf("--remote-workers <host> is required for the talos profile (e.g. --remote-workers tanzen0)")
	}

	step("Checking prerequisites")
	if err := checkPrereqs("kubectl", "helm", "ssh", "rsync"); err != nil {
		return err
	}
	success("All prerequisites found")

	if !skipCluster {
		if err := provisionTalosCluster(root); err != nil {
			return err
		}
	} else {
		kubeconfigPath := filepath.Join(os.Getenv("HOME"), ".kube", clusterName+".yaml")
		if _, err := os.Stat(kubeconfigPath); err == nil {
			os.Setenv("KUBECONFIG", kubeconfigPath)
			kubeconfig = kubeconfigPath
		}
	}

	// All nodes are on the same 10.17.5.0/24 subnet — no routing hacks needed.
	// Talos clusters have no default StorageClass; install local-path-provisioner.
	step("Installing local-path-provisioner (default StorageClass)")
	lppManifest := filepath.Join(root, "infra", "deps", "local-path-provisioner.yaml")
	if err := runCmd("kubectl", "apply", "-f", lppManifest); err != nil {
		return fmt.Errorf("local-path-provisioner: %w", err)
	}
	_ = runCmd("kubectl", "label", "ns", "storage",
		"pod-security.kubernetes.io/enforce=privileged",
		"pod-security.kubernetes.io/enforce-version=latest",
		"--overwrite")
	if err := runCmd("kubectl", "patch", "storageclass", "local-path",
		"-p", `{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}`); err != nil {
		return fmt.Errorf("set default storageclass: %w", err)
	}
	if err := runCmd("kubectl", "wait", "deploy", "local-path-provisioner",
		"-n", "storage", "--for=condition=Available", "--timeout=2m"); err != nil {
		warn("local-path-provisioner not ready: " + err.Error())
	}
	success("local-path-provisioner installed")

	if err := addHelmRepos(); err != nil {
		return err
	}

	step("Installing Cilium CNI")
	if err := installCiliumTalos(); err != nil {
		return fmt.Errorf("install cilium: %w", err)
	}
	success("Cilium installed")

	step("Waiting for Cilium to be ready")
	_ = runCmd("kubectl", "wait", "deploy", "cilium-operator",
		"-n", "kube-system", "--for=condition=Available", "--timeout=5m")
	if err := runCmd("kubectl", "wait", "pod", "-l", "k8s-app=cilium",
		"-n", "kube-system", "--for=condition=Ready", "--timeout=10m"); err != nil {
		warn("cilium agent wait: " + err.Error())
	}
	success("Cilium ready")

	// Wait for worker nodes (all on the same subnet — no polling hacks needed).
	step("Waiting for worker nodes to be Ready (up to 12m)")
	if err := waitForWorkerNodes(12 * 60); err != nil {
		warn("workers not Ready in time: " + err.Error())
	} else {
		success("Worker nodes Ready")
	}
	if err := approveKubeletCSRs(); err != nil {
		warn("CSR approval: " + err.Error())
	}

	if withKata {
		// RuntimeClass is already applied via Talos inline manifest in the machine config.
		// No kata-deploy DaemonSet needed (Talos kata-containers extension pre-installs binaries).
		if err := installKata(`kata\.tanzen\.dev/capable=true`); err != nil {
			warn("kata RuntimeClass: " + err.Error())
		}
	}

	if err := applyNamespace(namespace); err != nil {
		return err
	}
	success("Namespace ready: " + namespace)

	if err := installOperators(); err != nil {
		return err
	}

	step("Generating secrets")
	if err := generateSecrets(); err != nil {
		return err
	}
	success("Secrets ready")

	if err := applyGrafanaDashboards(root); err != nil {
		warn("Grafana dashboards: " + err.Error())
	}

	// Build and push local images to DockerHub so Talos can pull them directly.
	// talosctl image import was removed in v1.11+; public registry is the clean path.
	const dockerHubOrg = "tanzen"
	type imageSpec struct {
		localName, hubRepo, helmSetKey string
		buildDir                       string
	}
	localImgs := []imageSpec{
		{"tanzen-worker:latest", dockerHubOrg + "/workers:latest",
			"worker.image.repository=tanzen/workers,worker.image.tag=latest",
			filepath.Join(root, "worker")},
		{"mcp-sequential-thinking:latest", dockerHubOrg + "/mcp-sequential-thinking:latest",
			"mcp.sequentialThinking.image=" + dockerHubOrg + "/mcp-sequential-thinking:latest",
			filepath.Join(root, "mcp", "sequential-thinking")},
		{"mcp-fetch:latest", dockerHubOrg + "/mcp-fetch:latest",
			"mcp.fetch.image=" + dockerHubOrg + "/mcp-fetch:latest",
			filepath.Join(root, "mcp", "fetch")},
		{"mcp-falkordb:latest", dockerHubOrg + "/mcp-falkordb:latest",
			"mcp.falkordb.mcpImage=" + dockerHubOrg + "/mcp-falkordb:latest",
			filepath.Join(root, "mcp", "falkordb")},
	}
	var helmImageOverrides []string
	// Use buildx with --platform linux/amd64 so images work on x86_64 workers.
	step("Building and pushing local images to DockerHub (" + dockerHubOrg + ") [linux/amd64]")
	for _, img := range localImgs {
		if err := runCmd("docker", "buildx", "build",
			"--platform", "linux/amd64",
			"--push",
			"-t", img.hubRepo,
			img.buildDir,
		); err != nil {
			warn(fmt.Sprintf("docker buildx %s: %v — pod may ImagePullBackOff", img.hubRepo, err))
			continue
		}
		helmImageOverrides = append(helmImageOverrides, img.helmSetKey)
		success(img.hubRepo + " pushed (linux/amd64)")
	}

	// Build the helm install args with DockerHub image overrides.
	var extraHelmArgs []string
	for _, s := range helmImageOverrides {
		extraHelmArgs = append(extraHelmArgs, "--set", s)
	}
	if withKata && remoteWorkers != "" {
		extraHelmArgs = append(extraHelmArgs, "--set", "worker.kata.enabled=true")
	}

	// Install without --wait: any unpushed images would cause timeout.
	// Wait on core infrastructure explicitly after install.
	if err := installTanzenChartNoWaitExtra(root, extraHelmArgs); err != nil {
		return err
	}
	step("Waiting for core infrastructure (CNPG, Temporal, SeaweedFS)")
	// Wait for the schema job first so Temporal services don't start against an
	// incomplete schema and enter CrashLoopBackOff.
	_ = runCmd("kubectl", "wait", "job", "tanzen-temporal-schema",
		"-n", namespace, "--for=condition=Complete", "--timeout=5m")
	for _, target := range []struct{ kind, name, cond string }{
		{"cluster.postgresql.cnpg.io", "tanzen-postgres", "Ready"},
		{"deployment", "tanzen-temporal-frontend", "Available"},
		{"deployment", "seaweedfs-master", "Available"},
	} {
		if err := runCmd("kubectl", "wait", target.kind, target.name,
			"-n", namespace, "--for=condition="+target.cond, "--timeout=10m"); err != nil {
			warn(target.name + " not ready: " + err.Error())
		}
	}

	step("Registering Temporal default namespace")
	if err := registerTemporalNamespace(); err != nil {
		warn("Temporal namespace registration failed (non-fatal): " + err.Error())
	} else {
		success("Temporal namespace 'default' registered")
	}

	fmt.Println()
	success("Environment is up! Run port-forwards with:")
	fmt.Println("  tanzenctl forward")
	return nil
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

func addHelmRepos() error {
	step("Adding Helm repositories")
	repos := []struct{ name, url string }{
		{"cilium", "https://helm.cilium.io/"},
		{"cnpg", "https://cloudnative-pg.github.io/charts"},
		{"temporal", "https://go.temporal.io/helm-charts"},
		{"bitnami", "https://charts.bitnami.com/bitnami"},
		{"prometheus-community", "https://prometheus-community.github.io/helm-charts"},
		{"kedacore", "https://kedacore.github.io/charts"},
		{"ingress-nginx", "https://kubernetes.github.io/ingress-nginx"},
	}
	for _, r := range repos {
		if err := runCmd("helm", "repo", "add", r.name, r.url, "--force-update"); err != nil {
			return fmt.Errorf("helm repo add %s: %w", r.name, err)
		}
	}
	if err := runCmd("helm", "repo", "update"); err != nil {
		return fmt.Errorf("helm repo update: %w", err)
	}
	success("Helm repos up to date")
	return nil
}

func installCiliumKind(apiServerIP string) error {
	return runCmd("helm", "upgrade", "--install", "cilium", "cilium/cilium",
		"--namespace", "kube-system",
		"--set", "kubeProxyReplacement=true",
		"--set", "socketLB.hostNamespaceOnly=true",
		"--set", "k8sServiceHost="+apiServerIP,
		"--set", "k8sServicePort=6443",
		"--set", "operator.replicas=1",
		"--set", "l2announcements.enabled=true",
		"--set", "l2announcements.leaseDuration=3s",
		"--set", "l2announcements.renewDeadline=1s",
		"--set", "l2announcements.retryPeriod=200ms",
		"--set", "externalIPs.enabled=true",
		"--set", "hubble.relay.enabled=true",
		"--set", "hubble.ui.enabled=true",
		"--wait",
	)
}

// installCiliumTalos installs Cilium for a Talos cluster. Talos manages
// cgroups itself, so autoMount is disabled. kubePrism runs on localhost:7445.
// socketLB.hostNamespaceOnly=true is required when Kata is present.
func installCiliumTalos() error {
	// Do not use --wait: hubble-relay and hubble-ui take longer to become available
	// because they need Cilium agents running on all nodes (including worker nodes
	// that join after Cilium is installed). We wait on the operator and DaemonSet
	// explicitly in runUpTalos instead.
	return runCmd("helm", "upgrade", "--install", "cilium", "cilium/cilium",
		"--namespace", "kube-system",
		"--set", "ipam.mode=kubernetes",
		"--set", "kubeProxyReplacement=true",
		"--set", "socketLB.hostNamespaceOnly=true",
		"--set", "k8sServiceHost=localhost",
		"--set", "k8sServicePort=7445",
		"--set", "cgroup.autoMount.enabled=false",
		"--set", "cgroup.hostRoot=/sys/fs/cgroup",
		"--set", "securityContext.capabilities.ciliumAgent={CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}",
		"--set", "securityContext.capabilities.cleanCiliumState={NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}",
		"--set", "operator.replicas=1",
		"--set", "hubble.relay.enabled=true",
		"--set", "hubble.ui.enabled=true",
	)
}

// installCiliumDockerTalos installs Cilium on a Docker-provisioned Talos cluster.
// The Docker provisioner already runs Flannel + kube-proxy so kubeProxyReplacement
// and kubePrism are not used. sysctlfix is incompatible with Talos.
// Cgroup settings are omitted — Docker-provisioned Talos manages cgroups via the
// outer Docker runtime and setting them here causes capability errors in nested containers.
func installCiliumDockerTalos(nodeIP string) error {
	return runCmd("helm", "upgrade", "--install", "cilium", "cilium/cilium",
		"--namespace", "kube-system",
		"--set", "k8sServiceHost="+nodeIP,
		"--set", "k8sServicePort=6443",
		"--set", "operator.replicas=1",
		"--set", "sysctlfix.enabled=false",
		"--set", "rollOutCiliumPods=true",
		"--set", "hubble.relay.enabled=false",
		"--set", "hubble.ui.enabled=false",
		"--set", "securityContext.privileged=true",
		"--wait",
	)
}

// installKata creates the kata RuntimeClass for the Talos kata-containers system
// extension. The extension pre-installs kata binaries and configures containerd
// with handler name "kata" — no kata-deploy DaemonSet is needed (kata-deploy
// tries to write to /etc/crio/ which is read-only on Talos).
func installKata(nodeSelector string) error {
	step("Installing Kata RuntimeClass (Talos kata-containers extension)")
	kataRC := `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata
handler: kata
`
	if err := runCmdIn(kataRC, "kubectl", "apply", "-f", "-"); err != nil {
		return err
	}
	success("Kata RuntimeClass 'kata' created (handler: kata)")
	return nil
}

func applyL2AnnouncementsKind() error {
	step("Applying L2 Announcement resources")
	l2yaml := `---
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: kind-pool
spec:
  blocks:
    - cidr: "172.18.100.200/29"
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: default
spec:
  loadBalancerIPs: true
  externalIPs: true
  interfaces:
    - ^eth[0-9]+
`
	return runCmdIn(l2yaml, "kubectl", "apply", "-f", "-")
}

func installOperators() error {
	step("Installing cluster-scoped operators")
	// keda requires privileged pod security — pre-create the namespace with the labels
	// so they're in place before helm's --create-namespace runs.
	nsYaml := `apiVersion: v1
kind: Namespace
metadata:
  name: keda
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/enforce-version: latest
`
	_ = runCmdIn(nsYaml, "kubectl", "apply", "-f", "-")
	operators := []struct {
		release, chart, ns string
		extraArgs          []string
	}{
		{"keda", "kedacore/keda", "keda", nil},
		{"cnpg", "cnpg/cloudnative-pg", "cnpg-system", nil},
		{"ingress-nginx", "ingress-nginx/ingress-nginx", "ingress-nginx",
			[]string{"--set", "controller.service.type=NodePort"}},
	}
	for _, op := range operators {
		args := []string{"upgrade", "--install", op.release, op.chart,
			"-n", op.ns, "--create-namespace", "--wait", "--timeout", "15m"}
		args = append(args, op.extraArgs...)
		if err := runCmd("helm", args...); err != nil {
			return fmt.Errorf("install operator %s: %w", op.release, err)
		}
	}
	success("Operators installed")
	return nil
}

func applyGrafanaDashboards(root string) error {
	step("Applying Grafana dashboards ConfigMap")
	dashboardsCM := filepath.Join(root, "infra", "deps", "grafana", "dashboards-configmap.yaml")
	if _, err := os.Stat(dashboardsCM); err != nil {
		warn("Grafana dashboards ConfigMap not found, skipping")
		return nil
	}
	content, err := os.ReadFile(dashboardsCM)
	if err != nil {
		return err
	}
	// The ConfigMap uses {{ NAMESPACE }} (bootstrap.sh convention); .Release.Namespace
	// is the Helm template variant. Handle both to be safe.
	patched := strings.ReplaceAll(string(content), "{{ NAMESPACE }}", namespace)
	patched = strings.ReplaceAll(patched, "{{ .Release.Namespace }}", namespace)
	return runCmdIn(patched, "kubectl", "apply", "-f", "-", "-n", namespace)
}

func installTanzenChart(root string) error {
	return installTanzenChartOpts(root, true, nil)
}

func installTanzenChartNoWait(root string) error {
	return installTanzenChartNoWaitExtra(root, nil)
}

func installTanzenChartNoWaitExtra(root string, extraArgs []string) error {
	return installTanzenChartOpts(root, false, extraArgs)
}

func installTanzenChartOpts(root string, wait bool, extraArgs []string) error {
	chartDir := filepath.Join(root, "infra", "charts", "tanzen")
	step("Running helm dependency update")
	if err := runCmd("helm", "dependency", "update", chartDir); err != nil {
		return fmt.Errorf("helm dependency update: %w", err)
	}
	step("Installing tanzen Helm chart")
	valuesFile := filepath.Join(chartDir, "values.yaml")
	args := []string{"upgrade", "--install", "tanzen", chartDir,
		"-n", namespace, "-f", valuesFile, "--timeout", "10m"}
	if wait {
		args = append(args, "--wait")
	}
	args = append(args, extraArgs...)
	if err := runCmd("helm", args...); err != nil {
		return fmt.Errorf("helm upgrade tanzen: %w", err)
	}
	success("Tanzen chart installed")
	return nil
}

func applyNamespace(ns string) error {
	yaml := fmt.Sprintf("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s\n", ns)
	return runCmdIn(yaml, "kubectl", "apply", "-f", "-")
}

func generateSecrets() error {
	type secretSpec struct {
		name     string
		literals map[string]string
	}
	specs := []secretSpec{
		{"temporal-db-credentials", map[string]string{"username": "temporal_user", "password": randHex(16)}},
		{"tanzen-db-credentials", map[string]string{"username": "tanzen_user", "password": randHex(16)}},
		{"seaweedfs-db-credentials", map[string]string{"username": "seaweedfs_user", "password": randHex(16)}},
		{"seaweedfs-s3-credentials", map[string]string{"access_key": randHex(12), "secret_key": randHex(24)}},
		{"grafana-admin-credentials", map[string]string{"username": "admin", "password": randHex(12)}},
	}
	for _, s := range specs {
		if err := createSecretIfMissing(s.name, s.literals); err != nil {
			return fmt.Errorf("secret %s: %w", s.name, err)
		}
	}
	return nil
}

// waitForWorkerNodes polls until at least one non-control-plane node exists and
// all of them are Ready, or timeoutSecs is exceeded.
func waitForWorkerNodes(timeoutSecs int) error {
	deadline := time.Now().Add(time.Duration(timeoutSecs) * time.Second)
	tick := 15 * time.Second
	for time.Now().Before(deadline) {
		// jsonpath returns empty string (not "No resources found") when no nodes match.
		out, _ := runCmdOutput("kubectl", "get", "node",
			"--selector=!node-role.kubernetes.io/control-plane",
			"-o", "jsonpath={.items[*].metadata.name}")
		if strings.TrimSpace(out) != "" {
			remaining := time.Until(deadline).Truncate(time.Second)
			return runCmd("kubectl", "wait", "node",
				"--selector=!node-role.kubernetes.io/control-plane",
				"--for=condition=Ready",
				fmt.Sprintf("--timeout=%s", remaining))
		}
		fmt.Printf("  no worker nodes yet, retrying in %s...\n", tick)
		time.Sleep(tick)
	}
	return fmt.Errorf("timed out waiting for worker nodes to appear")
}

func registerTemporalNamespace() error {
	pod, err := runCmdOutput("kubectl", "get", "pod", "-n", namespace,
		"-l", "app.kubernetes.io/name=temporal,app.kubernetes.io/component=admintools",
		"-o", "jsonpath={.items[0].metadata.name}")
	if err != nil || pod == "" {
		return fmt.Errorf("admintools pod not found")
	}
	return runCmd("kubectl", "exec", "-n", namespace, pod, "--",
		"temporal", "operator", "namespace", "create", "default",
		"--address", "tanzen-temporal-frontend:7233")
}

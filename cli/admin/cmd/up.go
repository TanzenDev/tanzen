package cmd

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var skipCluster bool

var upCmd = &cobra.Command{
	Use:   "up",
	Short: "Create Kind cluster and install all Tanzen components",
	Long: `tanzenctl up orchestrates the full dev environment setup:

  1. Creates a Kind cluster (unless --skip-cluster)
  2. Adds Helm repos and installs cluster-scoped operators
  3. Generates secrets (idempotent)
  4. Installs the tanzen Helm chart
  5. Registers the Temporal namespace

Equivalent to running infra/scripts/bootstrap.sh --new-cluster.`,
	RunE: runUp,
}

func init() {
	upCmd.Flags().BoolVar(&skipCluster, "skip-cluster", false, "Skip Kind cluster creation (use existing context)")
	rootCmd.AddCommand(upCmd)
}

func runUp(_ *cobra.Command, _ []string) error {
	root := repoRoot()

	step("Checking prerequisites")
	if err := checkPrereqs("kind", "kubectl", "helm", "docker"); err != nil {
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

	step("Adding Helm repositories")
	repos := []struct{ name, url string }{
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

	step("Creating namespace")
	if err := applyNamespace(namespace); err != nil {
		return err
	}
	success("Namespace ready: " + namespace)

	step("Installing cluster-scoped operators")
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
		args := []string{
			"upgrade", "--install", op.release, op.chart,
			"-n", op.ns, "--create-namespace", "--wait",
		}
		args = append(args, op.extraArgs...)
		if err := runCmd("helm", args...); err != nil {
			return fmt.Errorf("install operator %s: %w", op.release, err)
		}
	}
	success("Operators installed")

	step("Generating secrets")
	if err := generateSecrets(); err != nil {
		return err
	}
	success("Secrets ready")

	step("Applying Grafana dashboards ConfigMap")
	dashboardsCM := filepath.Join(root, "infra", "deps", "grafana", "dashboards-configmap.yaml")
	if _, err := os.Stat(dashboardsCM); err == nil {
		// Substitute namespace placeholder if any
		content, err := os.ReadFile(dashboardsCM)
		if err != nil {
			return err
		}
		patched := strings.ReplaceAll(string(content), "{{ .Release.Namespace }}", namespace)
		applyCmd := osexec.Command("kubectl", "apply", "-f", "-", "-n", namespace)
		applyCmd.Stdin = strings.NewReader(patched)
		applyCmd.Stdout = os.Stdout
		applyCmd.Stderr = os.Stderr
		if err := applyCmd.Run(); err != nil {
			warn("Grafana ConfigMap apply failed (non-fatal): " + err.Error())
		}
	} else {
		warn("Grafana dashboards ConfigMap not found, skipping")
	}

	step("Building and loading MCP images into Kind")
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

	step("Running helm dependency update")
	chartDir := filepath.Join(root, "infra", "charts", "tanzen")
	if err := runCmd("helm", "dependency", "update", chartDir); err != nil {
		return fmt.Errorf("helm dependency update: %w", err)
	}

	step("Installing tanzen Helm chart")
	valuesFile := filepath.Join(chartDir, "values.yaml")
	if err := runCmd("helm", "upgrade", "--install", "tanzen", chartDir,
		"-n", namespace, "-f", valuesFile, "--wait", "--timeout", "10m"); err != nil {
		return fmt.Errorf("helm upgrade tanzen: %w", err)
	}
	success("Tanzen chart installed")

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

func applyNamespace(ns string) error {
	yaml := fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
`, ns)
	applyCmd := osexec.Command("kubectl", "apply", "-f", "-")
	applyCmd.Stdin = strings.NewReader(yaml)
	applyCmd.Stdout = os.Stdout
	applyCmd.Stderr = os.Stderr
	return applyCmd.Run()
}

func generateSecrets() error {
	type secretSpec struct {
		name     string
		literals map[string]string
	}
	specs := []secretSpec{
		{
			"temporal-db-credentials",
			map[string]string{"username": "temporal_user", "password": randHex(16)},
		},
		{
			"tanzen-db-credentials",
			map[string]string{"username": "tanzen_user", "password": randHex(16)},
		},
		{
			"seaweedfs-db-credentials",
			map[string]string{"username": "seaweedfs_user", "password": randHex(16)},
		},
		{
			"seaweedfs-s3-credentials",
			map[string]string{"access_key": randHex(12), "secret_key": randHex(24)},
		},
		{
			"grafana-admin-credentials",
			map[string]string{"username": "admin", "password": randHex(12)},
		},
	}
	for _, s := range specs {
		if err := createSecretIfMissing(s.name, s.literals); err != nil {
			return fmt.Errorf("secret %s: %w", s.name, err)
		}
	}
	return nil
}

func registerTemporalNamespace() error {
	// Find the admintools pod
	pod, err := runCmdOutput("kubectl", "get", "pod", "-n", namespace,
		"-l", "app.kubernetes.io/name=temporalite,app.kubernetes.io/component=admintools",
		"-o", "jsonpath={.items[0].metadata.name}")
	if err != nil || pod == "" {
		// Try alternate label used by temporal helm chart
		pod, err = runCmdOutput("kubectl", "get", "pod", "-n", namespace,
			"-l", "app=temporal-admintools",
			"-o", "jsonpath={.items[0].metadata.name}")
	}
	if err != nil || pod == "" {
		return fmt.Errorf("admintools pod not found")
	}
	return runCmd("kubectl", "exec", "-n", namespace, pod, "--",
		"temporal", "operator", "namespace", "create", "default",
		"--namespace", "default")
}

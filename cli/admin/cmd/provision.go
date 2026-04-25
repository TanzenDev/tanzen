package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

// Package-level vars shared with upCmd flags.
var (
	remoteWorkers string
	workerCount   int
)

var provisionCmd = &cobra.Command{
	Use:   "provision",
	Short: "Provision full Talos cluster on a remote KVM host",
	Long: `tanzenctl provision creates a complete Talos cluster (controller + workers)
as KVM VMs on a remote libvirt host via Terraform.

Terraform runs directly on the remote host (no SSH tunnel — qemu:///system).
The kubeconfig and talosconfig are written locally after provisioning.

Requirements on the remote host:
  - libvirt/KVM with the current user in the libvirt group
  - Terraform >= 1.10 (for the siderolabs/talos provider)
  - Talos base image with kata-containers extension in the default pool
  - passwordless SSH from this machine`,
	RunE: runProvision,
}

func init() {
	provisionCmd.Flags().StringVar(&remoteWorkers, "remote-workers", "", "SSH host running libvirt (all cluster VMs created here)")
	provisionCmd.Flags().IntVar(&workerCount, "worker-count", 2, "Number of worker VMs")
	rootCmd.AddCommand(provisionCmd)
}

func runProvision(_ *cobra.Command, _ []string) error {
	if remoteWorkers == "" {
		return fmt.Errorf("--remote-workers <host> is required (e.g. tanzen0)")
	}
	return provisionTalosCluster(repoRoot())
}

// provisionTalosCluster creates a complete Talos cluster (controller + workers)
// as KVM VMs on the remote libvirt host. Terraform runs on the remote host
// directly (qemu:///system), which avoids SSH tunnel issues and the 35ms LAN
// latency that plagued the Docker-CP-on-Mac approach.
//
// Flow:
//  1. rsync the Terraform directory to the remote host
//  2. Run terraform init + apply on the remote host via SSH
//  3. Pull kubeconfig and talosconfig from Terraform outputs
//  4. Write kubeconfig to ~/.kube/<cluster>.yaml
func provisionTalosCluster(root string) error {
	step("Provisioning Talos cluster on " + remoteWorkers)

	if err := checkRemotePrereqs(remoteWorkers, "virsh", "terraform"); err != nil {
		return fmt.Errorf("remote host %s: %w", remoteWorkers, err)
	}

	sshHost := remoteWorkers
	if !strings.Contains(sshHost, "@") {
		sshHost = os.Getenv("USER") + "@" + sshHost
	}

	tfDir := filepath.Join(root, "infra", "talos", "terraform")
	remoteTfDir := fmt.Sprintf("/home/%s/dev/tanzen/infra/talos/terraform", os.Getenv("USER"))

	// Sync the Terraform directory to the remote host.
	step("Syncing Terraform to " + remoteWorkers)
	if err := runCmd("ssh", sshHost, "mkdir", "-p", remoteTfDir); err != nil {
		return fmt.Errorf("mkdir remote tf dir: %w", err)
	}
	if err := runCmd("rsync", "-az", "--delete",
		"--exclude=.terraform",
		"--exclude=terraform.tfstate*",
		"--exclude=.terraform.lock.hcl",
		tfDir+"/", sshHost+":"+remoteTfDir+"/",
	); err != nil {
		return fmt.Errorf("rsync terraform: %w", err)
	}

	// Run terraform on the remote host. Pass as a single string so SSH forwards
	// it verbatim to the remote shell (avoids argument-splitting quoting issues).
	tfApplyCmd := fmt.Sprintf("cd %s && terraform init -upgrade && terraform apply -auto-approve -var 'worker_count=%d'",
		remoteTfDir, workerCount)
	step("Running terraform on " + remoteWorkers)
	if err := runCmd("ssh", sshHost, tfApplyCmd); err != nil {
		return fmt.Errorf("terraform apply: %w", err)
	}

	// Pull kubeconfig from Terraform output.
	kubeconfigPath := filepath.Join(os.Getenv("HOME"), ".kube", clusterName+".yaml")
	step("Writing kubeconfig to " + kubeconfigPath)
	kubeconfigRaw, err := runCmdOutput("ssh", sshHost,
		fmt.Sprintf("cd %s && terraform output -raw kubeconfig", remoteTfDir))
	if err != nil || strings.TrimSpace(kubeconfigRaw) == "" {
		return fmt.Errorf("terraform output kubeconfig: %w", err)
	}
	if err := os.WriteFile(kubeconfigPath, []byte(kubeconfigRaw), 0600); err != nil {
		return fmt.Errorf("write kubeconfig: %w", err)
	}
	os.Setenv("KUBECONFIG", kubeconfigPath)
	kubeconfig = kubeconfigPath

	// Pull talosconfig from Terraform output and write to standard location.
	talosCfgDir := filepath.Join(os.Getenv("HOME"), ".talos", "clusters", clusterName)
	if err := os.MkdirAll(talosCfgDir, 0750); err != nil {
		return fmt.Errorf("mkdir talosconfig dir: %w", err)
	}
	talosCfgPath := filepath.Join(talosCfgDir, "talosconfig")
	talosCfgRaw, err := runCmdOutput("ssh", sshHost,
		fmt.Sprintf("cd %s && terraform output -json talosconfig", remoteTfDir))
	if err == nil && strings.TrimSpace(talosCfgRaw) != "" {
		// Output is a JSON object — extract the fields we need.
		var talosCfg struct {
			CAData         string `json:"ca_certificate"`
			ClientCert     string `json:"client_certificate"`
			ClientKey      string `json:"client_key"`
		}
		if json.Unmarshal([]byte(talosCfgRaw), &talosCfg) == nil {
			_ = talosCfg // stored as raw JSON for talosctl to use
		}
		// Write as raw JSON for reference; talosctl can use the kubeconfig.
		_ = os.WriteFile(talosCfgPath+".json", []byte(talosCfgRaw), 0600)
	}

	// Allow Mac (192.168.1.0/24) to reach cluster VMs through tanzen0's libvirt bridge.
	// libvirt's LIBVIRT_FWI chain blocks inbound forwarding by default; this rule
	// inserts an ACCEPT for the Mac's subnet.
	step("Allowing Mac subnet through tanzen0 libvirt firewall")
	allowFwdCmd := fmt.Sprintf(
		"sudo iptables -C LIBVIRT_FWI -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT 2>/dev/null || "+
			"sudo iptables -I LIBVIRT_FWI 1 -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT",
	)
	if err := runCmd("ssh", sshHost, allowFwdCmd); err != nil {
		warn("iptables LIBVIRT_FWI rule: " + err.Error() +
			"\n  Manual: ssh tanzen0 'sudo iptables -I LIBVIRT_FWI 1 -s 192.168.1.0/24 -d 10.17.5.0/24 -j ACCEPT'")
	}

	success(fmt.Sprintf("Cluster provisioned — kubeconfig: %s", kubeconfigPath))
	fmt.Printf("  Mac route required: sudo route add -net 10.17.5.0/24 192.168.1.127\n")
	return nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// checkRemotePrereqs verifies passwordless SSH and that required tools exist
// on the remote host.
func checkRemotePrereqs(host string, tools ...string) error {
	if _, err := runCmdOutput("ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
		host, "echo", "ok"); err != nil {
		return fmt.Errorf("passwordless SSH to %s failed — ensure your key is in authorized_keys", host)
	}
	missing := []string{}
	for _, t := range tools {
		out, _ := runCmdOutput("ssh", host, "command", "-v", t)
		if strings.TrimSpace(out) == "" {
			missing = append(missing, t)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing on %s: %s", host, strings.Join(missing, ", "))
	}
	return nil
}

// approveKubeletCSRs approves all pending kubelet-serving CSRs.
func approveKubeletCSRs() error {
	csrs, err := runCmdOutput("kubectl", "get", "csr",
		"-o", "jsonpath={.items[?(@.status.conditions[0].type==\"Pending\")].metadata.name}")
	if err != nil {
		return err
	}
	names := strings.Fields(csrs)
	if len(names) == 0 {
		return nil
	}
	args := append([]string{"certificate", "approve"}, names...)
	return runCmd("kubectl", args...)
}

// parseJSONStringSlice decodes a JSON array of strings.
func parseJSONStringSlice(s string) ([]string, error) {
	var result []string
	if err := json.Unmarshal([]byte(s), &result); err != nil {
		return nil, err
	}
	return result, nil
}

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"

	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"
)

var secretCmd = &cobra.Command{
	Use:   "secret",
	Short: "Manage Tanzen k8s secrets",
}

var secretSetCmd = &cobra.Command{
	Use:   "set <name> <value>",
	Short: "Create or update a k8s secret (labeled tanzen/managed=true)",
	Args:  cobra.ExactArgs(2),
	RunE:  runSecretSet,
}

var secretDeleteYes bool
var secretDeleteCmd = &cobra.Command{
	Use:   "delete <name>",
	Short: "Delete a k8s secret",
	Args:  cobra.ExactArgs(1),
	RunE:  runSecretDelete,
}

var secretListCmd = &cobra.Command{
	Use:   "list",
	Short: "List Tanzen-managed k8s secrets",
	RunE:  runSecretList,
}

func init() {
	secretDeleteCmd.Flags().BoolVar(&secretDeleteYes, "yes", false, "Skip confirmation")
	secretCmd.AddCommand(secretSetCmd, secretDeleteCmd, secretListCmd)
	rootCmd.AddCommand(secretCmd)
}

func runSecretSet(_ *cobra.Command, args []string) error {
	name, value := args[0], args[1]
	// Always upsert: generate YAML with --dry-run=client then pipe to apply.
	yaml, err := runCmdOutput("kubectl", "create", "secret", "generic", name,
		"-n", namespace, "--from-literal=value="+value,
		"--dry-run=client", "-o", "yaml")
	if err != nil {
		return fmt.Errorf("build secret YAML: %w", err)
	}
	applyCmd := osexec.Command("kubectl", "apply", "-f", "-")
	applyCmd.Stdin = strings.NewReader(yaml)
	applyCmd.Stdout = os.Stdout
	applyCmd.Stderr = os.Stderr
	if err := applyCmd.Run(); err != nil {
		return fmt.Errorf("apply secret: %w", err)
	}
	if err := labelSecret(name); err != nil {
		return err
	}
	success(fmt.Sprintf("Secret %q set", name))
	return nil
}

func runSecretDelete(_ *cobra.Command, args []string) error {
	name := args[0]
	if !secretDeleteYes {
		fmt.Printf("Delete secret %q in namespace %s? Run with --yes to confirm.\n", name, namespace)
		return nil
	}
	return runCmd("kubectl", "delete", "secret", name, "-n", namespace)
}

type secretListJSON struct {
	Items []struct {
		Metadata struct {
			Name              string            `json:"name"`
			CreationTimestamp string            `json:"creationTimestamp"`
			Labels            map[string]string `json:"labels"`
		} `json:"metadata"`
	} `json:"items"`
}

func runSecretList(_ *cobra.Command, _ []string) error {
	out, err := runCmdOutput("kubectl", "get", "secrets", "-n", namespace,
		"-l", "tanzen/managed=true", "-o", "json")
	if err != nil {
		return fmt.Errorf("kubectl get secrets: %w", err)
	}

	var list secretListJSON
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return fmt.Errorf("parse secrets: %w", err)
	}

	if len(list.Items) == 0 {
		fmt.Println("No Tanzen-managed secrets found in namespace " + namespace)
		return nil
	}

	tw := tablewriter.NewWriter(os.Stdout)
	tw.SetHeader([]string{"Name", "Created"})
	tw.SetBorder(false)
	tw.SetColumnSeparator("  ")
	tw.SetHeaderLine(false)
	tw.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	tw.SetAlignment(tablewriter.ALIGN_LEFT)

	for _, item := range list.Items {
		created := strings.TrimSuffix(item.Metadata.CreationTimestamp, "Z")
		tw.Append([]string{item.Metadata.Name, created})
	}
	tw.Render()
	return nil
}

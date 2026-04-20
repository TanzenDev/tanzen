package cmd

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var verifyCmd = &cobra.Command{
	Use:   "verify",
	Short: "Compare live cluster against the Helm chart (requires helm-diff plugin)",
	Long: `tanzenctl verify runs 'helm diff upgrade' to detect config drift between
the installed release and the local chart + values.

Exits non-zero if differences are found, making it suitable for CI.`,
	RunE: runVerify,
}

func init() {
	rootCmd.AddCommand(verifyCmd)
}

func runVerify(_ *cobra.Command, _ []string) error {
	// Check helm-diff plugin is available
	out, _ := runCmdOutput("helm", "plugin", "list")
	if !strings.Contains(out, "diff") {
		fmt.Println("helm-diff plugin not found. Install it with:")
		fmt.Println("  helm plugin install https://github.com/databus23/helm-diff")
		return fmt.Errorf("helm-diff plugin required")
	}

	root := repoRoot()
	chartDir := filepath.Join(root, "infra", "charts", "tanzen")
	valuesFile := filepath.Join(chartDir, "values.yaml")

	step("Running helm diff")
	diff, err := runCmdOutput("helm", "diff", "upgrade", "tanzen", chartDir,
		"-n", namespace, "-f", valuesFile, "--color")

	if diff == "" && err == nil {
		success("Cluster matches chart — nothing to apply")
		return nil
	}

	fmt.Println(diff)
	if err != nil {
		return fmt.Errorf("drift detected (exit %w)", err)
	}
	return fmt.Errorf("drift detected")
}

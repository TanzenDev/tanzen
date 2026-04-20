package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"
)

var installValuesFile string

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Install or upgrade the tanzen Helm chart (no cluster creation)",
	Long: `tanzenctl install runs helm upgrade --install against an existing cluster.

Use this after chart or values changes to apply updates without recreating the cluster.`,
	RunE: runInstall,
}

func init() {
	installCmd.Flags().StringVarP(&installValuesFile, "values", "f", "", "Additional values file (merged on top of defaults)")
	rootCmd.AddCommand(installCmd)
}

func runInstall(_ *cobra.Command, _ []string) error {
	root := repoRoot()
	chartDir := filepath.Join(root, "infra", "charts", "tanzen")
	valuesFile := filepath.Join(chartDir, "values.yaml")

	step("Running helm dependency update")
	if err := runCmd("helm", "dependency", "update", chartDir); err != nil {
		return fmt.Errorf("helm dependency update: %w", err)
	}

	step("Installing/upgrading tanzen Helm chart")
	args := []string{
		"upgrade", "--install", "tanzen", chartDir,
		"-n", namespace,
		"-f", valuesFile,
		"--wait", "--timeout", "10m",
	}
	if installValuesFile != "" {
		args = append(args, "-f", installValuesFile)
	}
	if err := runCmd("helm", args...); err != nil {
		return fmt.Errorf("helm upgrade tanzen: %w", err)
	}
	success("Tanzen chart installed/upgraded")
	return nil
}

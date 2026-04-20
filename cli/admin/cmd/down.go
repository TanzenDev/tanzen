package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var downYes bool

var downCmd = &cobra.Command{
	Use:   "down",
	Short: "Delete the Kind cluster",
	Long:  `tanzenctl down deletes the Kind cluster and all data within it.`,
	RunE:  runDown,
}

func init() {
	downCmd.Flags().BoolVar(&downYes, "yes", false, "Skip confirmation prompt")
	rootCmd.AddCommand(downCmd)
}

func runDown(_ *cobra.Command, _ []string) error {
	if !downYes {
		fmt.Printf("Delete Kind cluster %q? This destroys all data. Run with --yes to confirm.\n", clusterName)
		return nil
	}
	step("Deleting Kind cluster")
	if err := runCmd("kind", "delete", "cluster", "--name", clusterName); err != nil {
		return fmt.Errorf("kind delete cluster: %w", err)
	}
	success("Cluster deleted")
	return nil
}

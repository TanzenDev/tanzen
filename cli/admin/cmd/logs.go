package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	logsFollow bool
	logsTail   int
)

// componentLabels maps friendly shorthands to kubectl label selectors.
var componentLabels = map[string]string{
	"worker":    "app.kubernetes.io/name=tanzen-worker",
	"temporal":  "app.kubernetes.io/name=temporal",
	"postgres":  "cnpg.io/cluster=tanzen-postgres",
	"redis":     "app.kubernetes.io/name=redis",
	"seaweedfs": "app.kubernetes.io/name=seaweedfs-filer",
	"grafana":   "app.kubernetes.io/name=grafana",
}

var logsCmd = &cobra.Command{
	Use:       "logs <component>",
	Short:     "Stream logs from a Tanzen component",
	Long:      "Valid components: worker, temporal, postgres, redis, seaweedfs, grafana",
	Args:      cobra.ExactArgs(1),
	ValidArgs: []string{"worker", "temporal", "postgres", "redis", "seaweedfs", "grafana"},
	RunE:      runLogs,
}

func init() {
	logsCmd.Flags().BoolVarP(&logsFollow, "follow", "f", false, "Follow log output")
	logsCmd.Flags().IntVar(&logsTail, "tail", 100, "Number of recent lines to show")
	rootCmd.AddCommand(logsCmd)
}

func runLogs(_ *cobra.Command, args []string) error {
	component := args[0]
	selector, ok := componentLabels[component]
	if !ok {
		return fmt.Errorf("unknown component %q. Valid: worker, temporal, postgres, redis, seaweedfs, grafana", component)
	}

	cmdArgs := []string{"logs", "-n", namespace, "-l", selector,
		fmt.Sprintf("--tail=%d", logsTail)}
	if logsFollow {
		cmdArgs = append(cmdArgs, "-f")
	}
	return runCmd("kubectl", cmdArgs...)
}

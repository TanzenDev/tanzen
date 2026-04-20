package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var (
	clusterName string
	namespace   string
	kubeconfig  string
	dryRun      bool
	repoRootDir string
)

var rootCmd = &cobra.Command{
	Use:   "tanzenctl",
	Short: "Tanzen infrastructure management CLI",
	Long: `tanzenctl manages the Tanzen dev environment on a local Kind cluster.

It mirrors infra/scripts/bootstrap.sh with structured output and error recovery.`,
}

func Execute() error {
	discoverPlugins(rootCmd)
	return rootCmd.Execute()
}

// discoverPlugins scans PATH for binaries named "tanzenctl-*" and registers
// each as a sub-command that forwards all arguments to the binary.
// This mirrors the kubectl plugin model so commercial builds can ship
// additional commands (tanzenctl-sso, tanzenctl-audit, etc.) independently.
func discoverPlugins(root *cobra.Command) {
	seen := map[string]bool{}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "tanzenctl-") {
				continue
			}
			pluginName := strings.TrimPrefix(e.Name(), "tanzenctl-")
			if seen[pluginName] {
				continue // first match in PATH wins
			}
			seen[pluginName] = true

			binaryPath := filepath.Join(dir, e.Name())
			cmd := &cobra.Command{
				Use:                pluginName,
				Short:              fmt.Sprintf("Plugin: %s", e.Name()),
				DisableFlagParsing: true,
				RunE: func(cmd *cobra.Command, args []string) error {
					c := exec.Command(binaryPath, args...)
					c.Stdin = os.Stdin
					c.Stdout = os.Stdout
					c.Stderr = os.Stderr
					return c.Run()
				},
			}
			root.AddCommand(cmd)
		}
	}
}

func init() {
	rootCmd.PersistentFlags().StringVar(&clusterName, "cluster", "tanzen", "Kind cluster name")
	rootCmd.PersistentFlags().StringVar(&namespace, "namespace", "tanzen-dev", "Kubernetes namespace")
	rootCmd.PersistentFlags().StringVar(&kubeconfig, "kubeconfig", "", "Path to kubeconfig (default: ~/.kube/config)")
	rootCmd.PersistentFlags().BoolVar(&dryRun, "dry-run", false, "Print commands without executing")
	rootCmd.PersistentFlags().StringVar(&repoRootDir, "root", "", "Conduit repo root (default: $TANZEN_ROOT or cwd)")
}

// repoRoot resolves the conduit repository root.
func repoRoot() string {
	if repoRootDir != "" {
		return repoRootDir
	}
	if v := os.Getenv("TANZEN_ROOT"); v != "" {
		return v
	}
	// Walk up from cwd looking for infra/charts/tanzen
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "infra", "charts", "tanzen")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return cwd
}

// step prints a bold step header.
func step(msg string) {
	fmt.Fprintln(os.Stdout, color.New(color.Bold, color.FgCyan).Sprint("==> ")+msg)
}

// success prints a green success message.
func success(msg string) {
	fmt.Fprintln(os.Stdout, color.GreenString("✓ ")+msg)
}

// warn prints a yellow warning.
func warn(msg string) {
	fmt.Fprintln(os.Stderr, color.YellowString("⚠ ")+msg)
}

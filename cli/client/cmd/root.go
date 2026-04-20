package cmd

import (
	"context"
	"fmt"
	"os"

	"tanzen/internal/api"
	"tanzen/internal/config"

	"github.com/spf13/cobra"
)

var (
	outputFormat string
	quiet        bool
)

var rootCmd = &cobra.Command{
	Use:   "tanzen",
	Short: "Tanzen API client CLI",
	Long: `tanzen is the command-line interface for the Tanzen workflow platform.

Configure the server URL and auth token:
  tanzen config set-url http://localhost:3002
  tanzen config set-token <jwt>

Environment overrides: TANZEN_URL, TANZEN_TOKEN`,
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.PersistentFlags().StringVarP(&outputFormat, "output", "o", "table", "Output format: table or json")
	rootCmd.PersistentFlags().BoolVarP(&quiet, "quiet", "q", false, "Print only IDs (useful for scripting)")
}

// newClient loads config and returns an API client.
func newClient() (*api.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	return api.New(cfg.URL, cfg.Token), nil
}

// ctx returns a background context (placeholder for future cancellation).
func ctx() context.Context {
	return context.Background()
}

// fatalf prints an error to stderr and exits.
func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}

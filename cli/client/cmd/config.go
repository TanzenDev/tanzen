package cmd

import (
	"fmt"

	"tanzen/internal/config"
	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage CLI configuration (~/.tanzen/config.yaml)",
}

var configSetURLCmd = &cobra.Command{
	Use:   "set-url <url>",
	Short: "Set the Tanzen API base URL",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		cfg.URL = args[0]
		if err := config.Save(cfg); err != nil {
			return err
		}
		fmt.Printf("URL set to %s\n", cfg.URL)
		return nil
	},
}

var configSetTokenCmd = &cobra.Command{
	Use:   "set-token <token>",
	Short: "Set the Bearer auth token",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		cfg.Token = args[0]
		if err := config.Save(cfg); err != nil {
			return err
		}
		fmt.Println("Token saved")
		return nil
	},
}

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show current configuration",
	RunE: func(_ *cobra.Command, _ []string) error {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(cfg)
		}
		tw := output.Table([]string{"Key", "Value"})
		token := cfg.Token
		if len(token) > 12 {
			token = token[:12] + "…"
		}
		if token == "" {
			token = "(none — dev mode)"
		}
		tw.Append([]string{"url", cfg.URL})
		tw.Append([]string{"token", token})
		tw.Render()
		return nil
	},
}

func init() {
	configCmd.AddCommand(configSetURLCmd, configSetTokenCmd, configShowCmd)
	rootCmd.AddCommand(configCmd)
}

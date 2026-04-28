package cmd

import (
	"fmt"
	"os"

	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var bundleCmd = &cobra.Command{
	Use:   "bundle",
	Short: "Deploy and export .tanzen bundle files",
	Long: `Bundles are portable .tanzen files that declare agents, scripts, and
workflows together. A bundle can be deployed to any cluster and
exported from any existing workflow.`,
}

// ── deploy ────────────────────────────────────────────────────────────────────

var bundleDeployCmd = &cobra.Command{
	Use:   "deploy <file.tanzen>",
	Short: "Deploy a bundle file (upserts agents, scripts, and workflows)",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		data, err := os.ReadFile(args[0])
		if err != nil {
			return fmt.Errorf("read %s: %w", args[0], err)
		}

		client, err := newClient()
		if err != nil {
			return err
		}

		result, err := client.DeployBundle(ctx(), string(data))
		if err != nil {
			return err
		}

		if outputFormat == "json" {
			return output.JSON(result)
		}

		total := len(result.Agents) + len(result.Scripts) + len(result.Workflows)
		fmt.Printf("Deployed bundle (%d %s):\n", total, plural(total, "entity", "entities"))

		if len(result.Agents) > 0 {
			tw := output.Table([]string{"Kind", "Name", "Version", "Status"})
			for _, a := range result.Agents {
				tw.Append([]string{"agent", a.Name, a.Version, deployStatus(a.Created)})
			}
			tw.Render()
		}
		if len(result.Scripts) > 0 {
			tw := output.Table([]string{"Kind", "Name", "Version", "Status"})
			for _, s := range result.Scripts {
				tw.Append([]string{"script", s.Name, s.Version, deployStatus(s.Created)})
			}
			tw.Render()
		}
		if len(result.Workflows) > 0 {
			tw := output.Table([]string{"Kind", "Name", "Version", "Status"})
			for _, w := range result.Workflows {
				tw.Append([]string{"workflow", w.Name, w.Version, deployStatus(w.Created)})
			}
			tw.Render()
		}
		return nil
	},
}

// ── export ────────────────────────────────────────────────────────────────────

var bundleExportFile string

var bundleExportCmd = &cobra.Command{
	Use:   "export <workflow-id>",
	Short: "Export a workflow and its agent/script dependencies as a .tanzen bundle",
	Long: `Reconstructs a self-contained .tanzen bundle file from a deployed workflow.
The bundle includes all referenced agents and scripts and can be shared
with any Tanzen user via tanzen bundle deploy.`,
	Args: cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}

		dsl, err := client.ExportBundle(ctx(), args[0])
		if err != nil {
			return err
		}

		if bundleExportFile != "" {
			if err := os.WriteFile(bundleExportFile, []byte(dsl), 0644); err != nil {
				return fmt.Errorf("write %s: %w", bundleExportFile, err)
			}
			fmt.Printf("Bundle written to %s\n", bundleExportFile)
			return nil
		}

		fmt.Print(dsl)
		return nil
	},
}

// ── helpers ───────────────────────────────────────────────────────────────────

func deployStatus(created bool) string {
	if created {
		return "created"
	}
	return "updated"
}

func plural(n int, singular, pluralForm string) string {
	if n == 1 {
		return singular
	}
	return pluralForm
}

func init() {
	bundleExportCmd.Flags().StringVar(&bundleExportFile, "file", "", "Write bundle DSL to this file instead of stdout")

	bundleCmd.AddCommand(bundleDeployCmd, bundleExportCmd)
	rootCmd.AddCommand(bundleCmd)
}

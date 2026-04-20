package cmd

import (
	"fmt"

	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Manage MCP servers",
}

var mcpListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available MCP servers discovered from the cluster",
	RunE: func(cmd *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListMCPServers(ctx())
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		if quiet {
			for _, s := range list.Items {
				fmt.Println(s.URL)
			}
			return nil
		}
		tw := output.Table([]string{"Name", "URL", "Description", "Transport"})
		for _, s := range list.Items {
			tw.Append([]string{s.Name, s.URL, s.Description, s.Transport})
		}
		tw.Render()
		return nil
	},
}

func init() {
	mcpCmd.AddCommand(mcpListCmd)
	rootCmd.AddCommand(mcpCmd)
}

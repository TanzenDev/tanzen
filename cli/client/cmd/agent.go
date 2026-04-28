package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"tanzen/internal/api"
	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var agentCmd = &cobra.Command{
	Use:   "agent",
	Short: "Manage agents",
}

// ── list ──────────────────────────────────────────────────────────────────────

var agentListLimit int

var agentListCmd = &cobra.Command{
	Use:   "list",
	Short: "List agents",
	RunE: func(cmd *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListAgents(ctx(), agentListLimit)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		if quiet {
			for _, a := range list.Items {
				fmt.Println(a.ID)
			}
			return nil
		}
		tw := output.Table([]string{"ID", "Name", "Model", "Version", "Created"})
		for _, a := range list.Items {
			tw.Append([]string{
				a.ID[:8],
				a.Name,
				a.Model,
				a.CurrentVersion,
				output.Rel(output.ParseTime(a.CreatedAt)),
			})
		}
		tw.Render()
		return nil
	},
}

// ── get ───────────────────────────────────────────────────────────────────────

var agentGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get agent detail",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		agent, err := client.GetAgent(ctx(), args[0])
		if err != nil {
			return err
		}
		return output.JSON(agent)
	},
}

// ── create ────────────────────────────────────────────────────────────────────

var (
	agentCreateName        string
	agentCreateModel       string
	agentCreatePrompt      string
	agentCreateMaxTokens   int
	agentCreateTemperature float64
	agentCreateRetries     int
	agentCreateSecrets     []string
	agentCreateMCPServers  []string
)

var agentCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new agent",
	RunE: func(_ *cobra.Command, _ []string) error {
		if agentCreateName == "" || agentCreateModel == "" || agentCreatePrompt == "" {
			return fmt.Errorf("--name, --model, and --system-prompt are required")
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		var mcpRefs []api.MCPServerRef
		for _, u := range agentCreateMCPServers {
			mcpRefs = append(mcpRefs, api.MCPServerRef{URL: u})
		}
		body := api.AgentCreateBody{
			Name:         agentCreateName,
			Model:        agentCreateModel,
			SystemPrompt: agentCreatePrompt,
			MCPServers:   mcpRefs,
			Secrets:      agentCreateSecrets,
		}
		if agentCreateMaxTokens > 0 {
			body.MaxTokens = &agentCreateMaxTokens
		}
		if agentCreateTemperature >= 0 {
			body.Temperature = &agentCreateTemperature
		}
		if agentCreateRetries > 0 {
			body.Retries = &agentCreateRetries
		}
		result, err := client.CreateAgent(ctx(), body)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Created agent %s (version %s)\n", result["id"], result["version"])
		return nil
	},
}

// ── update ────────────────────────────────────────────────────────────────────

var (
	agentUpdateModel       string
	agentUpdatePrompt      string
	agentUpdateMaxTokens   int
	agentUpdateTemperature float64
	agentUpdateRetries     int
	agentUpdateSecrets     []string
	agentUpdateMCPServers  []string
)

var agentUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Update an agent (creates a new version)",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		var mcpUpdateRefs []api.MCPServerRef
		for _, u := range agentUpdateMCPServers {
			mcpUpdateRefs = append(mcpUpdateRefs, api.MCPServerRef{URL: u})
		}
		body := api.AgentUpdateBody{
			Model:        agentUpdateModel,
			SystemPrompt: agentUpdatePrompt,
			MCPServers:   mcpUpdateRefs,
			Secrets:      agentUpdateSecrets,
		}
		if agentUpdateMaxTokens > 0 {
			body.MaxTokens = &agentUpdateMaxTokens
		}
		if agentUpdateTemperature >= 0 {
			body.Temperature = &agentUpdateTemperature
		}
		if agentUpdateRetries > 0 {
			body.Retries = &agentUpdateRetries
		}
		result, err := client.UpdateAgent(ctx(), args[0], body)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Updated agent %s → version %s\n", result["id"], result["version"])
		return nil
	},
}

// ── promote ───────────────────────────────────────────────────────────────────

var agentPromoteCmd = &cobra.Command{
	Use:   "promote <id>",
	Short: "Promote the current agent version",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.PromoteAgent(ctx(), args[0])
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Agent %s version %s promoted\n", result["id"], result["version"])
		return nil
	},
}

// ── delete ────────────────────────────────────────────────────────────────────

var agentDeleteYes bool

var agentDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete an agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		if !agentDeleteYes {
			fmt.Printf("Delete agent %s? Run with --yes to confirm.\n", args[0])
			return nil
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		if err := client.DeleteAgent(ctx(), args[0]); err != nil {
			return err
		}
		fmt.Printf("Agent %s deleted\n", args[0])
		return nil
	},
}

// ── models ────────────────────────────────────────────────────────────────────

var allowedModels = []string{
	"openai:gpt-4o", "openai:gpt-4o-mini", "openai:gpt-4-turbo",
	"anthropic:claude-opus-4-7", "anthropic:claude-opus-4-6",
	"anthropic:claude-sonnet-4-6",
	"anthropic:claude-haiku-4-5", "anthropic:claude-haiku-4-5-20251001",
	"google:gemini-1.5-pro", "google:gemini-1.5-flash",
	"groq:llama-3.3-70b-versatile", "groq:llama-3.1-8b-instant", "groq:mixtral-8x7b-32768",
	"test",
}

var agentModelsCmd = &cobra.Command{
	Use:   "models",
	Short: "List allowed model identifiers",
	RunE: func(_ *cobra.Command, _ []string) error {
		for i, m := range allowedModels {
			fmt.Printf("  %s%s\n", strings.Repeat(" ", len(strconv.Itoa(i+1))-1), m)
		}
		return nil
	},
}

func init() {
	agentListCmd.Flags().IntVar(&agentListLimit, "limit", 50, "Max results")

	agentCreateCmd.Flags().StringVar(&agentCreateName, "name", "", "Agent name (required)")
	agentCreateCmd.Flags().StringVar(&agentCreateModel, "model", "", "Model identifier (required)")
	agentCreateCmd.Flags().StringVar(&agentCreatePrompt, "system-prompt", "", "System prompt (required)")
	agentCreateCmd.Flags().IntVar(&agentCreateMaxTokens, "max-tokens", 0, "Max tokens (default: 4096)")
	agentCreateCmd.Flags().Float64Var(&agentCreateTemperature, "temperature", -1, "Temperature 0.0–2.0 (default: 0.1)")
	agentCreateCmd.Flags().IntVar(&agentCreateRetries, "retries", 0, "Retry count (default: 1)")
	agentCreateCmd.Flags().StringSliceVar(&agentCreateSecrets, "secret", nil, "Secret env var names to inject (repeatable)")
	agentCreateCmd.Flags().StringArrayVar(&agentCreateMCPServers, "mcp-server", nil, "MCP server URL to attach (repeatable)")

	agentUpdateCmd.Flags().StringVar(&agentUpdateModel, "model", "", "New model identifier")
	agentUpdateCmd.Flags().StringVar(&agentUpdatePrompt, "system-prompt", "", "New system prompt")
	agentUpdateCmd.Flags().IntVar(&agentUpdateMaxTokens, "max-tokens", 0, "New max tokens")
	agentUpdateCmd.Flags().Float64Var(&agentUpdateTemperature, "temperature", -1, "New temperature")
	agentUpdateCmd.Flags().IntVar(&agentUpdateRetries, "retries", 0, "New retry count")
	agentUpdateCmd.Flags().StringSliceVar(&agentUpdateSecrets, "secret", nil, "New secret env var names")
	agentUpdateCmd.Flags().StringArrayVar(&agentUpdateMCPServers, "mcp-server", nil, "MCP server URL to attach (repeatable)")

	agentDeleteCmd.Flags().BoolVar(&agentDeleteYes, "yes", false, "Skip confirmation")

	agentCmd.AddCommand(agentListCmd, agentGetCmd, agentCreateCmd, agentUpdateCmd,
		agentPromoteCmd, agentDeleteCmd, agentModelsCmd)
	rootCmd.AddCommand(agentCmd)
}

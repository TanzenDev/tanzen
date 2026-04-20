package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"tanzen/internal/api"
	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var workflowCmd = &cobra.Command{
	Use:   "workflow",
	Short: "Manage workflows",
}

// ── list ──────────────────────────────────────────────────────────────────────

var workflowListLimit int

var workflowListCmd = &cobra.Command{
	Use:   "list",
	Short: "List workflows",
	RunE: func(_ *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListWorkflows(ctx(), workflowListLimit)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		if quiet {
			for _, w := range list.Items {
				fmt.Println(w.ID)
			}
			return nil
		}
		tw := output.Table([]string{"ID", "Name", "Version", "Created By", "Created"})
		for _, w := range list.Items {
			tw.Append([]string{
				w.ID[:8],
				w.Name,
				w.CurrentVersion,
				w.CreatedBy,
				output.Rel(output.ParseTime(w.CreatedAt)),
			})
		}
		tw.Render()
		return nil
	},
}

// ── get ───────────────────────────────────────────────────────────────────────

var workflowGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get workflow detail",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		wf, err := client.GetWorkflow(ctx(), args[0])
		if err != nil {
			return err
		}
		return output.JSON(wf)
	},
}

// ── create ────────────────────────────────────────────────────────────────────

var (
	workflowCreateName    string
	workflowCreateDSLFile string
)

var workflowCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a workflow from a DSL file",
	RunE: func(_ *cobra.Command, _ []string) error {
		if workflowCreateName == "" {
			return fmt.Errorf("--name is required")
		}
		dsl, err := readDSLFile(workflowCreateDSLFile)
		if err != nil {
			return err
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.CreateWorkflow(ctx(), api.WorkflowCreateBody{
			Name: workflowCreateName,
			DSL:  dsl,
		})
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Created workflow %s (id: %s, version: %s)\n",
			result["name"], result["id"], result["version"])
		return nil
	},
}

// ── compile ───────────────────────────────────────────────────────────────────

var workflowCompileDSLFile string

var workflowCompileCmd = &cobra.Command{
	Use:   "compile <id>",
	Short: "Validate and compile a DSL against an existing workflow",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		dsl, err := readDSLFile(workflowCompileDSLFile)
		if err != nil {
			return err
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.CompileWorkflow(ctx(), args[0], dsl)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		if result.Valid {
			fmt.Println("✓ DSL is valid")
		} else {
			fmt.Fprintln(os.Stderr, "✗ Compile error: "+result.Error)
			os.Exit(1)
		}
		return nil
	},
}

// ── run ───────────────────────────────────────────────────────────────────────

var (
	workflowRunParams     string
	workflowRunParamsFile string
	workflowRunWatch      bool
)

var workflowRunCmd = &cobra.Command{
	Use:   "run <id>",
	Short: "Start a run for a workflow",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		params, err := resolveParams(workflowRunParams, workflowRunParamsFile)
		if err != nil {
			return err
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.StartRun(ctx(), args[0], params)
		if err != nil {
			return err
		}
		runID, _ := result["runId"].(string)
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Started run %s\n", runID)
		if workflowRunWatch && runID != "" {
			return streamEvents(client, runID)
		}
		return nil
	},
}

// ── runs ──────────────────────────────────────────────────────────────────────

var workflowRunsLimit int

var workflowRunsCmd = &cobra.Command{
	Use:   "runs <id>",
	Short: "List runs for a workflow",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListWorkflowRuns(ctx(), args[0], workflowRunsLimit)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		printRunList(list.Items)
		return nil
	},
}

// ── promote ───────────────────────────────────────────────────────────────────

var workflowPromoteCmd = &cobra.Command{
	Use:   "promote <id>",
	Short: "Promote the current workflow version",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.PromoteWorkflow(ctx(), args[0])
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Workflow %s version %s promoted\n", result["id"], result["version"])
		return nil
	},
}

// ── delete ────────────────────────────────────────────────────────────────────

var workflowDeleteYes bool

var workflowDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a workflow and all its runs",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		if !workflowDeleteYes {
			fmt.Printf("Delete workflow %s and all its runs? Run with --yes to confirm.\n", args[0])
			return nil
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		if err := client.DeleteWorkflow(ctx(), args[0]); err != nil {
			return err
		}
		fmt.Printf("Workflow %s deleted\n", args[0])
		return nil
	},
}

// ── helpers ───────────────────────────────────────────────────────────────────

func readDSLFile(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("--dsl-file is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read DSL file: %w", err)
	}
	return string(data), nil
}

func resolveParams(inline, file string) (map[string]any, error) {
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read params file: %w", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			return nil, fmt.Errorf("parse params file: %w", err)
		}
		return m, nil
	}
	if inline != "" {
		var m map[string]any
		if err := json.Unmarshal([]byte(inline), &m); err != nil {
			return nil, fmt.Errorf("parse --params: %w", err)
		}
		return m, nil
	}
	return nil, nil
}

func init() {
	workflowListCmd.Flags().IntVar(&workflowListLimit, "limit", 50, "Max results")
	workflowCreateCmd.Flags().StringVar(&workflowCreateName, "name", "", "Workflow name (required)")
	workflowCreateCmd.Flags().StringVar(&workflowCreateDSLFile, "dsl-file", "", "Path to DSL file (required)")
	workflowCompileCmd.Flags().StringVar(&workflowCompileDSLFile, "dsl-file", "", "Path to DSL file (required)")
	workflowRunCmd.Flags().StringVar(&workflowRunParams, "params", "", "JSON params object")
	workflowRunCmd.Flags().StringVar(&workflowRunParamsFile, "params-file", "", "Path to JSON params file")
	workflowRunCmd.Flags().BoolVar(&workflowRunWatch, "watch", false, "Stream run events after starting")
	workflowRunsCmd.Flags().IntVar(&workflowRunsLimit, "limit", 50, "Max results")
	workflowDeleteCmd.Flags().BoolVar(&workflowDeleteYes, "yes", false, "Skip confirmation")

	workflowCmd.AddCommand(
		workflowListCmd, workflowGetCmd, workflowCreateCmd, workflowCompileCmd,
		workflowRunCmd, workflowRunsCmd, workflowPromoteCmd, workflowDeleteCmd,
	)
	rootCmd.AddCommand(workflowCmd)
}

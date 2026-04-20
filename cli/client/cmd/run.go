package cmd

import (
	"fmt"
	"os"
	"time"

	"tanzen/internal/api"
	"tanzen/internal/output"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Manage and observe runs",
}

// ── list ──────────────────────────────────────────────────────────────────────

var (
	runListStatus string
	runListLimit  int
)

var runListCmd = &cobra.Command{
	Use:   "list",
	Short: "List runs",
	RunE: func(_ *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListRuns(ctx(), runListStatus, runListLimit)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		if quiet {
			for _, r := range list.Items {
				fmt.Println(r.ID)
			}
			return nil
		}
		printRunList(list.Items)
		return nil
	},
}

// ── get ───────────────────────────────────────────────────────────────────────

var runGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get run detail including steps and events",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		detail, err := client.GetRun(ctx(), args[0])
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(detail)
		}

		// Header
		statusColor := colorStatus(detail.Status)
		fmt.Printf("Run     %s\n", detail.ID)
		fmt.Printf("Status  %s\n", statusColor)
		fmt.Printf("Started %s\n", output.Rel(output.ParseTime(detail.StartedAt)))
		if detail.CompletedAt != "" {
			fmt.Printf("Ended   %s\n", output.Rel(output.ParseTime(detail.CompletedAt)))
		}
		if detail.Error != "" {
			fmt.Fprintf(os.Stderr, "Error   %s\n", color.RedString(detail.Error))
		}

		// Steps
		if len(detail.Steps) > 0 {
			fmt.Println()
			tw := output.Table([]string{"Step", "Type", "Status", "Tokens", "Duration"})
			for _, s := range detail.Steps {
				dur := "—"
				if s.DurationMs > 0 {
					dur = output.Duration(s.DurationMs / 1000)
				}
				tok := "—"
				if s.TokenCount > 0 {
					tok = fmt.Sprintf("%d", s.TokenCount)
				}
				tw.Append([]string{
					s.StepID,
					s.StepType,
					colorStatus(s.Status),
					tok,
					dur,
				})
			}
			tw.Render()
		}
		return nil
	},
}

// ── watch ─────────────────────────────────────────────────────────────────────

var runWatchCmd = &cobra.Command{
	Use:   "watch <id>",
	Short: "Stream live events for a run until it completes",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		return streamEvents(client, args[0])
	},
}

// ── delete ────────────────────────────────────────────────────────────────────

var runDeleteYes bool

var runDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a run",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		if !runDeleteYes {
			fmt.Printf("Delete run %s? Run with --yes to confirm.\n", args[0])
			return nil
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		if err := client.DeleteRun(ctx(), args[0]); err != nil {
			return err
		}
		fmt.Printf("Run %s deleted\n", args[0])
		return nil
	},
}

// ── shared helpers ────────────────────────────────────────────────────────────

// printRunList renders runs as a table. Shared by run list and workflow runs.
func printRunList(items []api.Run) {
	if len(items) == 0 {
		fmt.Println("No runs found.")
		return
	}
	tw := output.Table([]string{"ID", "Workflow", "Version", "Status", "Started"})
	for _, r := range items {
		wfID := r.WorkflowID
		if len(wfID) > 8 {
			wfID = wfID[:8]
		}
		// Show enough to distinguish; use -q for full IDs.
		id := r.ID
		if len(id) > 36 {
			id = id[:36] + "…"
		}
		tw.Append([]string{
			id,
			wfID,
			"v" + r.WorkflowVersion,
			colorStatus(r.Status),
			output.Rel(output.ParseTime(r.StartedAt)),
		})
	}
	tw.Render()
	fmt.Println("(use -q for full IDs)")
}

// streamEvents connects to the SSE endpoint and prints events as they arrive.
func streamEvents(client *api.Client, runID string) error {
	fmt.Printf("Watching run %s\n\n", runID)
	var finalStatus string
	err := client.StreamRunEvents(ctx(), runID, func(ev api.RunEvent) {
		ts := time.Unix(int64(ev.Ts), 0).Format("15:04:05")
		stepID := ""
		if ev.StepID != nil {
			stepID = *ev.StepID
		}
		extra := ""
		switch ev.EventType {
		case "step_completed":
			if tok, ok := ev.Data["token_count"]; ok {
				extra = fmt.Sprintf(" (%v tok)", tok)
			}
		case "step_failed":
			if e, ok := ev.Data["error"]; ok {
				extra = color.RedString(" error: %v", e)
			}
		}
		fmt.Printf("[%s] %-20s %-20s%s\n", ts, ev.EventType, stepID, extra)

		switch ev.EventType {
		case "run_completed":
			finalStatus = "succeeded"
		case "run_failed":
			finalStatus = "failed"
		}
	})
	if err != nil {
		return err
	}
	fmt.Println()
	if finalStatus != "" {
		fmt.Printf("Status: %s\n", colorStatus(finalStatus))
	}
	return nil
}

// colorStatus applies terminal color to a status string.
func colorStatus(s string) string {
	switch s {
	case "succeeded":
		return color.GreenString(s)
	case "failed":
		return color.RedString(s)
	case "running":
		return color.CyanString(s)
	case "awaiting_gate":
		return color.YellowString(s)
	default:
		return s
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func init() {
	runListCmd.Flags().StringVar(&runListStatus, "status", "", "Filter by status: running, succeeded, failed, awaiting_gate")
	runListCmd.Flags().IntVar(&runListLimit, "limit", 50, "Max results")
	runDeleteCmd.Flags().BoolVar(&runDeleteYes, "yes", false, "Skip confirmation")

	runCmd.AddCommand(runListCmd, runGetCmd, runWatchCmd, runDeleteCmd)
	rootCmd.AddCommand(runCmd)
}

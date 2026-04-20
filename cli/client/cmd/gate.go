package cmd

import (
	"fmt"

	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var gateCmd = &cobra.Command{
	Use:   "gate",
	Short: "Manage human-review gates",
}

// ── list ──────────────────────────────────────────────────────────────────────

var gateListCmd = &cobra.Command{
	Use:   "list",
	Short: "List pending gates",
	RunE: func(_ *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListGates(ctx())
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		if quiet {
			for _, g := range list.Items {
				fmt.Println(g.ID)
			}
			return nil
		}
		if len(list.Items) == 0 {
			fmt.Println("No pending gates.")
			return nil
		}
		tw := output.Table([]string{"ID", "Run", "Step", "Assignee", "Opened"})
		for _, g := range list.Items {
			tw.Append([]string{
				g.ID[:8],
				g.RunID[:16],
				g.StepID,
				g.Assignee,
				output.Rel(output.ParseTime(g.OpenedAt)),
			})
		}
		tw.Render()
		return nil
	},
}

// ── approve ───────────────────────────────────────────────────────────────────

var gateApproveNotes string

var gateApproveCmd = &cobra.Command{
	Use:   "approve <gate-id>",
	Short: "Approve a pending gate",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.ApproveGate(ctx(), args[0], gateApproveNotes)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Gate %s approved\n", args[0])
		return nil
	},
}

// ── reject ────────────────────────────────────────────────────────────────────

var gateRejectNotes string

var gateRejectCmd = &cobra.Command{
	Use:   "reject <gate-id>",
	Short: "Reject a pending gate",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		result, err := client.RejectGate(ctx(), args[0], gateRejectNotes)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(result)
		}
		fmt.Printf("Gate %s rejected\n", args[0])
		return nil
	},
}

func init() {
	gateApproveCmd.Flags().StringVar(&gateApproveNotes, "notes", "", "Optional reviewer notes")
	gateRejectCmd.Flags().StringVar(&gateRejectNotes, "notes", "", "Optional reviewer notes")

	gateCmd.AddCommand(gateListCmd, gateApproveCmd, gateRejectCmd)
	rootCmd.AddCommand(gateCmd)
}

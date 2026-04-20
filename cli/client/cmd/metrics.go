package cmd

import (
	"fmt"

	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var (
	metricsWorkflow string
	metricsFrom     string
	metricsTo       string
)

var metricsCmd = &cobra.Command{
	Use:   "metrics",
	Short: "Show run and token metrics",
	RunE: func(_ *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		m, err := client.GetMetrics(ctx(), metricsWorkflow, metricsFrom, metricsTo)
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(m)
		}

		// Run summary
		fmt.Println("Run Summary")
		tw := output.Table([]string{"Total", "Succeeded", "Failed", "Running", "Avg Duration"})
		tw.Append([]string{
			fmt.Sprintf("%d", m.Summary.TotalRuns),
			fmt.Sprintf("%d", m.Summary.Succeeded),
			fmt.Sprintf("%d", m.Summary.Failed),
			fmt.Sprintf("%d", m.Summary.Running),
			output.Duration(m.Summary.AvgDurationS),
		})
		tw.Render()

		// By-workflow breakdown
		if len(m.ByWorkflow) > 0 {
			fmt.Println("\nBy Workflow")
			tw2 := output.Table([]string{"Workflow ID", "Runs", "Succeeded"})
			for _, wf := range m.ByWorkflow {
				id := wf.WorkflowID
				if len(id) > 8 {
					id = id[:8]
				}
				tw2.Append([]string{id, fmt.Sprintf("%d", wf.RunCount), fmt.Sprintf("%d", wf.Succeeded)})
			}
			tw2.Render()
		}

		// Token usage
		if len(m.TokenSummary) > 0 {
			fmt.Println("\nToken Usage")
			tw3 := output.Table([]string{"Agent", "Total Tokens", "Cost (USD)"})
			for _, t := range m.TokenSummary {
				tw3.Append([]string{
					t.AgentID,
					fmt.Sprintf("%d", t.TotalTokens),
					fmt.Sprintf("$%.4f", t.TotalCost),
				})
			}
			tw3.Render()
		}

		// Task metrics
		if len(m.TaskMetrics) > 0 {
			fmt.Println("\nTask Metrics")
			tw4 := output.Table([]string{"Action", "Calls", "Avg Duration", "Max Duration"})
			for _, t := range m.TaskMetrics {
				tw4.Append([]string{
					t.Action,
					fmt.Sprintf("%d", t.CallCount),
					output.Duration(t.AvgDurationMs / 1000),
					output.Duration(t.MaxDurationMs / 1000),
				})
			}
			tw4.Render()
		}

		fmt.Printf("\nPeriod: %s → %s\n", m.From, m.To)
		return nil
	},
}

func init() {
	metricsCmd.Flags().StringVar(&metricsWorkflow, "workflow", "", "Filter to a specific workflow ID")
	metricsCmd.Flags().StringVar(&metricsFrom, "from", "", "Start time (ISO 8601, default: 30 days ago)")
	metricsCmd.Flags().StringVar(&metricsTo, "to", "", "End time (ISO 8601, default: now)")
	rootCmd.AddCommand(metricsCmd)
}

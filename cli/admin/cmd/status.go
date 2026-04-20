package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show pod status in the tanzen-dev namespace",
	RunE:  runStatus,
}

func init() {
	rootCmd.AddCommand(statusCmd)
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
		Status struct {
			Phase             string `json:"phase"`
			ContainerStatuses []struct {
				Name         string `json:"name"`
				Ready        bool   `json:"ready"`
				RestartCount int    `json:"restartCount"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

func runStatus(_ *cobra.Command, _ []string) error {
	out, err := runCmdOutput("kubectl", "get", "pods", "-n", namespace, "-o", "json")
	if err != nil {
		return fmt.Errorf("kubectl get pods: %w\n%s", err, out)
	}

	var pl podList
	if err := json.Unmarshal([]byte(out), &pl); err != nil {
		return fmt.Errorf("parse pod list: %w", err)
	}

	tw := tablewriter.NewWriter(os.Stdout)
	tw.SetHeader([]string{"Component", "Pod", "Status", "Ready", "Restarts"})
	tw.SetBorder(false)
	tw.SetColumnSeparator("  ")
	tw.SetHeaderLine(false)
	tw.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	tw.SetAlignment(tablewriter.ALIGN_LEFT)

	for _, pod := range pl.Items {
		component := componentName(pod.Metadata.Name, pod.Metadata.Labels)
		phase := pod.Status.Phase

		ready := 0
		total := len(pod.Status.ContainerStatuses)
		restarts := 0
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
			restarts += cs.RestartCount
		}

		phaseColor := phase
		switch phase {
		case "Running":
			phaseColor = color.GreenString(phase)
		case "Pending":
			phaseColor = color.YellowString(phase)
		case "Failed", "CrashLoopBackOff":
			phaseColor = color.RedString(phase)
		}

		restartStr := fmt.Sprintf("%d", restarts)
		if restarts > 0 {
			restartStr = color.YellowString(restartStr)
		}

		// Truncate pod name for readability
		podName := pod.Metadata.Name
		if len(podName) > 40 {
			podName = podName[:37] + "…"
		}

		tw.Append([]string{
			component,
			podName,
			phaseColor,
			fmt.Sprintf("%d/%d", ready, total),
			restartStr,
		})
	}

	if len(pl.Items) == 0 {
		fmt.Printf("No pods found in namespace %s\n", namespace)
		return nil
	}

	tw.Render()
	return nil
}

// componentName derives a friendly component name from the pod name and labels.
func componentName(name string, labels map[string]string) string {
	// Check standard k8s labels first
	if app, ok := labels["app.kubernetes.io/name"]; ok {
		return app
	}
	if app, ok := labels["app"]; ok {
		return app
	}
	// Derive from pod name prefix (strip hash suffix)
	parts := strings.Split(name, "-")
	if len(parts) > 2 {
		return strings.Join(parts[:len(parts)-2], "-")
	}
	return name
}

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Manage MCP servers (build, deploy, test)",
}

func init() {
	rootCmd.AddCommand(mcpCmd)
	mcpCmd.AddCommand(mcpBuildCmd)
	mcpCmd.AddCommand(mcpStatusCmd)
	mcpCmd.AddCommand(mcpTestCmd)
}

// ── mcp build ───────────────────────────────────────────────────────────────

var mcpBuildCmd = &cobra.Command{
	Use:   "build [name|all]",
	Short: "Build MCP Docker images, load into Kind, and restart deployments",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runMCPBuild,
}

var mcpServers = []struct {
	name       string
	deployment string
}{
	{"sequential-thinking", "mcp-sequential-thinking"},
	{"fetch", "mcp-fetch"},
	{"falkordb", "mcp-falkordb"},
}

func runMCPBuild(_ *cobra.Command, args []string) error {
	if err := checkPrereqs("docker", "kind", "kubectl"); err != nil {
		return err
	}

	target := "all"
	if len(args) > 0 {
		target = args[0]
	}

	root := repoRoot()

	for _, srv := range mcpServers {
		if target != "all" && target != srv.name {
			continue
		}

		image := fmt.Sprintf("mcp-%s:latest", srv.name)
		dir := filepath.Join(root, "mcp", srv.name)

		step(fmt.Sprintf("Building %s", image))
		if err := runCmd("docker", "build", "-t", image, dir); err != nil {
			return fmt.Errorf("docker build %s: %w", srv.name, err)
		}
		success(fmt.Sprintf("Image built: %s", image))

		step(fmt.Sprintf("Loading %s into Kind cluster", image))
		if err := runCmd("kind", "load", "docker-image", image, "--name", clusterName); err != nil {
			return fmt.Errorf("kind load %s: %w", srv.name, err)
		}
		success("Loaded into cluster")

		step(fmt.Sprintf("Restarting %s deployment", srv.deployment))
		if err := runCmd("kubectl", "rollout", "restart", "deployment", srv.deployment, "-n", namespace); err != nil {
			// Deployment may not exist yet on first install — warn but continue
			fmt.Fprintf(os.Stderr, "warning: rollout restart %s: %v\n", srv.deployment, err)
			continue
		}
		if err := runCmd("kubectl", "rollout", "status", "deployment", srv.deployment, "-n", namespace, "--timeout=120s"); err != nil {
			return fmt.Errorf("rollout status %s: %w", srv.deployment, err)
		}
		success(fmt.Sprintf("%s ready", srv.deployment))
	}

	return nil
}

// ── mcp status ──────────────────────────────────────────────────────────────

var mcpStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show pod status for all MCP deployments",
	RunE:  runMCPStatus,
}

func runMCPStatus(_ *cobra.Command, _ []string) error {
	out, err := runCmdOutput("kubectl", "get", "pods", "-n", namespace,
		"-l", "tanzen/mcp=true", "-o", "json")
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

		ready, total, restarts := 0, len(pod.Status.ContainerStatuses), 0
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
			restarts += cs.RestartCount
		}

		phaseStr := phase
		switch phase {
		case "Running":
			phaseStr = color.GreenString(phase)
		case "Pending":
			phaseStr = color.YellowString(phase)
		case "Failed", "CrashLoopBackOff":
			phaseStr = color.RedString(phase)
		}

		restartStr := fmt.Sprintf("%d", restarts)
		if restarts > 0 {
			restartStr = color.YellowString(restartStr)
		}

		podName := pod.Metadata.Name
		if len(podName) > 40 {
			podName = podName[:37] + "…"
		}

		tw.Append([]string{
			component, podName, phaseStr,
			fmt.Sprintf("%d/%d", ready, total),
			restartStr,
		})
	}

	if len(pl.Items) == 0 {
		fmt.Printf("No MCP pods found in namespace %s\n", namespace)
		return nil
	}

	tw.Render()
	return nil
}

// ── mcp test ────────────────────────────────────────────────────────────────

var mcpTestCmd = &cobra.Command{
	Use:   "test [name|all]",
	Short: "Smoke-test MCP servers via JSON-RPC (initialize + tools/list)",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runMCPTest,
}

type mcpTestTarget struct {
	name          string
	url           string
	expectedTools []string
}

var mcpTestTargets = []mcpTestTarget{
	{
		name:          "sequential-thinking",
		url:           "http://localhost:8081/mcp",
		expectedTools: []string{"sequentialthinking"},
	},
	{
		name:          "fetch",
		url:           "http://localhost:8082/mcp",
		expectedTools: []string{"fetch", "fetch_html"},
	},
	{
		name:          "falkordb",
		url:           "http://localhost:8083/mcp",
		expectedTools: []string{"list_graphs", "query_graph", "write_graph", "delete_graph"},
	},
}

func runMCPTest(_ *cobra.Command, args []string) error {
	target := "all"
	if len(args) > 0 {
		target = args[0]
	}

	anyFailed := false
	for _, t := range mcpTestTargets {
		if target != "all" && target != t.name {
			continue
		}
		fmt.Printf("Testing %s at %s\n", color.CyanString(t.name), t.url)
		if err := testMCPServer(t); err != nil {
			fmt.Fprintf(os.Stderr, "  %s %s: %v\n", color.RedString("FAIL"), t.name, err)
			anyFailed = true
		} else {
			fmt.Printf("  %s %s\n", color.GreenString("PASS"), t.name)
		}
	}

	if anyFailed {
		return fmt.Errorf("one or more MCP servers failed the smoke test")
	}
	return nil
}

func testMCPServer(t mcpTestTarget) error {
	// initialize — capture mcp-session-id from response headers for session continuity
	initPayload := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"tanzenctl","version":"1.0"}}}`
	sessionID, initResp, err := mcpPostWithSession(t.url, "", initPayload)
	if err != nil {
		return fmt.Errorf("initialize failed: %w", err)
	}
	if _, ok := initResp["result"]; !ok {
		return fmt.Errorf("initialize: missing result field; got: %v", initResp)
	}

	// initialized notification (required before any other calls; may return empty body)
	notifyPayload := `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`
	_, _, _ = mcpPostWithSession(t.url, sessionID, notifyPayload)

	// tools/list
	listPayload := `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`
	_, listResp, err := mcpPostWithSession(t.url, sessionID, listPayload)
	if err != nil {
		return fmt.Errorf("tools/list failed: %w", err)
	}

	result, ok := listResp["result"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("tools/list: unexpected result shape: %v", listResp)
	}
	toolsRaw, ok := result["tools"].([]interface{})
	if !ok {
		return fmt.Errorf("tools/list: no tools array in result")
	}

	toolNames := map[string]bool{}
	for _, tr := range toolsRaw {
		if tm, ok := tr.(map[string]interface{}); ok {
			if n, ok := tm["name"].(string); ok {
				toolNames[n] = true
			}
		}
	}

	for _, expected := range t.expectedTools {
		if !toolNames[expected] {
			return fmt.Errorf("expected tool %q not found; got: %v", expected, toolNames)
		}
	}
	fmt.Printf("    tools: %v\n", keys(toolNames))
	return nil
}

// mcpPostWithSession sends a JSON-RPC request, optionally with a session ID header.
// Returns the session ID from the response (if any), the parsed JSON body, and any error.
func mcpPostWithSession(url, sessionID, body string) (string, map[string]interface{}, error) {
	args := []string{
		"-s", "-X", "POST", url,
		"-H", "Content-Type: application/json",
		"-H", "Accept: application/json, text/event-stream",
		"-D", "-", // dump response headers into stdout before body
		"-d", body,
		"--max-time", "10",
	}
	if sessionID != "" {
		args = append(args, "-H", "mcp-session-id: "+sessionID)
	}
	out, err := runCmdOutput("curl", args...)
	if err != nil {
		return "", nil, fmt.Errorf("curl: %w: %s", err, out)
	}

	// Split headers from body (separated by blank line)
	parts := strings.SplitN(out, "\r\n\r\n", 2)
	headerSection := ""
	bodySection := out
	if len(parts) == 2 {
		headerSection = parts[0]
		bodySection = parts[1]
	}

	// Extract mcp-session-id from response headers
	outSessionID := sessionID
	for _, line := range strings.Split(headerSection, "\r\n") {
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "mcp-session-id:") {
			outSessionID = strings.TrimSpace(line[len("mcp-session-id:"):])
			break
		}
	}

	// Extract JSON from SSE "data: {...}" lines if needed
	jsonBody := strings.TrimSpace(bodySection)
	for _, line := range strings.Split(bodySection, "\n") {
		if strings.HasPrefix(line, "data: ") {
			jsonBody = strings.TrimSpace(strings.TrimPrefix(line, "data: "))
			break
		}
	}

	if jsonBody == "" {
		// Notification responses may be empty — return empty map, no error
		return outSessionID, map[string]interface{}{}, nil
	}

	var resp map[string]interface{}
	if err := json.Unmarshal([]byte(jsonBody), &resp); err != nil {
		return outSessionID, nil, fmt.Errorf("parse response: %w; body: %s", err, bodySection)
	}
	return outSessionID, resp, nil
}

func keys(m map[string]bool) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

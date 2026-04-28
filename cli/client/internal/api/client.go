// Package api provides an HTTP client for the Tanzen server API.
package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is an authenticated HTTP client for the Tanzen API.
type Client struct {
	BaseURL    string
	Token      string
	httpClient *http.Client
}

// New creates an API client from base URL and optional Bearer token.
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+"/api"+path, r)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode >= 400 {
		var errBody struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &errBody) == nil && errBody.Error != "" {
			return nil, resp.StatusCode, fmt.Errorf("%s", errBody.Error)
		}
		return nil, resp.StatusCode, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(data))
	}
	return data, resp.StatusCode, nil
}

func decode[T any](data []byte) (T, error) {
	var v T
	err := json.Unmarshal(data, &v)
	return v, err
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Agent struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CurrentVersion string `json:"current_version"`
	Model          string `json:"model"`
	CreatedAt      string `json:"created_at"`
}

type AgentList struct {
	Items  []Agent `json:"items"`
	Limit  int     `json:"limit"`
	Offset int     `json:"offset"`
}

type AgentCreateBody struct {
	Name         string          `json:"name"`
	Model        string          `json:"model"`
	SystemPrompt string          `json:"system_prompt"`
	MCPServers   []MCPServerRef  `json:"mcp_servers,omitempty"`
	Secrets      []string        `json:"secrets,omitempty"`
	MaxTokens    *int            `json:"max_tokens,omitempty"`
	Temperature  *float64        `json:"temperature,omitempty"`
	Retries      *int            `json:"retries,omitempty"`
}

type MCPServerRef struct {
	URL string `json:"url"`
}

type AgentUpdateBody struct {
	Model        string          `json:"model,omitempty"`
	SystemPrompt string          `json:"system_prompt,omitempty"`
	MCPServers   []MCPServerRef  `json:"mcp_servers,omitempty"`
	Secrets      []string        `json:"secrets,omitempty"`
	MaxTokens    *int            `json:"max_tokens,omitempty"`
	Temperature  *float64        `json:"temperature,omitempty"`
	Retries      *int            `json:"retries,omitempty"`
}

type Workflow struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CurrentVersion string `json:"current_version"`
	CreatedAt      string `json:"created_at"`
	CreatedBy      string `json:"created_by"`
}

type WorkflowList struct {
	Items  []Workflow `json:"items"`
	Limit  int        `json:"limit"`
	Offset int        `json:"offset"`
}

type WorkflowCreateBody struct {
	Name string `json:"name"`
	DSL  string `json:"dsl"`
}

type CompileResult struct {
	Valid  bool   `json:"valid"`
	Error  string `json:"error,omitempty"`
	IR     any    `json:"ir,omitempty"`
}

type Run struct {
	ID                  string `json:"id"`
	WorkflowID          string `json:"workflow_id"`
	WorkflowVersion     string `json:"workflow_version"`
	Status              string `json:"status"`
	TriggeredBy         string `json:"triggered_by"`
	StartedAt           string `json:"started_at"`
	CompletedAt         string `json:"completed_at"`
	TemporalWorkflowID  string `json:"temporal_workflow_id"`
	Error               string `json:"error"`
}

type RunList struct {
	Items  []Run `json:"items"`
	Limit  int   `json:"limit"`
	Offset int   `json:"offset"`
}

type RunStep struct {
	ID                string  `json:"id"`
	StepID            string  `json:"step_id"`
	AgentID           string  `json:"agent_id"`
	StepType          string  `json:"step_type"`
	Action            string  `json:"action"`
	Status            string  `json:"status"`
	StartedAt         string  `json:"started_at"`
	CompletedAt       string  `json:"completed_at"`
	TokenCount        int     `json:"token_count"`
	DurationMs        float64 `json:"duration_ms"`
	Error             string  `json:"error"`
}

type RunEvent struct {
	EventType string         `json:"event_type"`
	StepID    *string        `json:"step_id"`
	Data      map[string]any `json:"data"`
	Ts        float64        `json:"ts"`
}

type RunDetail struct {
	Run
	Steps  []RunStep  `json:"steps"`
	Events []RunEvent `json:"events"`
}

type Gate struct {
	ID       string `json:"id"`
	RunID    string `json:"run_id"`
	StepID   string `json:"step_id"`
	Assignee string `json:"assignee"`
	Status   string `json:"status"`
	OpenedAt string `json:"opened_at"`
}

type GateList struct {
	Items []Gate `json:"items"`
}

type Metrics struct {
	Summary struct {
		TotalRuns    int     `json:"total_runs"`
		Succeeded    int     `json:"succeeded"`
		Failed       int     `json:"failed"`
		Running      int     `json:"running"`
		AvgDurationS float64 `json:"avg_duration_s"`
	} `json:"summary"`
	ByWorkflow []struct {
		WorkflowID string `json:"workflow_id"`
		RunCount   int    `json:"run_count"`
		Succeeded  int    `json:"succeeded"`
	} `json:"byWorkflow"`
	TokenSummary []struct {
		AgentID    string  `json:"agent_id"`
		TotalTokens int    `json:"total_tokens"`
		TotalCost  float64 `json:"total_cost"`
	} `json:"tokenSummary"`
	TaskMetrics []struct {
		Action        string  `json:"action"`
		CallCount     int     `json:"call_count"`
		AvgDurationMs float64 `json:"avg_duration_ms"`
		MaxDurationMs float64 `json:"max_duration_ms"`
	} `json:"taskMetrics"`
	From string `json:"from"`
	To   string `json:"to"`
}

type Secret struct {
	Name string `json:"name"`
}

type SecretList struct {
	Items []Secret `json:"items"`
}

// ── Agent methods ─────────────────────────────────────────────────────────────

func (c *Client) ListAgents(ctx context.Context, limit int) (AgentList, error) {
	data, _, err := c.do(ctx, "GET", fmt.Sprintf("/agents?limit=%d", limit), nil)
	if err != nil {
		return AgentList{}, err
	}
	return decode[AgentList](data)
}

func (c *Client) GetAgent(ctx context.Context, id string) (map[string]any, error) {
	data, _, err := c.do(ctx, "GET", "/agents/"+id, nil)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) CreateAgent(ctx context.Context, body AgentCreateBody) (map[string]any, error) {
	data, _, err := c.do(ctx, "POST", "/agents", body)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) UpdateAgent(ctx context.Context, id string, body AgentUpdateBody) (map[string]any, error) {
	data, _, err := c.do(ctx, "PUT", "/agents/"+id, body)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) PromoteAgent(ctx context.Context, id string) (map[string]any, error) {
	data, _, err := c.do(ctx, "POST", "/agents/"+id+"/promote", nil)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) DeleteAgent(ctx context.Context, id string) error {
	_, _, err := c.do(ctx, "DELETE", "/agents/"+id, nil)
	return err
}

// ── Workflow methods ──────────────────────────────────────────────────────────

func (c *Client) ListWorkflows(ctx context.Context, limit int) (WorkflowList, error) {
	data, _, err := c.do(ctx, "GET", fmt.Sprintf("/workflows?limit=%d", limit), nil)
	if err != nil {
		return WorkflowList{}, err
	}
	return decode[WorkflowList](data)
}

func (c *Client) GetWorkflow(ctx context.Context, id string) (map[string]any, error) {
	data, _, err := c.do(ctx, "GET", "/workflows/"+id, nil)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) CreateWorkflow(ctx context.Context, body WorkflowCreateBody) (map[string]any, error) {
	data, _, err := c.do(ctx, "POST", "/workflows", body)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) CompileWorkflow(ctx context.Context, id, dsl string) (CompileResult, error) {
	data, _, err := c.do(ctx, "POST", "/workflows/"+id+"/compile", map[string]string{"dsl": dsl})
	if err != nil {
		return CompileResult{}, err
	}
	return decode[CompileResult](data)
}

func (c *Client) StartRun(ctx context.Context, workflowID string, params map[string]any) (map[string]any, error) {
	data, _, err := c.do(ctx, "POST", "/workflows/"+workflowID+"/runs", map[string]any{"params": params})
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) ListWorkflowRuns(ctx context.Context, workflowID string, limit int) (RunList, error) {
	data, _, err := c.do(ctx, "GET", fmt.Sprintf("/workflows/%s/runs?limit=%d", workflowID, limit), nil)
	if err != nil {
		return RunList{}, err
	}
	return decode[RunList](data)
}

func (c *Client) PromoteWorkflow(ctx context.Context, id string) (map[string]any, error) {
	data, _, err := c.do(ctx, "POST", "/workflows/"+id+"/promote", nil)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) DeleteWorkflow(ctx context.Context, id string) error {
	_, _, err := c.do(ctx, "DELETE", "/workflows/"+id, nil)
	return err
}

// ── Run methods ───────────────────────────────────────────────────────────────

func (c *Client) ListRuns(ctx context.Context, status string, limit int) (RunList, error) {
	q := url.Values{}
	q.Set("limit", fmt.Sprintf("%d", limit))
	if status != "" {
		q.Set("status", status)
	}
	data, _, err := c.do(ctx, "GET", "/runs?"+q.Encode(), nil)
	if err != nil {
		return RunList{}, err
	}
	return decode[RunList](data)
}

func (c *Client) GetRun(ctx context.Context, id string) (RunDetail, error) {
	data, _, err := c.do(ctx, "GET", "/runs/"+id, nil)
	if err != nil {
		return RunDetail{}, err
	}
	return decode[RunDetail](data)
}

func (c *Client) DeleteRun(ctx context.Context, id string) error {
	_, _, err := c.do(ctx, "DELETE", "/runs/"+id, nil)
	return err
}

// StreamRunEvents opens the SSE stream for run events and calls onEvent for each.
// Returns when the stream ends (run_completed/run_failed) or ctx is cancelled.
func (c *Client) StreamRunEvents(ctx context.Context, runID string, onEvent func(RunEvent)) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.BaseURL+"/api/runs/"+runID+"/events", nil)
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "text/event-stream")

	httpClient := &http.Client{} // no timeout for streaming
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	var eventType, data string
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			eventType = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data = strings.TrimPrefix(line, "data: ")
		case line == "":
			if eventType == "run_event" && data != "" {
				var ev RunEvent
				if json.Unmarshal([]byte(data), &ev) == nil {
					onEvent(ev)
					if ev.EventType == "run_completed" || ev.EventType == "run_failed" {
						return nil
					}
				}
			}
			eventType, data = "", ""
		}
	}
	return scanner.Err()
}

// ── Gate methods ──────────────────────────────────────────────────────────────

func (c *Client) ListGates(ctx context.Context) (GateList, error) {
	data, _, err := c.do(ctx, "GET", "/gates", nil)
	if err != nil {
		return GateList{}, err
	}
	return decode[GateList](data)
}

func (c *Client) ApproveGate(ctx context.Context, id, notes string) (map[string]any, error) {
	body := map[string]string{}
	if notes != "" {
		body["notes"] = notes
	}
	data, _, err := c.do(ctx, "POST", "/gates/"+id+"/approve", body)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) RejectGate(ctx context.Context, id, notes string) (map[string]any, error) {
	body := map[string]string{}
	if notes != "" {
		body["notes"] = notes
	}
	data, _, err := c.do(ctx, "POST", "/gates/"+id+"/reject", body)
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

// ── Metrics ───────────────────────────────────────────────────────────────────

func (c *Client) GetMetrics(ctx context.Context, workflowID, from, to string) (Metrics, error) {
	q := url.Values{}
	if workflowID != "" {
		q.Set("workflow_id", workflowID)
	}
	if from != "" {
		q.Set("from", from)
	}
	if to != "" {
		q.Set("to", to)
	}
	path := "/metrics"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	data, _, err := c.do(ctx, "GET", path, nil)
	if err != nil {
		return Metrics{}, err
	}
	return decode[Metrics](data)
}

// ── Secrets ───────────────────────────────────────────────────────────────────

func (c *Client) ListSecrets(ctx context.Context) (SecretList, error) {
	data, _, err := c.do(ctx, "GET", "/secrets", nil)
	if err != nil {
		return SecretList{}, err
	}
	return decode[SecretList](data)
}

func (c *Client) CreateSecret(ctx context.Context, name, value string) (map[string]any, error) {
	data, _, err := c.do(ctx, "POST", "/secrets", map[string]string{"name": name, "value": value})
	if err != nil {
		return nil, err
	}
	return decode[map[string]any](data)
}

func (c *Client) DeleteSecret(ctx context.Context, name string) error {
	_, _, err := c.do(ctx, "DELETE", "/secrets/"+name, nil)
	return err
}

// ── Bundles ───────────────────────────────────────────────────────────────────

type BundleEntityResult struct {
	Name    string `json:"name"`
	ID      string `json:"id"`
	Version string `json:"version"`
	Created bool   `json:"created"`
}

type BundleDeployResult struct {
	Agents    []BundleEntityResult `json:"agents"`
	Scripts   []BundleEntityResult `json:"scripts"`
	Workflows []BundleEntityResult `json:"workflows"`
}

func (c *Client) DeployBundle(ctx context.Context, dsl string) (BundleDeployResult, error) {
	data, _, err := c.do(ctx, "POST", "/bundles", map[string]string{"dsl": dsl})
	if err != nil {
		return BundleDeployResult{}, err
	}
	return decode[BundleDeployResult](data)
}

// ExportBundle returns the raw .tanzen bundle DSL for the given workflow ID.
func (c *Client) ExportBundle(ctx context.Context, workflowID string) (string, error) {
	data, _, err := c.do(ctx, "GET", "/bundles/"+workflowID, nil)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ── MCP Servers ───────────────────────────────────────────────────────────────

type MCPServer struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	Description string `json:"description"`
	Transport   string `json:"transport"`
}

type MCPServerList struct {
	Items []MCPServer `json:"items"`
}

func (c *Client) ListMCPServers(ctx context.Context) (MCPServerList, error) {
	data, _, err := c.do(ctx, "GET", "/mcp-servers", nil)
	if err != nil {
		return MCPServerList{}, err
	}
	return decode[MCPServerList](data)
}

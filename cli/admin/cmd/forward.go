package cmd

import (
	"fmt"
	"os"
	osexec "os/exec"
	"os/signal"
	"sync"
	"syscall"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"
	"github.com/spf13/cobra"
)

var forwardMCP bool

var forwardCmd = &cobra.Command{
	Use:   "forward",
	Short: "Start all port-forwards for the Tanzen dev environment",
	Long: `tanzenctl forward starts kubectl port-forward processes for all services:

  Temporal frontend  7233 → 7233
  Postgres           5432 → 5432
  Redis              6379 → 6379
  SeaweedFS filer    8333 → 8333

  With --mcp:
  MCP: Sequential Thinking  8081 → 8080
  MCP: Fetch                8082 → 8080
  MCP: FalkorDB             8083 → 8080
  kubectl proxy             8088       (k8s API for MCP discovery)

Press Ctrl-C to stop all forwards.`,
	RunE: runForward,
}

func init() {
	rootCmd.AddCommand(forwardCmd)
	forwardCmd.Flags().BoolVar(&forwardMCP, "mcp", false, "Also forward MCP server ports (8081/8082/8083)")
}

type portForward struct {
	service string
	local   int
	remote  int
	desc    string
}

var forwards = []portForward{
	{"svc/tanzen-temporal-frontend", 7233, 7233, "Temporal gRPC"},
	{"svc/tanzen-postgres-rw", 5432, 5432, "PostgreSQL"},
	{"svc/tanzen-redis-master", 6379, 6379, "Redis"},
	{"svc/seaweedfs-filer", 8333, 8333, "SeaweedFS S3"},
}

var mcpForwards = []portForward{
	{"svc/mcp-sequential-thinking", 8081, 8080, "MCP: Sequential Thinking"},
	{"svc/mcp-fetch", 8082, 8080, "MCP: Fetch"},
	{"svc/mcp-falkordb", 8083, 8080, "MCP: FalkorDB"},
}

func runForward(_ *cobra.Command, _ []string) error {
	active := append([]portForward(nil), forwards...)
	if forwardMCP {
		active = append(active, mcpForwards...)
	}

	var procs []*osexec.Cmd
	var mu sync.Mutex
	var wg sync.WaitGroup

	// Print table before starting
	tw := tablewriter.NewWriter(os.Stdout)
	tw.SetHeader([]string{"Service", "Local Port", "Remote Port", "Description"})
	tw.SetBorder(false)
	tw.SetColumnSeparator("  ")
	tw.SetHeaderLine(false)
	tw.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	tw.SetAlignment(tablewriter.ALIGN_LEFT)
	for _, f := range active {
		tw.Append([]string{
			f.service,
			fmt.Sprintf("%d", f.local),
			fmt.Sprintf("%d", f.remote),
			f.desc,
		})
	}
	tw.Render()
	fmt.Println()
	fmt.Println(color.CyanString("Press Ctrl-C to stop all forwards"))
	fmt.Println()

	// Start kubectl proxy for k8s API access (needed for MCP discovery) when --mcp is set
	if forwardMCP {
		proxy := osexec.Command("kubectl", "proxy", "--port=8088")
		proxy.Stdout = os.Stdout
		proxy.Stderr = os.Stderr
		if err := proxy.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "failed to start kubectl proxy: %v\n", err)
		} else {
			mu.Lock()
			procs = append(procs, proxy)
			mu.Unlock()
			wg.Add(1)
			go func() { defer wg.Done(); _ = proxy.Wait() }()
		}
	}

	// Start each port-forward in its own process
	for _, f := range active {
		f := f
		c := osexec.Command("kubectl", "port-forward",
			"-n", namespace,
			f.service,
			fmt.Sprintf("%d:%d", f.local, f.remote),
		)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		if err := c.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "failed to start forward for %s: %v\n", f.service, err)
			continue
		}
		mu.Lock()
		procs = append(procs, c)
		mu.Unlock()

		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = c.Wait()
		}()
	}

	// Wait for interrupt
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	fmt.Println("\nStopping port-forwards...")
	mu.Lock()
	for _, p := range procs {
		if p.Process != nil {
			_ = p.Process.Kill()
		}
	}
	mu.Unlock()
	wg.Wait()
	return nil
}

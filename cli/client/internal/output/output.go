// Package output provides table and JSON rendering for CLI responses.
package output

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"time"

	"github.com/olekukonko/tablewriter"
)

// Mode controls how output is rendered.
type Mode string

const (
	ModeTable Mode = "table"
	ModeJSON  Mode = "json"
)

// JSON prints v as indented JSON.
func JSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// Table creates a pre-configured tablewriter.
func Table(headers []string) *tablewriter.Table {
	tw := tablewriter.NewWriter(os.Stdout)
	tw.SetHeader(headers)
	tw.SetBorder(false)
	tw.SetColumnSeparator("  ")
	tw.SetHeaderLine(false)
	tw.SetHeaderAlignment(tablewriter.ALIGN_LEFT)
	tw.SetAlignment(tablewriter.ALIGN_LEFT)
	tw.SetAutoWrapText(false)
	return tw
}

// Rel returns a human-readable relative time string (e.g. "2m ago").
func Rel(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	d := time.Since(t)
	if d < 0 {
		d = -d
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// Duration formats a duration in seconds to a readable string.
func Duration(seconds float64) string {
	if math.IsNaN(seconds) || seconds < 0 {
		return "—"
	}
	if seconds < 60 {
		return fmt.Sprintf("%.1fs", seconds)
	}
	return fmt.Sprintf("%.0fm%.0fs", math.Floor(seconds/60), math.Mod(seconds, 60))
}

// ParseTime parses an ISO time string, returning zero value on error.
func ParseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

package cmd

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"

	"github.com/fatih/color"
)

// runCmd executes a command with stdout/stderr streamed to the terminal.
func runCmd(name string, args ...string) error {
	if dryRun {
		fmt.Println(color.HiBlackString("  $ "+name+" "+strings.Join(args, " ")))
		return nil
	}
	c := osexec.Command(name, args...)
	if kubeconfig != "" {
		c.Env = append(os.Environ(), "KUBECONFIG="+kubeconfig)
	} else {
		c.Env = os.Environ()
	}
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

// runCmdOutput executes a command and returns its combined output.
// In dry-run mode it prints the command and returns a placeholder string.
func runCmdOutput(name string, args ...string) (string, error) {
	if dryRun {
		fmt.Println(color.HiBlackString("  $ " + name + " " + strings.Join(args, " ")))
		return "<dry-run>", nil
	}
	c := osexec.Command(name, args...)
	if kubeconfig != "" {
		c.Env = append(os.Environ(), "KUBECONFIG="+kubeconfig)
	} else {
		c.Env = os.Environ()
	}
	var buf bytes.Buffer
	c.Stdout = &buf
	c.Stderr = &buf
	err := c.Run()
	return strings.TrimSpace(buf.String()), err
}

// checkPrereqs verifies that required tools are on PATH.
func checkPrereqs(tools ...string) error {
	missing := []string{}
	for _, t := range tools {
		if _, err := osexec.LookPath(t); err != nil {
			missing = append(missing, t)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required tools: %s", strings.Join(missing, ", "))
	}
	return nil
}

// secretExists checks whether a k8s secret already exists.
func secretExists(name string) bool {
	out, err := runCmdOutput("kubectl", "-n", namespace, "get", "secret", name, "--ignore-not-found", "-o", "name")
	return err == nil && strings.Contains(out, name)
}

// createSecretIfMissing creates a k8s secret only if it does not already exist.
// literals is a map of key → value.
func createSecretIfMissing(name string, literals map[string]string) error {
	if secretExists(name) {
		fmt.Printf("  secret/%s already exists, skipping\n", name)
		return nil
	}
	args := []string{"create", "secret", "generic", name, "-n", namespace}
	for k, v := range literals {
		args = append(args, fmt.Sprintf("--from-literal=%s=%s", k, v))
	}
	args = append(args, "--dry-run=client", "-o", "yaml")
	yaml, err := runCmdOutput("kubectl", args...)
	if err != nil {
		return fmt.Errorf("build secret %s: %w", name, err)
	}
	return runCmdIn(yaml, "kubectl", "apply", "-f", "-")
}

// runCmdIn executes a command with the given string piped to stdin.
// In dry-run mode it prints the command and returns nil without executing.
func runCmdIn(stdin, name string, args ...string) error {
	if dryRun {
		fmt.Println(color.HiBlackString("  $ " + name + " " + strings.Join(args, " ") + " <<EOF"))
		return nil
	}
	c := osexec.Command(name, args...)
	if kubeconfig != "" {
		c.Env = append(os.Environ(), "KUBECONFIG="+kubeconfig)
	} else {
		c.Env = os.Environ()
	}
	c.Stdin = strings.NewReader(stdin)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

// labelSecret adds tanzen/managed=true to a secret.
func labelSecret(name string) error {
	return runCmd("kubectl", "label", "secret", name, "-n", namespace, "tanzen/managed=true", "--overwrite")
}

// randHex returns n random hex bytes (2n hex chars).
func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

package cmd

import (
	"fmt"
	"path/filepath"

	"github.com/spf13/cobra"
)

var workerTag string

var buildCmd = &cobra.Command{
	Use:   "build-worker",
	Short: "Build the worker Docker image, load it into Kind, and restart the deployment",
	RunE:  runBuild,
}

func init() {
	buildCmd.Flags().StringVar(&workerTag, "tag", "latest", "Docker image tag")
	rootCmd.AddCommand(buildCmd)
}

func runBuild(_ *cobra.Command, _ []string) error {
	if err := checkPrereqs("docker", "kind", "kubectl"); err != nil {
		return err
	}

	root := repoRoot()
	workerDir := filepath.Join(root, "worker")
	image := fmt.Sprintf("tanzen-worker:%s", workerTag)

	step("Building worker Docker image")
	// Use repo root as build context so infra/executor is accessible via COPY.
	dockerfilePath := filepath.Join(workerDir, "Dockerfile")
	if err := runCmd("docker", "build", "-t", image, "-f", dockerfilePath, root); err != nil {
		return fmt.Errorf("docker build: %w", err)
	}
	success("Image built: " + image)

	step("Loading image into Kind cluster")
	if err := runCmd("kind", "load", "docker-image", image, "--name", clusterName); err != nil {
		return fmt.Errorf("kind load: %w", err)
	}
	success("Image loaded into cluster")

	step("Restarting tanzen-worker deployment")
	if err := runCmd("kubectl", "rollout", "restart", "deployment", "tanzen-worker", "-n", namespace); err != nil {
		return fmt.Errorf("rollout restart: %w", err)
	}
	if err := runCmd("kubectl", "rollout", "status", "deployment", "tanzen-worker", "-n", namespace, "--timeout=120s"); err != nil {
		return fmt.Errorf("rollout status: %w", err)
	}
	success("Worker restarted with new image")
	return nil
}

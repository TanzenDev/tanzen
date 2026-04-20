package cmd

import (
	"fmt"

	"tanzen/internal/output"

	"github.com/spf13/cobra"
)

var secretCmd = &cobra.Command{
	Use:   "secret",
	Short: "Manage API secrets (stored as k8s secrets)",
}

var secretListCmd = &cobra.Command{
	Use:   "list",
	Short: "List secret names (values are never returned)",
	RunE: func(_ *cobra.Command, _ []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		list, err := client.ListSecrets(ctx())
		if err != nil {
			return err
		}
		if outputFormat == "json" {
			return output.JSON(list)
		}
		if quiet {
			for _, s := range list.Items {
				fmt.Println(s.Name)
			}
			return nil
		}
		if len(list.Items) == 0 {
			fmt.Println("No secrets.")
			return nil
		}
		tw := output.Table([]string{"Name"})
		for _, s := range list.Items {
			tw.Append([]string{s.Name})
		}
		tw.Render()
		return nil
	},
}

var secretSetCmd = &cobra.Command{
	Use:   "set <name> <value>",
	Short: "Create or update a secret",
	Args:  cobra.ExactArgs(2),
	RunE: func(_ *cobra.Command, args []string) error {
		client, err := newClient()
		if err != nil {
			return err
		}
		if _, err := client.CreateSecret(ctx(), args[0], args[1]); err != nil {
			return err
		}
		fmt.Printf("Secret %q set\n", args[0])
		return nil
	},
}

var secretDeleteYes bool

var secretDeleteCmd = &cobra.Command{
	Use:   "delete <name>",
	Short: "Delete a secret",
	Args:  cobra.ExactArgs(1),
	RunE: func(_ *cobra.Command, args []string) error {
		if !secretDeleteYes {
			fmt.Printf("Delete secret %q? Run with --yes to confirm.\n", args[0])
			return nil
		}
		client, err := newClient()
		if err != nil {
			return err
		}
		if err := client.DeleteSecret(ctx(), args[0]); err != nil {
			return err
		}
		fmt.Printf("Secret %q deleted\n", args[0])
		return nil
	},
}

func init() {
	secretDeleteCmd.Flags().BoolVar(&secretDeleteYes, "yes", false, "Skip confirmation")
	secretCmd.AddCommand(secretListCmd, secretSetCmd, secretDeleteCmd)
	rootCmd.AddCommand(secretCmd)
}

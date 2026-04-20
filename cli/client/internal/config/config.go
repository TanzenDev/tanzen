// Package config manages the ~/.tanzen/config.yaml file.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config holds the client configuration.
type Config struct {
	URL   string `yaml:"url"`
	Token string `yaml:"token"`
}

func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".tanzen", "config.yaml"), nil
}

// Load reads the config file, returning defaults if it doesn't exist.
// Env vars TANZEN_URL and TANZEN_TOKEN override file values.
func Load() (*Config, error) {
	cfg := &Config{
		URL:   "http://localhost:3002",
		Token: "",
	}

	path, err := configPath()
	if err != nil {
		return cfg, nil // silently use defaults
	}

	data, err := os.ReadFile(path)
	if err == nil {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	}

	// Env overrides
	if v := os.Getenv("TANZEN_URL"); v != "" {
		cfg.URL = v
	}
	if v := os.Getenv("TANZEN_TOKEN"); v != "" {
		cfg.Token = v
	}

	return cfg, nil
}

// Save writes the config to ~/.tanzen/config.yaml.
func Save(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

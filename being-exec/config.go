package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// loadConfig reads a YAML config file and merges it into dst.
// Fields not present in the file retain their defaults.
func loadConfig(path string, dst *Config) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("config file not found: %s", path)
		}
		return fmt.Errorf("open config: %w", err)
	}
	defer f.Close()

	dec := yaml.NewDecoder(f)
	dec.KnownFields(true)
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	return nil
}

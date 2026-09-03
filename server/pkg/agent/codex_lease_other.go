//go:build !linux

package agent

import "log/slog"

func writeCodexProcessLease(string, Config, int) (string, error) { return "", nil }
func removeCodexProcessLease(string)                             {}
func RecoverCodexProcessLeases(string, *slog.Logger)             {}

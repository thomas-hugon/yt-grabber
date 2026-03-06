package main

import "testing"

func TestShouldPrintVersion(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "empty", args: nil, want: false},
		{name: "dash_version", args: []string{"--version"}, want: true},
		{name: "single_dash_v", args: []string{"-v"}, want: true},
		{name: "word_version", args: []string{"version"}, want: true},
		{name: "unknown", args: []string{"serve"}, want: false},
		{name: "second_arg_ignored", args: []string{"serve", "--version"}, want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldPrintVersion(tc.args); got != tc.want {
				t.Fatalf("shouldPrintVersion(%v) = %v, want %v", tc.args, got, tc.want)
			}
		})
	}
}

func TestServerVersion(t *testing.T) {
	original := version
	t.Cleanup(func() { version = original })

	version = "v2026.03.06-9"
	if got := serverVersion(); got != "v2026.03.06-9" {
		t.Fatalf("serverVersion() = %q, want %q", got, "v2026.03.06-9")
	}

	version = "   "
	if got := serverVersion(); got != "dev" {
		t.Fatalf("serverVersion() with blank version = %q, want %q", got, "dev")
	}
}

func TestServerCommit(t *testing.T) {
	original := commit
	t.Cleanup(func() { commit = original })

	commit = "abc123"
	if got := serverCommit(); got != "abc123" {
		t.Fatalf("serverCommit() = %q, want %q", got, "abc123")
	}

	commit = "   "
	if got := serverCommit(); got != "unknown" {
		t.Fatalf("serverCommit() with blank commit = %q, want %q", got, "unknown")
	}
}

func TestDisplayVersion(t *testing.T) {
	originalVersion := version
	originalCommit := commit
	t.Cleanup(func() {
		version = originalVersion
		commit = originalCommit
	})

	version = "v2026.03.06-10"
	commit = "5fbeec16eb788b0deb4441a498978113a7c13e8a"

	want := "v2026.03.06-10 (5fbeec16eb788b0deb4441a498978113a7c13e8a)"
	if got := displayVersion(); got != want {
		t.Fatalf("displayVersion() = %q, want %q", got, want)
	}
}

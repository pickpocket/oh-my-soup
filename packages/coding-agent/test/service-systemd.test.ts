import { afterEach, expect, test } from "bun:test";
import { buildUnitFile, quoteUnitWord } from "../src/service/systemd";

const savedEnv = {
	PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("unit words neutralize systemd specifiers, quotes, and backslashes", () => {
	// `%h` would expand to the home dir and an unescaped quote would split the word.
	expect(quoteUnitWord('/opt/100%/My "Soup"\\bin')).toBe('"/opt/100%%/My \\"Soup\\"\\\\bin"');
	expect(() => quoteUnitWord("a\nb")).toThrow("newline");
});

test("unit file runs the host with the installer PATH and pinned agent dir, stopping it gracefully", () => {
	process.env.PI_CODING_AGENT_DIR = "/srv/oms agent";
	delete process.env.PI_CONFIG_DIR;
	const unit = buildUnitFile(
		{ id: "oms-alpha-0123456789abcdef", profile: undefined, user: "alpha" },
		["/usr/local/bin/oms", "service", "run"],
		"/home/alpha/.bun/bin:/usr/bin",
	);
	const lines = unit.split("\n");
	expect(lines).toContain('ExecStart="/usr/local/bin/oms" "service" "run"');
	expect(lines).toContain('Environment="PATH=/home/alpha/.bun/bin:/usr/bin"');
	expect(lines).toContain('Environment="PI_CODING_AGENT_DIR=/srv/oms agent"');
	// The host must receive SIGTERM alone first so it can end its PTY children,
	// and its 128+signal exit must not leave the unit in the failed state.
	expect(lines).toContain("KillMode=mixed");
	expect(lines).toContain("TimeoutStopSec=15");
	expect(lines).toContain("SuccessExitStatus=143 130");
	expect(lines).toContain("WantedBy=default.target");
	expect(lines.indexOf("[Install]")).toBeGreaterThan(lines.indexOf("[Service]"));
});

test("a profile service derives its agent dir from --profile instead of an inherited override", () => {
	process.env.PI_CODING_AGENT_DIR = "/srv/other-profile-agent";
	const unit = buildUnitFile(
		{ id: "oms-alpha-work-0123456789abcdef", profile: "work", user: "alpha" },
		["/usr/local/bin/oms", "--profile", "work", "service", "run"],
		"",
	);
	expect(unit).not.toContain("PI_CODING_AGENT_DIR");
	expect(unit).not.toContain("Environment=");
	expect(unit).toContain("Description=Oh My Soup terminal (alpha, profile work)");
});

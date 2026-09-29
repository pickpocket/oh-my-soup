import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-soup/pi-coding-agent/extensibility/skills";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-soup/pi-coding-agent/tools";
import { BashTool } from "@oh-my-soup/pi-coding-agent/tools/bash";

let tempDir: string;
let session: ToolSession;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("bash skill URLs through the shell filesystem", () => {
	it("reads skill resources through the session's InternalUrlFilesystem", async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-url-")));
		const skillDir = path.join(tempDir, "docs");
		const resourceDir = path.join(skillDir, "guides");
		const resourcePath = path.join(resourceDir, "setup.md");
		const contents = "Install the package before running the command.\n";
		await fs.mkdir(resourceDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: docs\ndescription: test\n---\n");
		await fs.writeFile(resourcePath, contents);

		const skill: Skill = {
			name: "docs",
			description: "test skill",
			filePath: path.join(skillDir, "SKILL.md"),
			baseDir: skillDir,
			source: "test",
		};
		session = {
			cwd: tempDir,
			hasUI: false,
			skills: [skill],
			getSessionFile: () => null,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			getClientBridge: () => undefined,
		} as unknown as ToolSession;

		const result = await new BashTool(session).execute("skill-url-test", {
			command: "cat skill://docs/guides/setup.md",
		});
		const output = result.content.find(content => content.type === "text");

		expect(result.isError).not.toBe(true);
		expect(output?.text).toContain(contents);
	});
});

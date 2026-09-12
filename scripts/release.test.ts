import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceRequiredInFiles, validateExplicitVersion } from "./release";

describe("validateExplicitVersion", () => {
	test("rejects malformed versions", () => {
		expect(validateExplicitVersion("999.bad")).toBe(null);
		expect(validateExplicitVersion("17")).toBe(null);
		expect(validateExplicitVersion("17.2")).toBe(null);
		expect(validateExplicitVersion("17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("v17.2.8.9")).toBe(null);
		expect(validateExplicitVersion("abc")).toBe(null);
		expect(validateExplicitVersion("")).toBe(null);
		expect(validateExplicitVersion("v")).toBe(null);
		expect(validateExplicitVersion("17.2.8-")).toBe(null);
	});

	test("rejects leading zeroes in numeric segments", () => {
		expect(validateExplicitVersion("018.0.0")).toBe(null);
		expect(validateExplicitVersion("v018.0.0")).toBe(null);
		expect(validateExplicitVersion("18.00.0")).toBe(null);
		expect(validateExplicitVersion("18.0.00")).toBe(null);
	});

	test("rejects prerelease suffixes (not supported by this release path)", () => {
		// Prereleases would be published as npm `latest` because the downstream
		// publish runs `npm publish` with no `--tag`.
		expect(validateExplicitVersion("17.2.8-rc.1")).toBe(null);
		expect(validateExplicitVersion("v17.2.8-beta")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha")).toBe(null);
		expect(validateExplicitVersion("1.0.0-alpha.1.2")).toBe(null);
		expect(validateExplicitVersion("1.0.0-0.3.7")).toBe(null);
		expect(validateExplicitVersion("1.0.0-x.7.z.92")).toBe(null);
	});

	test("accepts bare three-segment numeric versions and returns them unchanged", () => {
		expect(validateExplicitVersion("17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("0.0.0")).toBe("0.0.0");
		expect(validateExplicitVersion("1.0.0")).toBe("1.0.0");
	});

	test("accepts leading v prefix and normalizes to the bare version", () => {
		expect(validateExplicitVersion("v17.2.8")).toBe("17.2.8");
		expect(validateExplicitVersion("V17.2.8")).toBe(null);
	});
});

describe("release metadata replacement", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	});

	async function files(contents: string[]): Promise<string[]> {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oms-release-metadata-"));
		directories.push(directory);
		return Promise.all(
			contents.map(async (content, index) => {
				const file = path.join(directory, String(index));
				await Bun.write(file, content);
				return file;
			}),
		);
	}

	test("resumes a mixed version bump and accepts already prepared metadata", async () => {
		const paths = await files([
			'{"version": "17.3.3", "description": "keep this"}',
			'{"version": "17.5.0", "description": "keep this"}',
		]);
		const pattern = /"version": "[^"]+"/;
		await replaceRequiredInFiles(paths, pattern, '"version": "17.5.0"');
		await replaceRequiredInFiles(paths, pattern, '"version": "17.5.0"');
		for (const file of paths) {
			expect(await Bun.file(file).json()).toEqual({ version: "17.5.0", description: "keep this" });
		}
	});

	test("still rejects a missing required field without rewriting it", async () => {
		const source = '{"description": "17.5.0"}';
		const [file] = await files([source]);
		await expect(replaceRequiredInFiles([file], /"version": "[^"]+"/, '"version": "17.5.0"')).rejects.toThrow(
			`Release replacement did not match ${file}`,
		);
		expect(await Bun.file(file).text()).toBe(source);
	});

	test("updates every native sentinel and permits repeated global replacements", async () => {
		const paths = await files(["__piNativesV17_5_0 __piNativesV17_5_0", "__piNativesV17_3_3 __piNativesV17_5_0"]);
		const pattern = /__piNativesV[A-Za-z0-9_]+/g;
		await replaceRequiredInFiles(paths, pattern, "__piNativesV17_5_0");
		await replaceRequiredInFiles(paths, pattern, "__piNativesV17_5_0");
		for (const file of paths) {
			expect(await Bun.file(file).text()).toBe("__piNativesV17_5_0 __piNativesV17_5_0");
		}
	});
});

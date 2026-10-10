import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { extractUriScheme, parseInternalUrl } from "../../src/internal-urls/parse";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { SshProtocolHandler } from "../../src/internal-urls/ssh-protocol";
import { InternalUrlFilesystem, isUrlPath, joinUrlPath } from "../../src/internal-urls/url-filesystem";
import { parseTrampSshPath } from "../../src/ssh/tramp-path";
import {
	expandPath,
	normalizePathLikeInput,
	parseSearchPath,
	splitPathAndSelPreferringLiteral,
	splitPathAndSelPreferringLiteralSync,
} from "../../src/tools/path-utils";
import { splitImageQuestionTarget } from "../../src/tools/read";

beforeEach(() => InternalUrlRouter.resetForTests());
afterEach(() => InternalUrlRouter.resetForTests());

describe("single-hop TRAMP path parsing", () => {
	it("preserves literal URL metacharacters, colons, dot segments, and trailing spaces", () => {
		const input = "/ssh:user@[2001:db8::1]#2222:/srv/../app//a b?#%2F:raw  ";
		const parsed = parseTrampSshPath(input);
		expect(parsed).toEqual({
			authority: "user@[2001:db8::1]:2222",
			remotePath: "/srv/../app//a b?#%2F:raw  ",
			url: "ssh://user@[2001:db8::1]:2222/srv/../app//a%20b%3F%23%252F%3Araw%20%20",
		});
		const url = parseInternalUrl(input);
		expect(url.rawHref).toBe(input);
		expect(url.username).toBe("user");
		expect(url.hostname).toBe("[2001:db8::1]");
		expect(url.port).toBe("2222");
		expect(url.search).toBe("");
		expect(url.hash).toBe("");
	});

	it("preserves ordinary local names lacking the full remote syntax", () => {
		const router = InternalUrlRouter.instance();
		for (const input of ["/ssh-cache/x", "/ssh:cache/x", "/ssh:cache", "/ssh/host:file", "/ssh:[cache]/x"]) {
			expect(parseTrampSshPath(input)).toBeUndefined();
			expect(extractUriScheme(input)).toBeUndefined();
			expect(isUrlPath(input)).toBe(false);
			expect(router.canHandle(input)).toBe(false);
			expect(router.normalize(input)).toBe(input);
		}
	});

	it("recognizes malformed remote targets so they cannot fall back to local files", () => {
		const router = InternalUrlRouter.instance();
		for (const input of [
			"/ssh:",
			"/ssh::/x",
			"/ssh:@host:/x",
			"/ssh:a@b@host:/x",
			"/ssh:host#:/x",
			"/ssh:host#0:/x",
			"/ssh:host#65536:/x",
			"/ssh:host#abc:/x",
			"/ssh:[bad]:/x",
			"/ssh:[::1:/x",
			"/ssh:[[::1]]:/x",
			"/ssh:2001:db8::1:/x",
			"/ssh:user:secret@host:/x",
		]) {
			expect(extractUriScheme(input)).toBe("ssh");
			expect(isUrlPath(input)).toBe(true);
			expect(() => parseTrampSshPath(input)).toThrow(/Malformed TRAMP/);
			expect(() => router.canHandle(input)).toThrow(/Malformed TRAMP/);
		}
	});

	it("rejects unsupported methods and multi-hop destinations explicitly", () => {
		for (const input of ["/sudo:root@host:/x", "/scp:user@host:/x", "/-:host:/x"]) {
			expect(() => extractUriScheme(input)).toThrow(/Unsupported TRAMP method/);
			expect(() => InternalUrlRouter.instance().normalize(input)).toThrow(/Unsupported TRAMP method/);
		}
		expect(() => parseTrampSshPath("/ssh:jump|ssh:user@host:/x")).toThrow(/multi-hop/);
	});
});

describe("TRAMP through shared file routing", () => {
	it("keeps selector-shaped filenames literal across read, write, and search path preprocessing", async () => {
		const input = "/ssh:host:/tmp/a\u00a0b?#%:12:raw  ";
		const router = InternalUrlRouter.instance();
		expect(router.canResolve(input)).toBe(true);
		expect(router.split(input)).toEqual({ path: input });
		expect(router.peelWriteSelector(input, "write")).toBe(input);
		expect(router.writeTarget(input)?.spec.backing).toBe("remote");
		expect(router.readTier(`cat '${input}'`)).toBe("exec");
		expect((await router.target(input))?.url.rawHref).toBe(input);
		expect(expandPath(input)).toBe(input);
		expect(normalizePathLikeInput(input)).toBe(input);
		expect(parseSearchPath(input)).toEqual({ basePath: input });
		expect(splitImageQuestionTarget("/ssh:host:/tmp/image.png?q=literal filename")).toEqual({
			path: "/ssh:host:/tmp/image.png?q=literal filename",
		});
		expect(await splitPathAndSelPreferringLiteral(input, "/workspace")).toEqual({ path: input });
		expect(splitPathAndSelPreferringLiteralSync(input, "/workspace")).toEqual({ path: input });
		// ssh:// keeps its established selector grammar.
		expect(router.split("ssh://host/tmp/file:12:raw")).toEqual({ path: "ssh://host/tmp/file", sel: "12:raw" });
	});

	it("reads literal TRAMP entries through the existing URL filesystem rather than a truncated filename", async () => {
		const router = InternalUrlRouter.instance();
		const files: Record<string, string> = {
			"/tmp/a b?#%2F:raw": "literal filename\n",
			"/tmp/a b": "wrong truncated filename\n",
		};
		router.register({
			scheme: "ssh",
			spec: new SshProtocolHandler().spec,
			async resolve(url) {
				const filename = decodeURIComponent(url.rawPathname ?? url.pathname);
				const content = files[filename];
				if (content === undefined) throw new Error(`No such file: ${filename}`);
				return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
			},
			async write() {
				throw new Error("Test fixture is read-only");
			},
		});
		const filesystem = new InternalUrlFilesystem({ context: {}, tier: "exec" });
		const input = "/ssh:host:/tmp/a b?#%2F:raw";
		expect(new TextDecoder().decode(await filesystem.readPrefix(input, 1024))).toBe("literal filename\n");
		await expect(filesystem.readPrefix("/ssh:host:/tmp/missing:raw", 1024)).rejects.toThrow(/No such file/);
		await expect(new InternalUrlFilesystem({ context: {}, tier: "read" }).readPrefix(input, 1024)).rejects.toThrow(
			/exec approval/,
		);
	});

	it("joins raw search result names without decoding or changing remote-home roots", () => {
		expect(joinUrlPath("/ssh:host:/tmp", "a b?#%2F:12")).toBe("/ssh:host:/tmp/a b?#%2F:12");
		expect(joinUrlPath("/ssh:host:", "a b?#%2F:12")).toBe("/ssh:host:a b?#%2F:12");
	});
});

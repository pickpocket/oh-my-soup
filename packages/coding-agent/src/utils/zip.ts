// The single archive boundary for the codebase: ZIP (framed here, over the raw
// DEFLATE codec in `node:zlib`) and tar / tar.gz (parsed in-process here, gzip
// via `node:zlib`; only archive *writing* uses `Bun.Archive`). This is the ONLY
// module that frames ZIP containers, parses tar, or touches `Bun.Archive`; the
// markit document converters, the read/search/write tools, the URL fetcher, the
// debug report bundler, and the tool-binary installer all go through here so
// there is exactly one archive implementation to reason about. Do not parse or
// build ZIP/tar, or call `Bun.Archive`, anywhere else. Tar *reads* deliberately
// avoid libarchive: its internal allocation-failure path aborts the whole
// process (#4774).
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { formatBytes, isEexist } from "@oh-my-soup/pi-utils";
import { ToolError } from "../tools/tool-errors";

/** A ZIP archive decoded to a `path → bytes` map of its file members. */
export type Unzipped = Record<string, Uint8Array>;

const ENCODER = new TextEncoder();
// `node:zlib` is only the DEFLATE codec; ZIP container framing is ours (see
// `unzip` / `zip` below). Entry names use the platform text decoders.
const UTF8_DECODER = new TextDecoder();
// ZIP central-directory names without the UTF-8 flag carry no reliable encoding;
// decode them as their legacy code page (windows-1252) as a stable best effort.
const LEGACY_NAME_DECODER = new TextDecoder("windows-1252");

/** Read a single ZIP entry as UTF-8 text, or `undefined` when the entry is absent. */
export function unzipText(entries: Unzipped, entryPath: string): string | undefined {
	const data = entries[entryPath];
	return data ? UTF8_DECODER.decode(data) : undefined;
}

/**
 * Decode an in-memory ZIP archive into a `path → bytes` map of its file members
 * (directory entries and `..`-escaping names are dropped). Shares the
 * central-directory record parser with the lazy, file-backed reader.
 */
export function unzip(bytes: Uint8Array): Unzipped {
	const info = readCentralDirectoryInfoSync(bytes);
	const centralDirectory = readMemoryRange(bytes, info.offset, info.offset + info.size);
	const out: Unzipped = {};
	for (const entry of parseZipCentralDirectory(memoryByteSource(bytes), centralDirectory, info.entries)) {
		if (entry.isDirectory || entry.storage?.type !== "zip") continue;
		out[entry.path] = extractZipMember(bytes, entry.storage, entry.size);
	}
	return out;
}

/**
 * Cap on tar/tar.gz archives loaded fully into memory for in-process indexing
 * (gzip input is bounded to this decompressed size). ZIP is exempt: it is read
 * via ranged central-directory access.
 */
const MAX_TAR_ARCHIVE_BYTES = 256 * 1024 * 1024;
/**
 * Reject a tar input before materializing it. Tar indexing retains the
 * complete decoded stream, unlike ZIP's ranged central-directory reader.
 */
function assertTarArchiveSize(size: number): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ToolError("Archive is too large to read safely");
	}
	if (size > MAX_TAR_ARCHIVE_BYTES) {
		throw new ToolError(
			`Archive is too large to read in memory (${formatBytes(size)} > ${formatBytes(MAX_TAR_ARCHIVE_BYTES)} limit)`,
		);
	}
}
/**
 * Cap on a single archive member's declared (uncompressed) size. The declared
 * size is attacker-controlled metadata — a crafted ZIP entry can claim
 * multi-GB sizes that would be allocated up front before any data inflates.
 */
const MAX_ARCHIVE_MEMBER_BYTES = 64 * 1024 * 1024;

/** Inflate one raw DEFLATE stream, bounded to its declared uncompressed size. */
function inflateRaw(bytes: Uint8Array, declaredSize: number): Uint8Array {
	return zlib.inflateRawSync(bytes, { maxOutputLength: Math.max(declaredSize, 1) });
}

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

/**
 * Where to read an archive from: an extension-inferred filesystem path, a
 * format-tagged filesystem path, or in-memory bytes with an explicit format.
 * ZIP paths are read lazily via ranged central-directory access.
 */
export type ArchiveSource =
	| string
	| { bytes: Uint8Array; format: ArchiveFormat }
	| { path: string; format: ArchiveFormat };

/** Content for a member when packing or extracting an archive. */
export type ArchiveMemberContent = string | Uint8Array | Blob;

export interface ArchivePathCandidate {
	archivePath: string;
	subPath: string;
}

export interface ArchiveNode {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs?: number;
}

export interface ArchiveDirectoryEntry extends ArchiveNode {
	name: string;
}

export interface ExtractedArchiveFile extends ArchiveNode {
	bytes: Uint8Array;
}

/** A byte window into an archive — file-backed (lazy) or in-memory. */
interface ByteSource {
	readonly size: number;
	read(start: number, end: number): Promise<Uint8Array>;
}

function assertValidRange(start: number, end: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new ToolError("Invalid ZIP archive range");
	}
}

/** Read an exact in-memory range, throwing (not clamping) when it runs past the buffer. */
function readMemoryRange(buffer: Uint8Array, start: number, end: number): Uint8Array {
	assertValidRange(start, end);
	if (end > buffer.byteLength) {
		throw new ToolError("Invalid ZIP archive: truncated data");
	}
	return buffer.subarray(start, end);
}

function fileByteSource(filePath: string): ByteSource {
	const file = Bun.file(filePath);
	const size = file.size;
	if (!Number.isSafeInteger(size)) {
		throw new ToolError("ZIP archive is too large to read safely");
	}
	return {
		size,
		async read(start, end) {
			assertValidRange(start, end);
			const bytes = await file.slice(start, end).bytes();
			if (bytes.byteLength !== end - start) {
				throw new ToolError("Invalid ZIP archive: truncated data");
			}
			return bytes;
		},
	};
}

function memoryByteSource(buffer: Uint8Array): ByteSource {
	return {
		size: buffer.byteLength,
		async read(start, end) {
			return readMemoryRange(buffer, start, end);
		},
	};
}

interface TarStorage {
	type: "tar";
	buffer: Uint8Array;
	dataOffset: number;
	sparse: boolean;
}

interface TarLinkStorage {
	type: "tar-link";
	targetPath: string;
}

interface ZipStorage {
	type: "zip";
	source: ByteSource;
	compressedSize: number;
	compression: number;
	flags: number;
	localHeaderOffset: number;
}

type EntryStorage = TarStorage | TarLinkStorage | ZipStorage;

interface ArchiveIndexEntry extends ArchiveNode {
	storage?: EntryStorage;
}

function normalizeArchiveLookupPath(rawPath?: string): string | undefined {
	if (!rawPath) return "";

	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	return normalizedParts.join("/");
}

function normalizeArchiveEntryPath(rawPath: string): string | undefined {
	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) return undefined;
	return normalizedParts.join("/");
}

function isArchiveDirectoryName(rawPath: string): boolean {
	return rawPath.endsWith("/") || rawPath.endsWith("\\");
}

function upsertArchiveEntry(
	map: Map<string, ArchiveIndexEntry>,
	entry: ArchiveIndexEntry,
): ArchiveIndexEntry | undefined {
	const existing = map.get(entry.path);
	if (!existing) {
		map.set(entry.path, entry);
		return entry;
	}

	if (existing.isDirectory && !entry.isDirectory) {
		map.set(entry.path, entry);
		return entry;
	}

	if (!existing.isDirectory && entry.isDirectory) {
		return undefined;
	}

	// Same-kind duplicate: the later record wins (tar append/update semantics,
	// matching system tar extraction and whole-archive materialization), while
	// earlier metadata fills any gaps the newer record leaves.
	const merged = {
		...entry,
		mtimeMs: entry.mtimeMs ?? existing.mtimeMs,
		storage: entry.storage ?? existing.storage,
	};
	map.set(entry.path, merged);
	return merged;
}

function ensureParentDirectories(map: Map<string, ArchiveIndexEntry>): void {
	for (const entry of [...map.values()]) {
		const parts = entry.path.split("/");
		const stop = parts.length - 1;
		for (let index = 1; index <= stop; index++) {
			const dirPath = parts.slice(0, index).join("/");
			if (!dirPath || map.has(dirPath)) continue;
			map.set(dirPath, {
				path: dirPath,
				isDirectory: true,
				size: 0,
			});
		}
	}
}

/**
 * Extensions that are ZIP containers under a different name — JVM (`.jar`,
 * `.war`, `.ear`) and Android (`.apk`) packages are all ZIP archives. Treated
 * as `zip` for member read/list and whole-archive rewrite.
 */
const ZIP_ALIAS_EXTENSIONS = ["jar", "war", "ear", "apk"] as const;

/**
 * Regex alternation of every recognized archive extension, longest first so
 * `.tar.gz` wins over `.tar`. Shared with `parseArchivePathCandidates` as its
 * split pattern so extension recognition and path splitting never drift.
 */
const ARCHIVE_EXTENSION_ALTERNATION = ["tar\\.gz", "tgz", "zip", "tar", ...ZIP_ALIAS_EXTENSIONS].join("|");

/** Infer an archive format from a filesystem path's extension. */
export function archiveFormatFromPath(filePath: string): ArchiveFormat | undefined {
	const normalized = filePath.toLowerCase();
	if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) return "tar.gz";
	if (normalized.endsWith(".tar")) return "tar";
	if (normalized.endsWith(".zip")) return "zip";
	if (ZIP_ALIAS_EXTENSIONS.some(ext => normalized.endsWith(`.${ext}`))) return "zip";
	return undefined;
}

export function formatArchiveEntryLines(entries: readonly ArchiveDirectoryEntry[]): string[] {
	return entries.map(entry => {
		if (entry.isDirectory) return `${entry.name}/`;

		const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
		return `${entry.name}${sizeSuffix}`;
	});
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_EOCD_MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_EOCD_LOCATOR_LENGTH = 20;
const ZIP_STORED_COMPRESSION = 0;
const ZIP_DEFLATE_COMPRESSION = 8;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_UINT32_RANGE = 0x100000000;

interface ZipCentralDirectoryInfo {
	entries: number;
	offset: number;
	size: number;
}

interface Zip64EntryValues {
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	diskStart: number;
}

interface Zip64EntryPlaceholders {
	compressedSize: boolean;
	uncompressedSize: boolean;
	localHeaderOffset: boolean;
	diskStart: boolean;
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function bytesMatchAscii(bytes: Uint8Array, offset: number, value: string): boolean {
	if (bytes.byteLength < offset + value.length) return false;
	for (let index = 0; index < value.length; index++) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat | undefined {
	if (bytes.byteLength >= 4) {
		const signature = readUInt32LE(bytes, 0);
		if (
			signature === ZIP_LOCAL_FILE_HEADER_SIGNATURE ||
			signature === ZIP_EOCD_SIGNATURE ||
			signature === ZIP_DATA_DESCRIPTOR_SIGNATURE
		) {
			return "zip";
		}
	}

	if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
		return "tar.gz";
	}

	if (bytesMatchAscii(bytes, 257, "ustar")) {
		return "tar";
	}

	return undefined;
}

function readUInt64LEAsNumber(bytes: Uint8Array, offset: number): number {
	const value = readUInt32LE(bytes, offset) + readUInt32LE(bytes, offset + 4) * ZIP_UINT32_RANGE;
	if (!Number.isSafeInteger(value)) {
		throw new ToolError("ZIP archive uses offsets or sizes too large to read safely");
	}
	return value;
}

function findEndOfCentralDirectory(tail: Uint8Array): number {
	for (let offset = tail.byteLength - ZIP_EOCD_MIN_LENGTH; offset >= 0; offset--) {
		if (readUInt32LE(tail, offset) !== ZIP_EOCD_SIGNATURE) continue;
		const commentLength = readUInt16LE(tail, offset + 20);
		if (offset + ZIP_EOCD_MIN_LENGTH + commentLength === tail.byteLength) return offset;
	}

	throw new ToolError("Invalid ZIP archive: missing end of central directory");
}

async function readZip64CentralDirectoryInfo(
	source: ByteSource,
	tail: Uint8Array,
	tailStart: number,
	eocdOffset: number,
): Promise<ZipCentralDirectoryInfo | undefined> {
	const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_LENGTH;
	if (locatorOffset < 0) return undefined;

	const locator =
		locatorOffset >= tailStart
			? tail.subarray(locatorOffset - tailStart, locatorOffset - tailStart + ZIP64_EOCD_LOCATOR_LENGTH)
			: await source.read(locatorOffset, eocdOffset);
	if (readUInt32LE(locator, 0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return undefined;

	const zip64EocdDisk = readUInt32LE(locator, 4);
	const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
	const totalDisks = readUInt32LE(locator, 16);
	if (zip64EocdDisk !== 0 || totalDisks > 1) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	const record = await source.read(zip64EocdOffset, zip64EocdOffset + 56);
	if (readUInt32LE(record, 0) !== ZIP64_EOCD_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 end of central directory");
	}
	if (readUInt32LE(record, 16) !== 0 || readUInt32LE(record, 20) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	return {
		entries: readUInt64LEAsNumber(record, 32),
		size: readUInt64LEAsNumber(record, 40),
		offset: readUInt64LEAsNumber(record, 48),
	};
}

async function readZipCentralDirectoryInfo(source: ByteSource): Promise<ZipCentralDirectoryInfo> {
	const fileSize = source.size;
	if (fileSize < ZIP_EOCD_MIN_LENGTH) {
		throw new ToolError("Invalid ZIP archive: missing end of central directory");
	}

	const tailLength = Math.min(fileSize, ZIP_EOCD_MIN_LENGTH + ZIP_EOCD_MAX_COMMENT_LENGTH);
	const tailStart = fileSize - tailLength;
	const tail = await source.read(tailStart, fileSize);
	const eocdIndex = findEndOfCentralDirectory(tail);
	const eocdOffset = tailStart + eocdIndex;

	if (readUInt16LE(tail, eocdIndex + 4) !== 0 || readUInt16LE(tail, eocdIndex + 6) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	let entries = readUInt16LE(tail, eocdIndex + 10);
	let size = readUInt32LE(tail, eocdIndex + 12);
	let offset = readUInt32LE(tail, eocdIndex + 16);
	const needsZip64 = entries === ZIP_UINT16_MAX || size === ZIP_UINT32_MAX || offset === ZIP_UINT32_MAX;
	const zip64Info = await readZip64CentralDirectoryInfo(source, tail, tailStart, eocdOffset);
	if (zip64Info) {
		({ entries, size, offset } = zip64Info);
	} else if (needsZip64) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 central directory metadata");
	}

	if (offset + size > fileSize) {
		throw new ToolError("Invalid ZIP archive: central directory exceeds file size");
	}

	return { entries, offset, size };
}

function readZip64EntryValues(
	extra: Uint8Array,
	placeholders: Zip64EntryPlaceholders,
	current: Zip64EntryValues,
): Zip64EntryValues {
	if (
		!placeholders.compressedSize &&
		!placeholders.uncompressedSize &&
		!placeholders.localHeaderOffset &&
		!placeholders.diskStart
	) {
		return current;
	}

	let offset = 0;
	while (offset + 4 <= extra.byteLength) {
		const headerId = readUInt16LE(extra, offset);
		const dataSize = readUInt16LE(extra, offset + 2);
		const dataStart = offset + 4;
		const dataEnd = dataStart + dataSize;
		if (dataEnd > extra.byteLength) {
			throw new ToolError("Invalid ZIP archive: malformed extra field");
		}

		if (headerId === 0x0001) {
			let cursor = dataStart;
			let uncompressedSize = current.uncompressedSize;
			let compressedSize = current.compressedSize;
			let localHeaderOffset = current.localHeaderOffset;
			let diskStart = current.diskStart;

			if (placeholders.uncompressedSize) {
				if (cursor + 8 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				uncompressedSize = readUInt64LEAsNumber(extra, cursor);
				cursor += 8;
			}
			if (placeholders.compressedSize) {
				if (cursor + 8 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				compressedSize = readUInt64LEAsNumber(extra, cursor);
				cursor += 8;
			}
			if (placeholders.localHeaderOffset) {
				if (cursor + 8 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				localHeaderOffset = readUInt64LEAsNumber(extra, cursor);
				cursor += 8;
			}
			if (placeholders.diskStart) {
				if (cursor + 4 > dataEnd) throw new ToolError("Invalid ZIP archive: malformed ZIP64 extra field");
				diskStart = readUInt32LE(extra, cursor);
			}

			return { compressedSize, uncompressedSize, localHeaderOffset, diskStart };
		}

		offset = dataEnd;
	}

	throw new ToolError("Invalid ZIP archive: missing ZIP64 extra field");
}

function parseZipCentralDirectory(
	source: ByteSource,
	centralDirectory: Uint8Array,
	expectedEntries: number,
): ArchiveIndexEntry[] {
	const entries: ArchiveIndexEntry[] = [];
	let offset = 0;

	for (let index = 0; index < expectedEntries; index++) {
		if (offset + 46 > centralDirectory.byteLength) {
			throw new ToolError("Invalid ZIP archive: truncated central directory");
		}
		if (readUInt32LE(centralDirectory, offset) !== ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
			throw new ToolError("Invalid ZIP archive: malformed central directory");
		}

		const flags = readUInt16LE(centralDirectory, offset + 8);
		const compression = readUInt16LE(centralDirectory, offset + 10);
		const compressedSizeRaw = readUInt32LE(centralDirectory, offset + 20);
		const uncompressedSizeRaw = readUInt32LE(centralDirectory, offset + 24);
		const fileNameLength = readUInt16LE(centralDirectory, offset + 28);
		const extraLength = readUInt16LE(centralDirectory, offset + 30);
		const commentLength = readUInt16LE(centralDirectory, offset + 32);
		const diskStartRaw = readUInt16LE(centralDirectory, offset + 34);
		const localHeaderOffsetRaw = readUInt32LE(centralDirectory, offset + 42);
		const nameStart = offset + 46;
		const extraStart = nameStart + fileNameLength;
		const entryEnd = extraStart + extraLength + commentLength;
		if (entryEnd > centralDirectory.byteLength) {
			throw new ToolError("Invalid ZIP archive: truncated central directory entry");
		}

		const useLegacyEncoding = (flags & ZIP_UTF8_FLAG) === 0;
		const rawPath = (useLegacyEncoding ? LEGACY_NAME_DECODER : UTF8_DECODER).decode(
			centralDirectory.subarray(nameStart, extraStart),
		);
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (normalizedPath) {
			const values = readZip64EntryValues(
				centralDirectory.subarray(extraStart, extraStart + extraLength),
				{
					compressedSize: compressedSizeRaw === ZIP_UINT32_MAX,
					uncompressedSize: uncompressedSizeRaw === ZIP_UINT32_MAX,
					localHeaderOffset: localHeaderOffsetRaw === ZIP_UINT32_MAX,
					diskStart: diskStartRaw === ZIP_UINT16_MAX,
				},
				{
					compressedSize: compressedSizeRaw,
					uncompressedSize: uncompressedSizeRaw,
					localHeaderOffset: localHeaderOffsetRaw,
					diskStart: diskStartRaw,
				},
			);
			if (values.diskStart !== 0) {
				throw new ToolError("Multi-disk ZIP archives are not supported");
			}

			const isDirectory = isArchiveDirectoryName(rawPath);
			entries.push({
				path: normalizedPath,
				isDirectory,
				size: isDirectory ? 0 : values.uncompressedSize,
				storage: isDirectory
					? undefined
					: {
							type: "zip",
							source,
							compressedSize: values.compressedSize,
							compression,
							flags,
							localHeaderOffset: values.localHeaderOffset,
						},
			});
		}

		offset = entryEnd;
	}

	return entries;
}

/** Decode a single ZIP member's already-read payload, bounded to its declared size. */
function decodeZipMember(compressed: Uint8Array, compression: number, declaredSize: number): Uint8Array {
	if (compression === ZIP_STORED_COMPRESSION) {
		return compressed;
	}
	if (compression !== ZIP_DEFLATE_COMPRESSION) {
		throw new ToolError(`Unsupported ZIP compression method: ${compression}`);
	}
	try {
		return inflateRaw(compressed, declaredSize);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
}

async function readZipFileBytes(storage: ZipStorage, uncompressedSize: number): Promise<Uint8Array> {
	if ((storage.flags & ZIP_ENCRYPTED_FLAG) !== 0) {
		throw new ToolError("Encrypted ZIP entries are not supported");
	}

	const localHeader = await storage.source.read(storage.localHeaderOffset, storage.localHeaderOffset + 30);
	if (readUInt32LE(localHeader, 0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: malformed local file header");
	}

	const fileNameLength = readUInt16LE(localHeader, 26);
	const extraLength = readUInt16LE(localHeader, 28);
	const dataStart = storage.localHeaderOffset + 30 + fileNameLength + extraLength;
	const compressedBytes = await storage.source.read(dataStart, dataStart + storage.compressedSize);
	return decodeZipMember(compressedBytes, storage.compression, uncompressedSize);
}

const TAR_BLOCK_SIZE = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LENGTH = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;
const TAR_MTIME_OFFSET = 136;
const TAR_MTIME_LENGTH = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_LENGTH = 8;
const TAR_TYPEFLAG_OFFSET = 156;
const TAR_LINKNAME_OFFSET = 157;
const TAR_LINKNAME_LENGTH = 100;
const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC = "ustar\0";
const TAR_VERSION_OFFSET = 263;
const TAR_VERSION = "00";
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LENGTH = 155;
// Old-GNU sparse header: `isextended` flag inside the main header and inside
// each 512-byte sparse-map continuation block that follows it.
const TAR_GNU_SPARSE_ISEXTENDED_OFFSET = 482;
const TAR_GNU_SPARSE_CONT_ISEXTENDED_OFFSET = 504;
// PATH_MAX-style bound on member paths and link targets. Real archives never
// exceed it (system tar cannot extract them), and it caps every prefix walk
// below so crafted multi-hundred-KiB PAX paths cannot pin the CPU.
const TAR_MAX_PATH_BYTES = 4096;
const TAR_MAX_PAX_NUMERIC_BYTES = 32;
const TAR_ERROR_PATH_PREVIEW_BYTES = 256;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const TAR_TEXT_DECODER = new TextDecoder();

/**
 * Decompress a gzip stream in-process, bounded to the tar archive cap so a
 * gzip bomb cannot inflate without limit. Non-gzip input passes through.
 */
function gunzipIfNeeded(bytes: Uint8Array): Uint8Array {
	if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
		return new Uint8Array(zlib.gunzipSync(bytes, { maxOutputLength: MAX_TAR_ARCHIVE_BYTES }));
	}
	return bytes;
}

/** Read a NUL-terminated tar header string, clamped to the buffer bounds. */
function readTarString(buffer: Uint8Array, offset: number, length: number): string {
	const limit = Math.min(offset + length, buffer.length);
	let end = offset;
	while (end < limit && buffer[end] !== 0) end++;
	return TAR_TEXT_DECODER.decode(buffer.subarray(offset, end));
}

function tarBytesEqualAscii(bytes: Uint8Array, value: string): boolean {
	return bytes.byteLength === value.length && bytesMatchAscii(bytes, 0, value);
}

function isUstarHeader(buffer: Uint8Array, offset: number): boolean {
	const magicOffset = offset + TAR_MAGIC_OFFSET;
	const versionOffset = offset + TAR_VERSION_OFFSET;
	return bytesMatchAscii(buffer, magicOffset, TAR_MAGIC) && bytesMatchAscii(buffer, versionOffset, TAR_VERSION);
}

function assertTarPathBytes(size: number, field: string): void {
	if (size > TAR_MAX_PATH_BYTES) {
		throw new ToolError(`Archive ${field} exceeds ${TAR_MAX_PATH_BYTES} bytes`);
	}
}

function assertTarPathString(value: string, field: string): void {
	assertTarPathBytes(Buffer.byteLength(value, "utf-8"), field);
}

function formatTarPathForError(value: string): string {
	if (Buffer.byteLength(value, "utf-8") <= TAR_ERROR_PATH_PREVIEW_BYTES) return value;

	let end = 0;
	let size = 0;
	for (const char of value) {
		const charSize = Buffer.byteLength(char, "utf-8");
		if (size + charSize > TAR_ERROR_PATH_PREVIEW_BYTES - 3) break;
		end += char.length;
		size += charSize;
	}
	return `${value.slice(0, end)}...`;
}

function readTarMetadataPath(data: Uint8Array, field: string): string {
	const nul = data.indexOf(0);
	const value = data.subarray(0, nul === -1 ? data.byteLength : nul);
	assertTarPathBytes(value.byteLength, field);
	return TAR_TEXT_DECODER.decode(value);
}

function readPaxPath(data: Uint8Array, field: string): string {
	assertTarPathBytes(data.byteLength, field);
	return TAR_TEXT_DECODER.decode(data);
}

/**
 * Read a tar numeric header field: GNU base-256 (high bit set) or the usual
 * NUL/space-padded octal. GNU's binary form reserves its high bit as a marker
 * and stores a signed two's-complement value in the remaining bits.
 */
function readTarNumeric(buffer: Uint8Array, offset: number, length: number): number {
	if (offset < 0 || length <= 0 || offset + length > buffer.length) {
		throw new ToolError("Invalid tar numeric field");
	}

	const first = buffer[offset]!;
	let value = 0n;
	if ((first & 0x80) !== 0) {
		value = BigInt(first & 0x7f);
		for (let index = 1; index < length; index++) {
			value = (value << 8n) | BigInt(buffer[offset + index]!);
		}
		if ((first & 0x40) !== 0) {
			value -= 1n << BigInt(length * 8 - 1);
		}
	} else {
		for (let index = 0; index < length; index++) {
			const byte = buffer[offset + index]!;
			if (byte >= 0x30 && byte <= 0x37) {
				value = value * 8n + BigInt(byte - 0x30);
			}
		}
	}
	return Number(value);
}

function readTarSize(buffer: Uint8Array, offset: number): number {
	const size = readTarNumeric(buffer, offset, TAR_SIZE_LENGTH);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ToolError("Invalid tar member size");
	}
	return size;
}

function tarPaddedSize(size: number): number {
	const remainder = size % TAR_BLOCK_SIZE;
	const padded = size + (remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder);
	if (!Number.isSafeInteger(padded)) {
		throw new ToolError("Invalid tar member size");
	}
	return padded;
}

function parsePaxSize(value: string, field: string): number {
	if (!/^\d+$/.test(value)) {
		throw new ToolError(`Invalid tar ${field}`);
	}
	const size = Number(value);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ToolError(`Invalid tar ${field}`);
	}
	return size;
}

function isTarZeroBlock(buffer: Uint8Array, offset: number): boolean {
	for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
		if (buffer[offset + i] !== 0) return false;
	}
	return true;
}

/** Verify a tar header block's checksum (both unsigned and signed conventions). */
function tarChecksumMatches(buffer: Uint8Array, offset: number): boolean {
	const stored = readTarNumeric(buffer, offset + TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_LENGTH);
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
		const inChecksum = i >= TAR_CHECKSUM_OFFSET && i < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_LENGTH;
		const byte = inChecksum ? 0x20 : (buffer[offset + i] ?? 0);
		unsigned += byte;
		signed += (byte << 24) >> 24;
	}
	return stored === unsigned || stored === signed;
}

/**
 * Sentinel key marking that any `GNU.sparse.*` record appeared in a PAX
 * header. A real record cannot shadow it: PAX sparse keys always carry a
 * suffix after the trailing dot.
 */
const PAX_SPARSE_MARKER = "GNU.sparse.";

/**
 * Parse a PAX extended-header payload into its `key → value` records. Only
 * exactly consumed keys are retained (plus the sparse marker), so a crafted
 * header packed with millions of unique records — including `GNU.sparse.*`
 * junk — cannot amplify into heap.
 */
function parsePaxRecords(
	data: Uint8Array,
	onRecord?: (key: Uint8Array, value: Uint8Array) => void,
): Map<string, string> {
	const attrs = new Map<string, string>();
	let pos = 0;
	while (pos < data.length) {
		let space = pos;
		while (space < data.length && data[space] !== 0x20) space++;
		if (space === pos || space >= data.length || space - pos > 16) {
			throw new ToolError("Invalid tar PAX record");
		}

		let length = 0;
		for (let index = pos; index < space; index++) {
			const byte = data[index]!;
			if (byte < 0x30 || byte > 0x39) {
				throw new ToolError("Invalid tar PAX record");
			}
			length = length * 10 + (byte - 0x30);
			if (length > data.length - pos) {
				throw new ToolError("Invalid tar PAX record");
			}
		}
		if (length <= 0 || pos + length > data.length || data[pos + length - 1] !== 0x0a) {
			throw new ToolError("Invalid tar PAX record");
		}

		const record = data.subarray(space + 1, pos + length - 1);
		const eq = record.indexOf(0x3d);
		if (eq >= 0) {
			const key = record.subarray(0, eq);
			const value = record.subarray(eq + 1);
			onRecord?.(key, value);
			if (bytesMatchAscii(key, 0, PAX_SPARSE_MARKER)) {
				attrs.set(PAX_SPARSE_MARKER, value.byteLength === 0 ? "" : "1");
				if (tarBytesEqualAscii(key, "GNU.sparse.name")) {
					attrs.set("GNU.sparse.name", readPaxPath(value, "PAX sparse path"));
				} else if (tarBytesEqualAscii(key, "GNU.sparse.realsize")) {
					if (value.byteLength > TAR_MAX_PAX_NUMERIC_BYTES) {
						throw new ToolError("Invalid tar sparse real size");
					}
					attrs.set("GNU.sparse.realsize", TAR_TEXT_DECODER.decode(value));
				}
			} else if (tarBytesEqualAscii(key, "path") || tarBytesEqualAscii(key, "linkpath")) {
				const field = tarBytesEqualAscii(key, "path") ? "PAX path" : "PAX link target";
				attrs.set(field === "PAX path" ? "path" : "linkpath", readPaxPath(value, field));
			} else if (tarBytesEqualAscii(key, "size")) {
				if (value.byteLength > TAR_MAX_PAX_NUMERIC_BYTES) {
					throw new ToolError("Invalid tar member size");
				}
				attrs.set("size", TAR_TEXT_DECODER.decode(value));
			}
		}
		pos += length;
	}
	return attrs;
}

function applyGlobalPax(globalPax: Map<string, string>, update: ReadonlyMap<string, string>): void {
	for (const [key, value] of update) {
		if (value === "") {
			globalPax.delete(key);
		} else {
			globalPax.set(key, value);
		}
	}
}

function paxAttribute(
	globalPax: ReadonlyMap<string, string>,
	localPax: ReadonlyMap<string, string> | undefined,
	key: string,
): string | undefined {
	if (localPax?.has(key)) return localPax.get(key);
	return globalPax.get(key);
}

function paxDeclaresSparse(
	globalPax: ReadonlyMap<string, string>,
	localPax: ReadonlyMap<string, string> | undefined,
): boolean {
	return paxAttribute(globalPax, localPax, PAX_SPARSE_MARKER) === "1";
}

interface PendingTarLink {
	kind: "hard link" | "symlink";
	targetPath: string;
}

function indexOfAscii(bytes: Uint8Array, value: string, start: number): number {
	for (let offset = start; offset <= bytes.byteLength - value.length; offset++) {
		if (bytesMatchAscii(bytes, offset, value)) return offset;
	}
	return -1;
}

function normalizeOldGnuName(value: string, field: string): string {
	const portable = value.replace(/\\/g, "/");
	if (path.posix.isAbsolute(portable)) {
		throw new ToolError(`Invalid old-GNU ${field}`);
	}
	const normalized = normalizeArchiveEntryPath(portable);
	if (!normalized) {
		throw new ToolError(`Invalid old-GNU ${field}`);
	}
	assertTarPathString(normalized, field);
	return normalized;
}

function renameOldGnuEntries(
	entries: Map<string, ArchiveIndexEntry>,
	pendingLinks: Map<ArchiveIndexEntry, PendingTarLink>,
	fromPath: string,
	toPath: string,
): void {
	const moved = [...entries.entries()].filter(
		([entryPath]) => entryPath === fromPath || entryPath.startsWith(`${fromPath}/`),
	);
	if (moved.length === 0) return;

	for (const [entryPath] of moved) entries.delete(entryPath);
	for (const [entryPath, entry] of moved) {
		const suffix = entryPath.slice(fromPath.length);
		const nextPath = `${toPath}${suffix}`;
		assertTarPathString(nextPath, "member path");
		entry.path = nextPath;
		const replaced = entries.get(nextPath);
		if (replaced) pendingLinks.delete(replaced);
		entries.set(nextPath, entry);
	}
	for (const pending of pendingLinks.values()) {
		if (pending.kind !== "hard link") continue;
		if (pending.targetPath === fromPath || pending.targetPath.startsWith(`${fromPath}/`)) {
			pending.targetPath = `${toPath}${pending.targetPath.slice(fromPath.length)}`;
		}
	}
}

function applyOldGnuNameRecords(
	data: Uint8Array,
	entries: Map<string, ArchiveIndexEntry>,
	pendingLinks: Map<ArchiveIndexEntry, PendingTarLink>,
): void {
	const terminator = data.indexOf(0);
	const end = terminator === -1 ? data.byteLength : terminator;
	let start = 0;
	while (start < end) {
		const newline = data.indexOf(0x0a, start);
		const lineEnd = newline === -1 || newline > end ? end : newline;
		const line = data.subarray(start, lineEnd);
		if (bytesMatchAscii(line, 0, "Rename ")) {
			const separator = indexOfAscii(line, " to ", "Rename ".length);
			if (separator === -1) {
				throw new ToolError("Invalid old-GNU name record");
			}
			const source = readTarMetadataPath(line.subarray("Rename ".length, separator), "old-GNU source path");
			const targetEnd = line[line.byteLength - 1] === 0x2f ? line.byteLength - 1 : line.byteLength;
			const target = readTarMetadataPath(line.subarray(separator + " to ".length, targetEnd), "old-GNU target path");
			renameOldGnuEntries(
				entries,
				pendingLinks,
				normalizeOldGnuName(source, "source path"),
				normalizeOldGnuName(target, "target path"),
			);
		}
		start = lineEnd + 1;
	}
}

/**
 * Index a tar (optionally gzip-compressed) archive entirely in TypeScript.
 * Handles ustar/GNU/pax layouts, `./`-prefixed and `prefix`-split names, GNU
 * `@LongLink` names/link targets, pax `path`/`linkpath`/`size` overrides, and
 * hard links. This deliberately avoids `Bun.Archive`/libarchive, whose
 * internal allocation-failure path calls `abort()` and takes down the whole
 * process on a crafted or oversized member (#4774). Sparse members are
 * indexed but flagged; reading their bytes throws a catchable `ToolError`
 * rather than returning a misassembled payload.
 */
function readTarEntries(rawBytes: Uint8Array): ArchiveIndexEntry[] {
	assertTarArchiveSize(rawBytes.byteLength);

	let buffer: Uint8Array;
	try {
		buffer = gunzipIfNeeded(rawBytes);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	assertTarArchiveSize(buffer.byteLength);

	const entries = new Map<string, ArchiveIndexEntry>();
	const pendingLinks = new Map<ArchiveIndexEntry, PendingTarLink>();
	const addEntry = (entry: ArchiveIndexEntry, pendingLink?: PendingTarLink): void => {
		const existing = entries.get(entry.path);
		const indexed = upsertArchiveEntry(entries, entry);
		if (!indexed) return;
		if (existing) pendingLinks.delete(existing);
		if (pendingLink) pendingLinks.set(indexed, pendingLink);
	};
	let offset = 0;
	let longName: string | undefined;
	let longLink: string | undefined;
	let localPax: Map<string, string> | undefined;
	const globalPax = new Map<string, string>();
	// A valid tar ends with a zero block. Track whether the fully buffered input
	// reaches one so truncated archives never expose a partial index.
	let sawTerminator = false;

	while (offset + TAR_BLOCK_SIZE <= buffer.length) {
		if (isTarZeroBlock(buffer, offset)) {
			sawTerminator = true;
			break;
		}
		if (!tarChecksumMatches(buffer, offset)) {
			throw new ToolError("Invalid or corrupt tar archive header");
		}

		const headerOffset = offset;
		const typeFlag = String.fromCharCode(buffer[headerOffset + TAR_TYPEFLAG_OFFSET] || 0x30);
		let size = readTarSize(buffer, headerOffset + TAR_SIZE_OFFSET);
		let name = readTarString(buffer, headerOffset + TAR_NAME_OFFSET, TAR_NAME_LENGTH);
		if (isUstarHeader(buffer, headerOffset)) {
			const prefix = readTarString(buffer, headerOffset + TAR_PREFIX_OFFSET, TAR_PREFIX_LENGTH);
			if (prefix) name = `${prefix}/${name}`;
		}
		let linkName = readTarString(buffer, headerOffset + TAR_LINKNAME_OFFSET, TAR_LINKNAME_LENGTH);
		const mtime = readTarNumeric(buffer, headerOffset + TAR_MTIME_OFFSET, TAR_MTIME_LENGTH);

		offset += TAR_BLOCK_SIZE;
		const dataBlocks = tarPaddedSize(size);
		if (dataBlocks > buffer.length - offset) {
			throw new ToolError("Archive member data is truncated");
		}
		const data = buffer.subarray(offset, offset + size);

		// Metadata-only headers: consume their payload, remember it for the next
		// file header, then continue.
		if (typeFlag === "L") {
			longName = readTarMetadataPath(data, "GNU long path");
			offset += dataBlocks;
			continue;
		}
		if (typeFlag === "K") {
			longLink = readTarMetadataPath(data, "GNU long link target");
			offset += dataBlocks;
			continue;
		}
		if (typeFlag === "N") {
			applyOldGnuNameRecords(data, entries, pendingLinks);
			offset += dataBlocks;
			continue;
		}
		if (typeFlag === "x" || typeFlag === "X") {
			localPax = parsePaxRecords(data);
			offset += dataBlocks;
			continue;
		}
		if (typeFlag === "g") {
			applyGlobalPax(globalPax, parsePaxRecords(data));
			offset += dataBlocks;
			continue;
		}

		if (longName !== undefined) name = longName;
		if (longLink !== undefined) linkName = longLink;
		const paxPath = paxAttribute(globalPax, localPax, "path");
		if (paxPath !== undefined) name = paxPath;
		const paxLinkPath = paxAttribute(globalPax, localPax, "linkpath");
		if (paxLinkPath !== undefined) linkName = paxLinkPath;
		const paxSize = paxAttribute(globalPax, localPax, "size");
		if (paxSize !== undefined) size = parsePaxSize(paxSize, "member size");
		// GNU 1.0 sparse PAX stores the user-visible path in a dedicated record
		// while the file header carries an internal `GNUSparseFile.NNN` name.
		// Surface the real name so listings and `read <archive>:<name>` resolve
		// the member (its bytes are still rejected as sparse below). The header
		// `size` remains the on-disk stored length that drives offset advance
		// and truncation; `GNU.sparse.realsize` is display-only.
		const paxSparseName = paxAttribute(globalPax, localPax, "GNU.sparse.name");
		if (paxSparseName !== undefined) name = paxSparseName;
		let displaySize = size;
		const paxSparseRealSize = paxAttribute(globalPax, localPax, "GNU.sparse.realsize");
		if (paxSparseRealSize !== undefined) displaySize = parsePaxSize(paxSparseRealSize, "sparse real size");
		const sparse = typeFlag === "S" || paxDeclaresSparse(globalPax, localPax);
		// Old-GNU sparse members chain extra 512-byte sparse-map blocks between
		// the main header and the stored data; they are not counted in `size`.
		// Consume the chain so the data offset and the next header line up.
		if (typeFlag === "S" && buffer[headerOffset + TAR_GNU_SPARSE_ISEXTENDED_OFFSET] === 1) {
			let extended = true;
			while (extended) {
				if (offset + TAR_BLOCK_SIZE > buffer.length) {
					throw new ToolError("Archive sparse metadata is truncated");
				}
				extended = buffer[offset + TAR_GNU_SPARSE_CONT_ISEXTENDED_OFFSET] === 1;
				offset += TAR_BLOCK_SIZE;
			}
		}
		const dataOffset = offset;
		const memberDataBlocks = tarPaddedSize(size);
		if (memberDataBlocks > buffer.length - dataOffset) {
			throw new ToolError(`Archive member '${formatTarPathForError(name)}' is truncated`);
		}
		offset += memberDataBlocks;
		longName = undefined;
		longLink = undefined;
		localPax = undefined;

		const isDirectory = typeFlag === "5" || name.endsWith("/");
		const normalizedPath = normalizeArchiveEntryPath(name);
		if (!normalizedPath) continue;
		assertTarPathString(normalizedPath, "member path");
		const scaledMtime = mtime * 1000;
		const mtimeMs =
			mtime !== 0 && Number.isSafeInteger(mtime) && Number.isSafeInteger(scaledMtime) ? scaledMtime : undefined;

		if (isDirectory) {
			addEntry({ path: normalizedPath, isDirectory: true, size: 0, mtimeMs });
			continue;
		}
		if (typeFlag === "1" || typeFlag === "2") {
			const kind = typeFlag === "1" ? "hard link" : "symlink";
			const portableLinkName = linkName.replace(/\\/g, "/");
			assertTarPathString(portableLinkName, "link target");
			// Symlinks resolve relative to their own directory; a target that
			// stays inside the archive normalizes to a member path or "" (the
			// archive root, e.g. `current -> .`). `undefined` means the target
			// escapes the root (or is absolute) and is kept as a dangling link.
			const targetPath =
				typeFlag === "1"
					? normalizeArchiveEntryPath(portableLinkName)
					: path.posix.isAbsolute(portableLinkName)
						? undefined
						: normalizeArchiveLookupPath(path.posix.join(path.posix.dirname(normalizedPath), portableLinkName));
			const entry: ArchiveIndexEntry = {
				path: normalizedPath,
				isDirectory: false,
				size: 0,
				mtimeMs,
			};
			if (targetPath === undefined || Buffer.byteLength(targetPath, "utf-8") > TAR_MAX_PATH_BYTES) {
				if (kind === "hard link") {
					throw new ToolError(
						`Archive hard link '${formatTarPathForError(normalizedPath)}' has an invalid target`,
					);
				}
				entry.storage = { type: "tar-link", targetPath: portableLinkName };
				addEntry(entry);
				continue;
			}
			addEntry(entry, { kind, targetPath });
			continue;
		}
		// Only regular-file typeflags carry inline data we can slice.
		if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "7" && typeFlag !== "S") continue;
		addEntry({
			path: normalizedPath,
			isDirectory: false,
			size: displaySize,
			mtimeMs,
			storage: { type: "tar", buffer, dataOffset, sparse },
		});
	}

	// Fully buffered tar reads must reach an end-of-archive zero block. Without
	// one, even complete entries form only a partial listing: later members may
	// have been cut off by a truncated download. For gzip-shaped non-tar input,
	// this also gives fetch a catchable error so it can fall back to binary.
	if (!sawTerminator) {
		throw new ToolError("Not a valid tar archive: missing terminating zero block");
	}

	// Link records carry no data. Resolve file targets after all headers are
	// indexed; directory symlinks remain one alias node and are traversed lazily
	// by ArchiveReader so N files behind M aliases never inflate the index to
	// N×M entries during a root listing. Resolution is a work queue keyed on
	// blocking links (not a rescan-all fixpoint) so crafted archives with huge
	// link chains stay linear in dependency edges.
	if (pendingLinks.size > 0) {
		const entriesByPath = entries;
		// Every proper ancestor of a member path: O(1) directory-target checks
		// instead of scanning all entries per unresolved link.
		const directoryPrefixes = new Set<string>();
		for (const entry of entriesByPath.values()) {
			const memberPath = entry.path;
			for (let cut = memberPath.lastIndexOf("/"); cut > 0; cut = memberPath.lastIndexOf("/", cut - 1)) {
				const prefix = memberPath.slice(0, cut);
				if (directoryPrefixes.has(prefix)) break;
				directoryPrefixes.add(prefix);
			}
		}
		const unresolved = new Set(pendingLinks.keys());
		// Links deferred behind a still-unclassified link, re-queued when it
		// settles, so a file symlink routed through a directory alias is not
		// misjudged dangling before the alias resolves.
		const dependents = new Map<ArchiveIndexEntry, ArchiveIndexEntry[]>();

		// The first still-unresolved link on `targetPath` (the target itself or
		// any directory on its path), or null when the target is settled.
		const findUnresolvedBlocker = (targetPath: string): ArchiveIndexEntry | null => {
			for (let end = targetPath.length; end > 0; end = targetPath.lastIndexOf("/", end - 1)) {
				const prefixEntry = entriesByPath.get(targetPath.slice(0, end));
				if (prefixEntry && unresolved.has(prefixEntry)) return prefixEntry;
			}
			return null;
		};

		const queue = [...unresolved];
		while (queue.length > 0) {
			const entry = queue.pop()!;
			if (!unresolved.has(entry)) continue;
			const pending = pendingLinks.get(entry)!;

			// Targets may route through directory aliases classified earlier;
			// rewrite before the exact-path lookup. A cyclic alias chain falls
			// through to the dangling-symlink path.
			let blocker = findUnresolvedBlocker(pending.targetPath);
			let targetPath = pending.targetPath;
			if (blocker === null) {
				try {
					targetPath = resolveDirectoryAliasPath(entriesByPath, targetPath);
				} catch {}
				if (targetPath !== pending.targetPath) blocker = findUnresolvedBlocker(targetPath);
			}
			if (blocker !== null && blocker !== entry) {
				const waiting = dependents.get(blocker);
				if (waiting) {
					waiting.push(entry);
				} else {
					dependents.set(blocker, [entry]);
				}
				continue;
			}
			unresolved.delete(entry);
			const settled = dependents.get(entry);
			if (settled) {
				dependents.delete(entry);
				queue.push(...settled);
			}
			if (blocker === entry) {
				// The target passes through the link itself (`a -> a/b`):
				// inherently cyclic, so it can never become a usable alias even
				// when real members exist beneath the target prefix.
				if (pending.kind === "hard link") {
					throw new ToolError(
						`Archive hard link '${formatTarPathForError(entry.path)}' has a cyclic target '${formatTarPathForError(pending.targetPath)}'`,
					);
				}
				entry.storage = { type: "tar-link", targetPath: pending.targetPath };
				continue;
			}

			const target = entriesByPath.get(targetPath);
			if (target?.storage && !target.isDirectory && !unresolved.has(target)) {
				entry.size = target.size;
				entry.storage = target.storage;
				continue;
			}

			// An empty target is the archive root, which is always a directory.
			const targetIsDirectory =
				targetPath === "" || target?.isDirectory === true || directoryPrefixes.has(targetPath);
			if (!targetIsDirectory) {
				if (pending.kind === "symlink") {
					entry.storage = { type: "tar-link", targetPath: pending.targetPath };
					continue;
				}
				const reason = target ? "unreadable member" : "missing member";
				throw new ToolError(
					`Archive hard link '${formatTarPathForError(entry.path)}' targets ${reason} '${formatTarPathForError(pending.targetPath)}'`,
				);
			}
			if (pending.kind === "hard link") {
				throw new ToolError(
					`Archive hard link '${formatTarPathForError(entry.path)}' targets directory '${formatTarPathForError(pending.targetPath)}'`,
				);
			}

			entry.isDirectory = true;
			entry.storage = { type: "tar-link", targetPath: pending.targetPath };
		}
		// Links never dequeued sit in a dependency cycle (a -> b/x, b -> a/y).
		if (unresolved.size > 0) {
			throw new ToolError("Archive contains cyclic or unsupported links");
		}
	}

	return [...entries.values()];
}

/**
 * Slice one indexed tar member's bytes out of the archive buffer. Sparse
 * members cannot be reassembled from a contiguous slice, so reading them throws
 * a catchable error instead of returning corrupt data.
 */
function assertArchiveMemberSize(size: number, memberPath: string): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ToolError(`Archive member '${formatTarPathForError(memberPath)}' has an invalid size`);
	}
	if (size > MAX_ARCHIVE_MEMBER_BYTES) {
		throw new ToolError(
			`Archive member '${formatTarPathForError(memberPath)}' is too large to extract in memory (${formatBytes(size)} > ${formatBytes(MAX_ARCHIVE_MEMBER_BYTES)} limit)`,
		);
	}
}

function extractTarMember(storage: TarStorage, size: number, memberPath: string): Uint8Array {
	assertArchiveMemberSize(size, memberPath);
	if (storage.sparse) {
		throw new ToolError(`Archive member '${formatTarPathForError(memberPath)}' is a sparse file and cannot be read`);
	}
	if (size > storage.buffer.length - storage.dataOffset) {
		throw new ToolError(`Archive member '${formatTarPathForError(memberPath)}' is truncated`);
	}
	return storage.buffer.subarray(storage.dataOffset, storage.dataOffset + size);
}

function throwUnreadableTarLink(storage: TarLinkStorage, memberPath: string): never {
	throw new ToolError(
		`Archive symlink '${formatTarPathForError(memberPath)}' cannot be materialized from target '${formatTarPathForError(storage.targetPath)}'`,
	);
}

/** ELOOP-style bound on directory-alias rewrites during a single path lookup. */
const MAX_LINK_RESOLUTION_DEPTH = 40;

/**
 * Rewrite `archivePath` through directory symlink aliases until it no longer
 * crosses one. Bounded: an exact revisit and an alias chain that keeps growing
 * the path (e.g. a directory symlink targeting its own subtree, `a -> a/b`)
 * both throw a catchable cyclic-symlink error instead of looping forever.
 */
function resolveDirectoryAliasPath(entries: ReadonlyMap<string, ArchiveIndexEntry>, archivePath: string): string {
	let resolvedPath = archivePath;
	const seen = new Set<string>();
	for (let rewrites = 0; !seen.has(resolvedPath); ) {
		seen.add(resolvedPath);
		let replacement: string | undefined;
		for (let end = resolvedPath.length; end > 0; end = resolvedPath.lastIndexOf("/", end - 1)) {
			const entry = entries.get(resolvedPath.slice(0, end));
			if (!entry?.isDirectory || entry.storage?.type !== "tar-link") continue;
			const suffix = resolvedPath.slice(end + 1);
			replacement = suffix
				? entry.storage.targetPath
					? `${entry.storage.targetPath}/${suffix}`
					: suffix
				: entry.storage.targetPath;
			break;
		}
		if (replacement === undefined) return resolvedPath;
		// The bound counts performed rewrites, so a chain of exactly
		// MAX_LINK_RESOLUTION_DEPTH aliases still resolves; only needing one
		// more trips it.
		if (++rewrites > MAX_LINK_RESOLUTION_DEPTH) break;
		resolvedPath = replacement;
	}
	throw new ToolError(`Archive path '${archivePath}' crosses a cyclic symlink`);
}

async function readZipEntries(source: ByteSource): Promise<ArchiveIndexEntry[]> {
	const directoryInfo = await readZipCentralDirectoryInfo(source);
	const centralDirectory = await source.read(directoryInfo.offset, directoryInfo.offset + directoryInfo.size);
	return parseZipCentralDirectory(source, centralDirectory, directoryInfo.entries);
}

/**
 * Split an `archive.ext:inner/path` reference into every plausible
 * `{ archivePath, subPath }` pair, longest archive prefix first. A path may
 * contain more than one archive extension, so each candidate is a guess at
 * where the archive ends and the member portion begins.
 */
export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = new RegExp(`\\.(?:${ARCHIVE_EXTENSION_ALTERNATION})(?=(?::|$))`, "gi");
	const seen = new Set<string>();
	const candidates: ArchivePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = pattern.exec(normalized);
		if (match === null) {
			break;
		}
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}

	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

/**
 * An indexed, read-only view over a single archive. ZIP archives are indexed
 * from the central directory and members are inflated on demand; tar archives
 * are parsed from one in-memory buffer, members are sliced on demand, and
 * directory symlink aliases are traversed lazily.
 */
export class ArchiveReader {
	readonly format: ArchiveFormat;
	#entries = new Map<string, ArchiveIndexEntry>();

	constructor(format: ArchiveFormat, entries: ArchiveIndexEntry[]) {
		this.format = format;
		for (const entry of entries) {
			upsertArchiveEntry(this.#entries, entry);
		}
		ensureParentDirectories(this.#entries);
	}

	getNode(subPath?: string): ArchiveNode | undefined {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) return undefined;
		if (normalizedPath === "") {
			return { path: "", isDirectory: true, size: 0 };
		}

		const resolvedPath = resolveDirectoryAliasPath(this.#entries, normalizedPath);
		if (resolvedPath === "") {
			return { path: normalizedPath, isDirectory: true, size: 0 };
		}
		const entry = this.#entries.get(resolvedPath);
		if (!entry) return undefined;
		return {
			path: normalizedPath,
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		};
	}

	listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) {
			throw new ToolError("Archive path cannot contain '..'");
		}

		const resolvedPath = normalizedPath ? resolveDirectoryAliasPath(this.#entries, normalizedPath) : "";
		if (normalizedPath && resolvedPath !== "") {
			const entry = this.#entries.get(resolvedPath);
			if (!entry) {
				throw new ToolError(`Archive path '${normalizedPath}' not found`);
			}
			if (!entry.isDirectory) {
				throw new ToolError(`Archive path '${normalizedPath}' is not a directory`);
			}
		}

		const sourcePrefix = resolvedPath ? `${resolvedPath}/` : "";
		const children = new Map<string, ArchiveDirectoryEntry>();

		for (const entry of this.#entries.values()) {
			if (resolvedPath) {
				if (!entry.path.startsWith(sourcePrefix) || entry.path === resolvedPath) continue;
			}

			const relativePath = resolvedPath ? entry.path.slice(sourcePrefix.length) : entry.path;
			const nextSegment = relativePath.split("/")[0];
			if (!nextSegment) continue;

			const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
			if (children.has(childPath)) continue;

			const sourceChildPath = resolvedPath ? `${resolvedPath}/${nextSegment}` : nextSegment;
			const childEntry = this.#entries.get(sourceChildPath);
			const isDirectory = childEntry?.isDirectory ?? relativePath.includes("/");
			children.set(childPath, {
				name: nextSegment,
				path: childPath,
				isDirectory,
				size: isDirectory ? 0 : (childEntry?.size ?? entry.size),
				mtimeMs: childEntry?.mtimeMs ?? entry.mtimeMs,
			});
		}

		return [...children.values()].sort((left, right) =>
			left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
		);
	}

	async readFile(subPath: string): Promise<ExtractedArchiveFile> {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (!normalizedPath) {
			throw new ToolError("Archive file path is required");
		}

		const resolvedPath = resolveDirectoryAliasPath(this.#entries, normalizedPath);
		if (resolvedPath === "") {
			throw new ToolError(`Archive path '${normalizedPath}' is a directory`);
		}
		const entry = this.#entries.get(resolvedPath);
		if (!entry) {
			throw new ToolError(`Archive file '${normalizedPath}' not found`);
		}
		if (entry.isDirectory) {
			throw new ToolError(`Archive path '${normalizedPath}' is a directory`);
		}
		if (!entry.storage) {
			throw new ToolError(`Archive file '${normalizedPath}' has no readable storage`);
		}
		assertArchiveMemberSize(entry.size, normalizedPath);

		let bytes: Uint8Array;
		if (entry.storage.type === "tar") {
			bytes = extractTarMember(entry.storage, entry.size, normalizedPath);
		} else if (entry.storage.type === "tar-link") {
			throwUnreadableTarLink(entry.storage, normalizedPath);
		} else {
			bytes = await readZipFileBytes(entry.storage, entry.size);
		}
		return {
			path: normalizedPath,
			isDirectory: false,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			bytes,
		};
	}
}

/**
 * Open an archive for reading. ZIP archives opened from a path are indexed
 * lazily via ranged central-directory reads (members inflate on demand); tar
 * archives and in-memory ZIPs are read from a single buffer.
 */
export async function openArchive(source: ArchiveSource): Promise<ArchiveReader> {
	if (typeof source !== "string" && "bytes" in source) {
		if (source.format === "zip") {
			return new ArchiveReader(source.format, await readZipEntries(memoryByteSource(source.bytes)));
		}
		return new ArchiveReader(source.format, readTarEntries(source.bytes));
	}

	const filePath = typeof source === "string" ? source : source.path;
	const format = typeof source === "string" ? archiveFormatFromPath(filePath) : source.format;
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${filePath}`);
	}
	if (format === "zip") {
		return new ArchiveReader(format, await readZipEntries(fileByteSource(filePath)));
	}

	const file = Bun.file(filePath);
	assertTarArchiveSize(file.size);
	return new ArchiveReader(format, readTarEntries(await file.bytes()));
}

/** Render the top-level entries of an in-memory archive as one line each. */
export async function listArchiveRoot(
	bytes: Uint8Array,
	format: ArchiveFormat,
	opts: { limit?: number } = {},
): Promise<string> {
	const archive = await openArchive({ bytes, format });
	const entries = archive.listDirectory("");
	const limitedEntries = opts.limit !== undefined && opts.limit > 0 ? entries.slice(0, opts.limit) : entries;
	const lines = formatArchiveEntryLines(limitedEntries);
	return lines.length > 0 ? lines.join("\n") : "(empty archive directory)";
}

async function resolveArchiveBytes(source: ArchiveSource): Promise<{ bytes: Uint8Array; format: ArchiveFormat }> {
	if (typeof source !== "string" && "bytes" in source) return source;

	const filePath = typeof source === "string" ? source : source.path;
	const format = typeof source === "string" ? archiveFormatFromPath(filePath) : source.format;
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${filePath}`);
	}
	const file = Bun.file(filePath);
	if (format !== "zip") assertTarArchiveSize(file.size);
	return { bytes: await file.bytes(), format };
}

async function memberToBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
	if (typeof content === "string") return ENCODER.encode(content);
	if (content instanceof Uint8Array) return content;
	return new Uint8Array(await content.arrayBuffer());
}

/**
 * Fully materialize every file member into a `path → content` map: ZIP members
 * are inflated in memory, tar members are sliced from the decoded archive
 * buffer. Use this when you need every entry (rewrite, extract); for browsing
 * or single-member reads prefer `openArchive`, which is lazy for ZIP.
 */
export async function readArchiveEntries(source: ArchiveSource): Promise<Map<string, ArchiveMemberContent>> {
	const { bytes, format } = await resolveArchiveBytes(source);
	const entries = new Map<string, ArchiveMemberContent>();
	if (format === "zip") {
		const unzipped = unzip(bytes);
		for (const name in unzipped) {
			entries.set(name, unzipped[name]!);
		}
		return entries;
	}
	for (const entry of readTarEntries(bytes)) {
		if (entry.isDirectory) {
			if (entry.storage?.type === "tar-link") {
				throwUnreadableTarLink(entry.storage, entry.path);
			}
			continue;
		}
		if (!entry.storage) {
			throw new ToolError(`Archive file '${entry.path}' has no readable storage`);
		}
		if (entry.storage.type === "tar-link") {
			throwUnreadableTarLink(entry.storage, entry.path);
		}
		if (entry.storage.type !== "tar") {
			throw new ToolError(`Archive file '${entry.path}' has invalid tar storage`);
		}
		entries.set(entry.path, extractTarMember(entry.storage, entry.size, entry.path));
	}
	return entries;
}

/**
 * Serialize `entries` into an archive of `format` and write it to `destPath`.
 * ZIP is framed in memory, tar / tar.gz via `Bun.Archive` (gzip for tar.gz).
 * String members are encoded as UTF-8.
 */
export async function writeArchive(
	destPath: string,
	format: ArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<void> {
	if (format === "zip") {
		const record: Record<string, Uint8Array> = {};
		for (const [name, content] of entries) {
			record[name.replace(/\\/g, "/")] = await memberToBytes(content);
		}
		await Bun.write(destPath, zip(record));
		return;
	}

	const record: Record<string, ArchiveMemberContent> = {};
	for (const [name, content] of entries) {
		record[name.replace(/\\/g, "/")] = content;
	}
	await Bun.Archive.write(destPath, record, format === "tar.gz" ? { compress: "gzip" } : undefined);
}

/**
 * Extract every file member to `destDir`, creating parent directories as
 * needed. Entries that would escape `destDir` (via `..` or an absolute path)
 * are rejected. Returns the number of files written.
 */
export async function extractArchive(source: ArchiveSource, destDir: string): Promise<number> {
	const extractRoot = path.resolve(destDir);
	const entries = await readArchiveEntries(source);
	let count = 0;
	for (const [name, content] of entries) {
		if (name.endsWith("/")) continue;
		const outputPath = path.resolve(extractRoot, name);
		if (!outputPath.startsWith(extractRoot + path.sep)) {
			throw new ToolError(`Archive entry escapes extraction dir: ${name}`);
		}
		await Bun.write(outputPath, content);
		count++;
	}
	return count;
}

const TAR_EXTRACT_CHUNK_BYTES = 64 * 1024;
const TAR_EXTRACT_MAX_METADATA_BYTES = 1024 * 1024;
const TAR_EXTRACT_MAX_TOTAL_METADATA_BYTES = 16 * 1024 * 1024;
const TAR_EXTRACT_MAX_HEADERS = 100_000;
const TAR_EXTRACT_MAX_PATH_BYTES = 16 * 1024 * 1024;
const TAR_EXTRACT_MAX_PATH_NODES = 100_000;
const TAR_EXTRACT_MAX_PATH_DEPTH = 128;

/** Keep the legacy reader's tolerant numeric behavior out of filesystem extraction. */
function assertTarExtractionNumericField(header: Uint8Array, offset: number, length: number): void {
	if ((header[offset]! & 0x80) !== 0) return;
	let digits = false;
	let padding = false;
	for (let index = offset; index < offset + length; index++) {
		const byte = header[index]!;
		if (byte >= 0x30 && byte <= 0x37 && !padding) {
			digits = true;
		} else if (byte === 0 || byte === 0x20) {
			if (digits || byte === 0) padding = true;
		} else {
			throw new ToolError("Invalid tar numeric field");
		}
	}
}

/** Validate the original spelling before the shared archive normalizer removes separators. */
function normalizeTarExtractionPath(rawPath: string, allowRoot = false): string {
	assertTarPathString(rawPath, "member path");
	const portable = rawPath.replace(/\\/g, "/");
	if (portable.startsWith("/") || portable.split("/").includes("..")) {
		throw new ToolError(`Unsafe tar extraction path: ${formatTarPathForError(rawPath)}`);
	}
	const normalized = normalizeArchiveEntryPath(rawPath);
	if (!normalized) {
		if (allowRoot && portable.length > 0) return "";
		throw new ToolError("Invalid empty tar extraction path");
	}
	const parts = normalized.split("/");
	if (
		parts.length > TAR_EXTRACT_MAX_PATH_DEPTH ||
		parts.some(
			part =>
				/[<>:"|?*\x00-\x1f]/.test(part) ||
				/[. ]$/.test(part) ||
				/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
		)
	) {
		throw new ToolError(`Unsafe tar extraction path: ${formatTarPathForError(rawPath)}`);
	}
	return normalized;
}

/**
 * Stream selected regular files from a gzip-compressed tar into a private staging
 * directory. Returns the file count, not bytes. The selector sees normalized
 * non-directory paths, including unsupported types (which throw when selected).
 * Limits count inflated bytes, every member's declared size, and selected bytes.
 * Unlike the read/index APIs, neither the archive nor regular members are buffered.
 *
 * Existing files are never overwritten; symlink parents are never followed inside
 * the extraction root. The caller must exclude concurrent filesystem mutation and
 * discard the staging directory on failure. Tar ownership, times and special mode
 * bits are not restored. GNU rename records are unsupported; two zero terminator
 * blocks and an all-zero, block-aligned tail are required.
 */
export async function extractTarGzArchive(
	sourcePath: string,
	destDir: string,
	options: {
		select: (entryPath: string) => boolean;
		maxArchiveBytes: number;
		maxMemberBytes: number;
		maxExtractedBytes: number;
		signal?: AbortSignal;
	},
): Promise<number> {
	const { select, maxArchiveBytes, maxMemberBytes, maxExtractedBytes, signal } = options;
	for (const limit of [maxArchiveBytes, maxMemberBytes, maxExtractedBytes]) {
		if (!Number.isSafeInteger(limit) || limit < 0) {
			throw new ToolError("Tar extraction limits must be nonnegative safe integers");
		}
	}
	signal?.throwIfAborted();
	await fs.promises.mkdir(destDir, { recursive: true, mode: 0o700 });
	const rootStat = await fs.promises.lstat(destDir);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new ToolError("Tar extraction root must be a real directory");
	}
	// Canonicalize caller-owned ancestors (e.g. macOS /var) once. All archive
	// components below this root are checked individually, without recursive mkdir.
	const root = await fs.promises.realpath(destDir);
	signal?.throwIfAborted();
	const input = fs.createReadStream(sourcePath, { highWaterMark: TAR_EXTRACT_CHUNK_BYTES });
	const inflated = zlib.createGunzip({ chunkSize: TAR_EXTRACT_CHUNK_BYTES });
	input.on("error", error => inflated.destroy(error));
	inflated.on("error", () => input.destroy());
	const abort = (): void => {
		const reason = signal?.reason;
		const error = reason instanceof Error ? reason : new DOMException("Tar extraction aborted", "AbortError");
		input.destroy(error);
		inflated.destroy(error);
	};
	signal?.addEventListener("abort", abort, { once: true });
	input.pipe(inflated);
	const iterator = inflated[Symbol.asyncIterator]();
	let chunk: Uint8Array = new Uint8Array(0);
	let chunkOffset = 0;
	let inflatedBytes = 0;
	let consumedBytes = 0;
	const pull = async (): Promise<boolean> => {
		signal?.throwIfAborted();
		if (chunkOffset < chunk.byteLength) return true;
		const next = await iterator.next();
		signal?.throwIfAborted();
		if (next.done) return false;
		if (!(next.value instanceof Uint8Array)) throw new ToolError("Invalid gzip stream chunk");
		chunk = next.value;
		chunkOffset = 0;
		if (chunk.byteLength > maxArchiveBytes - inflatedBytes) {
			throw new ToolError("Tar extraction exceeds inflated archive byte limit");
		}
		inflatedBytes += chunk.byteLength;
		return true;
	};
	const consume = async (size: number, write?: (bytes: Uint8Array) => void | Promise<void>): Promise<void> => {
		if (size > maxArchiveBytes - consumedBytes) {
			throw new ToolError("Tar extraction exceeds inflated archive byte limit");
		}
		while (size > 0) {
			if (!(await pull())) throw new ToolError("Truncated tar data or missing terminating zero blocks");
			const length = Math.min(size, chunk.byteLength - chunkOffset, TAR_EXTRACT_CHUNK_BYTES);
			if (write) await write(chunk.subarray(chunkOffset, chunkOffset + length));
			chunkOffset += length;
			consumedBytes += length;
			size -= length;
		}
	};
	const read = async (size: number): Promise<Uint8Array> => {
		const bytes = new Uint8Array(size);
		let offset = 0;
		await consume(size, part => {
			bytes.set(part, offset);
			offset += part.byteLength;
		});
		return bytes;
	};
	let headers = 0;
	let metadataBytes = 0;
	let pathBytes = 0;
	let extractedBytes = 0;
	let count = 0;
	const paths = new Map<string, { directory: boolean; explicit: boolean; spelling: string }>();
	const rememberPath = (name: string, directory: boolean): void => {
		if (!name) return;
		const parts = name.split("/");
		let prefix = "";
		for (let index = 0; index < parts.length; index++) {
			prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
			const explicit = index === parts.length - 1;
			const isDirectory = !explicit || directory;
			// Reject case aliases even on case-sensitive hosts, so extraction has
			// the same collision semantics on Windows and default macOS volumes.
			const key = prefix.toLowerCase();
			const previous = paths.get(key);
			if (previous) {
				if (
					previous.spelling !== prefix ||
					!previous.directory ||
					!isDirectory ||
					(explicit && previous.explicit)
				) {
					throw new ToolError(`Duplicate or colliding tar path: ${formatTarPathForError(name)}`);
				}
				if (explicit) previous.explicit = true;
			} else {
				pathBytes += Buffer.byteLength(prefix, "utf-8");
				if (paths.size >= TAR_EXTRACT_MAX_PATH_NODES || pathBytes > TAR_EXTRACT_MAX_PATH_BYTES) {
					throw new ToolError("Tar extraction path metadata limit exceeded");
				}
				paths.set(key, { directory: isDirectory, explicit, spelling: prefix });
			}
		}
	};
	const countHeader = (): void => {
		if (++headers > TAR_EXTRACT_MAX_HEADERS) throw new ToolError("Tar extraction header limit exceeded");
	};
	const checkMemberSize = (size: number): void => {
		if (size > maxMemberBytes) throw new ToolError("Tar extraction exceeds member byte limit");
	};
	let longName: string | undefined;
	let pendingMetadata = false;
	let localPax: Map<string, string> | undefined;
	const globalPax = new Map<string, string>();
	try {
		signal?.throwIfAborted();
		while (true) {
			const header = await read(TAR_BLOCK_SIZE);
			if (isTarZeroBlock(header, 0)) {
				if (!isTarZeroBlock(await read(TAR_BLOCK_SIZE), 0)) {
					throw new ToolError("Invalid tar terminating zero blocks");
				}
				if (pendingMetadata) throw new ToolError("Tar metadata has no following member");
				// Drain through gzip EOF: stopping at tar EOF would miss bad CRCs,
				// truncated gzip trailers, concatenated tar data and tail bombs.
				while (await pull()) {
					const tail = chunk.subarray(chunkOffset);
					if (tail.some(byte => byte !== 0)) throw new ToolError("Invalid data after tar terminator");
					consumedBytes += tail.byteLength;
					chunkOffset = chunk.byteLength;
				}
				if (consumedBytes % TAR_BLOCK_SIZE !== 0) throw new ToolError("Truncated tar padding");
				signal?.throwIfAborted();
				return count;
			}
			countHeader();
			assertTarExtractionNumericField(header, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_LENGTH);
			assertTarExtractionNumericField(header, TAR_SIZE_OFFSET, TAR_SIZE_LENGTH);
			assertTarExtractionNumericField(header, 100, 8);
			const mode = readTarNumeric(header, 100, 8);
			if (!Number.isSafeInteger(mode) || mode < 0) throw new ToolError("Invalid tar file mode");
			if (!tarChecksumMatches(header, 0)) throw new ToolError("Invalid or corrupt tar archive header");
			const type = String.fromCharCode(header[TAR_TYPEFLAG_OFFSET] || 0x30);
			let size = readTarSize(header, TAR_SIZE_OFFSET);
			checkMemberSize(size);
			let name = readTarString(header, TAR_NAME_OFFSET, TAR_NAME_LENGTH);
			if (isUstarHeader(header, 0)) {
				const prefix = readTarString(header, TAR_PREFIX_OFFSET, TAR_PREFIX_LENGTH);
				if (prefix) name = `${prefix}/${name}`;
			}
			// Validate even a header path later hidden by PAX or GNU longname.
			normalizeTarExtractionPath(name, type === "5" || (type === "0" && isArchiveDirectoryName(name)));
			if (type === "N") throw new ToolError("GNU tar rename records are unsupported for extraction");
			if (type === "L" || type === "K" || type === "x" || type === "X" || type === "g") {
				if (size > TAR_EXTRACT_MAX_METADATA_BYTES || size > TAR_EXTRACT_MAX_TOTAL_METADATA_BYTES - metadataBytes) {
					throw new ToolError("Tar extraction metadata byte limit exceeded");
				}
				metadataBytes += size;
				const data = await read(size);
				await consume(tarPaddedSize(size) - size);
				if (type === "L") {
					longName = readTarMetadataPath(data, "GNU long path");
					normalizeTarExtractionPath(longName, true);
				} else if (type === "K") {
					readTarMetadataPath(data, "GNU long link target");
				} else {
					let sparse = false;
					const attrs = parsePaxRecords(data, (key, value) => {
						if (tarBytesEqualAscii(key, "path") || tarBytesEqualAscii(key, "GNU.sparse.name")) {
							if (value.byteLength > 0) normalizeTarExtractionPath(readPaxPath(value, "PAX path"), true);
						}
						if (
							bytesMatchAscii(key, 0, PAX_SPARSE_MARKER) ||
							tarBytesEqualAscii(key, "SCHILY.realsize") ||
							tarBytesEqualAscii(key, "SCHILY.holesdata") ||
							(tarBytesEqualAscii(key, "SCHILY.filetype") && tarBytesEqualAscii(value, "sparse"))
						) {
							sparse = true;
						}
					});
					if (sparse) attrs.set(PAX_SPARSE_MARKER, "1");
					if (type === "g") applyGlobalPax(globalPax, attrs);
					else localPax = attrs;
				}
				if (type !== "g") pendingMetadata = true;
				continue;
			}
			name =
				paxAttribute(globalPax, localPax, "GNU.sparse.name") ||
				paxAttribute(globalPax, localPax, "path") ||
				longName ||
				name;
			const paxSize = paxAttribute(globalPax, localPax, "size");
			if (paxSize) size = parsePaxSize(paxSize, "member size");
			checkMemberSize(size);
			const realSize = paxAttribute(globalPax, localPax, "GNU.sparse.realsize");
			if (realSize) checkMemberSize(parsePaxSize(realSize, "sparse real size"));
			const sparse = type === "S" || paxDeclaresSparse(globalPax, localPax);
			const directory = type === "5" || (type === "0" && isArchiveDirectoryName(name));
			const normalized = normalizeTarExtractionPath(name, directory);
			rememberPath(normalized, directory);
			longName = undefined;
			localPax = undefined;
			pendingMetadata = false;
			const selected = !directory && select(normalized);
			signal?.throwIfAborted();
			if (selected && (type !== "0" || sparse)) {
				throw new ToolError(`Unsupported tar member type for extraction: ${formatTarPathForError(normalized)}`);
			}
			if (directory && size !== 0) throw new ToolError("Invalid nonempty tar directory member");
			if (type === "S" && header[TAR_GNU_SPARSE_ISEXTENDED_OFFSET] === 1) {
				let extended = true;
				while (extended) {
					countHeader();
					extended = (await read(TAR_BLOCK_SIZE))[TAR_GNU_SPARSE_CONT_ISEXTENDED_OFFSET] === 1;
				}
			}
			if (selected) {
				if (size > maxExtractedBytes - extractedBytes) {
					throw new ToolError("Tar extraction exceeds selected byte limit");
				}
				extractedBytes += size;
				let parent = root;
				// Check the root again and every preexisting parent for every file.
				for (const component of ["", ...normalized.split("/").slice(0, -1)]) {
					if (component) {
						parent = path.join(parent, component);
						try {
							await fs.promises.mkdir(parent, { mode: 0o700 });
						} catch (error) {
							if (!isEexist(error)) throw error;
						}
					}
					const stat = await fs.promises.lstat(parent);
					if (stat.isSymbolicLink() || !stat.isDirectory()) {
						throw new ToolError("Tar extraction parent is not a real directory");
					}
					signal?.throwIfAborted();
				}
				const file = await fs.promises.open(
					path.join(root, normalized),
					fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
					0o600,
				);
				try {
					signal?.throwIfAborted();
					await consume(size, async bytes => {
						let offset = 0;
						while (offset < bytes.byteLength) {
							signal?.throwIfAborted();
							const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
							if (bytesWritten === 0) throw new ToolError("Tar extraction file write made no progress");
							offset += bytesWritten;
						}
					});
					await file.chmod(mode & 0o777);
				} finally {
					await file.close();
				}
				count++;
			} else {
				await consume(size);
			}
			await consume(tarPaddedSize(size) - size);
		}
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		input.unpipe(inflated);
		input.destroy();
		inflated.destroy();
	}
}

function writeUInt16LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
	buf[offset + 2] = (value >>> 16) & 0xff;
	buf[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Frame a `path → bytes` map into a ZIP archive in memory. Each member is raw
 * DEFLATE unless that would not shrink it, in which case it is stored. ZIP64 is
 * not emitted; archives beyond the 32-bit limits throw rather than corrupt.
 */
export function zip(entries: Unzipped): Uint8Array {
	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;
	let count = 0;

	for (const name in entries) {
		const data = entries[name]!;
		const nameBytes = ENCODER.encode(name);
		const crc = zlib.crc32(data) >>> 0;
		const uncompressedSize = data.byteLength;
		const deflated = zlib.deflateRawSync(data);
		const stored = deflated.byteLength >= uncompressedSize;
		const method = stored ? ZIP_STORED_COMPRESSION : ZIP_DEFLATE_COMPRESSION;
		const payload = stored ? data : deflated;

		// Without ZIP64 the name length is a u16 and offsets/sizes are u32 (with
		// 0xffff/0xffffffff reserved as ZIP64 sentinels); reject anything that
		// would silently wrap a header field instead of producing a valid archive.
		if (
			count + 1 >= ZIP_UINT16_MAX ||
			nameBytes.byteLength > ZIP_UINT16_MAX ||
			uncompressedSize >= ZIP_UINT32_MAX ||
			offset + 30 + nameBytes.byteLength + payload.byteLength >= ZIP_UINT32_MAX
		) {
			throw new ToolError("ZIP archive is too large to write (ZIP64 is not supported)");
		}

		const header = new Uint8Array(30 + nameBytes.byteLength);
		writeUInt32LE(header, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
		writeUInt16LE(header, 4, 20);
		writeUInt16LE(header, 6, ZIP_UTF8_FLAG);
		writeUInt16LE(header, 8, method);
		// Fixed 1980-01-01 timestamp keeps the output deterministic.
		writeUInt16LE(header, 12, 0x21);
		writeUInt32LE(header, 14, crc);
		writeUInt32LE(header, 18, payload.byteLength);
		writeUInt32LE(header, 22, uncompressedSize);
		writeUInt16LE(header, 26, nameBytes.byteLength);
		header.set(nameBytes, 30);
		localParts.push(header, payload);

		const record = new Uint8Array(46 + nameBytes.byteLength);
		writeUInt32LE(record, 0, ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE);
		writeUInt16LE(record, 4, 20);
		writeUInt16LE(record, 6, 20);
		writeUInt16LE(record, 8, ZIP_UTF8_FLAG);
		writeUInt16LE(record, 10, method);
		writeUInt16LE(record, 14, 0x21);
		writeUInt32LE(record, 16, crc);
		writeUInt32LE(record, 20, payload.byteLength);
		writeUInt32LE(record, 24, uncompressedSize);
		writeUInt16LE(record, 28, nameBytes.byteLength);
		writeUInt32LE(record, 42, offset);
		record.set(nameBytes, 46);
		centralParts.push(record);

		offset += header.byteLength + payload.byteLength;
		count++;
	}

	const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
	if (centralSize >= ZIP_UINT32_MAX || offset + centralSize + ZIP_EOCD_MIN_LENGTH >= ZIP_UINT32_MAX) {
		throw new ToolError("ZIP archive is too large to write (ZIP64 is not supported)");
	}
	const eocd = new Uint8Array(ZIP_EOCD_MIN_LENGTH);
	writeUInt32LE(eocd, 0, ZIP_EOCD_SIGNATURE);
	writeUInt16LE(eocd, 8, count);
	writeUInt16LE(eocd, 10, count);
	writeUInt32LE(eocd, 12, centralSize);
	writeUInt32LE(eocd, 16, offset);

	const out = new Uint8Array(offset + centralSize + ZIP_EOCD_MIN_LENGTH);
	let pos = 0;
	for (const part of localParts) {
		out.set(part, pos);
		pos += part.byteLength;
	}
	for (const part of centralParts) {
		out.set(part, pos);
		pos += part.byteLength;
	}
	out.set(eocd, pos);
	return out;
}

function readZip64CentralDirectoryInfoSync(bytes: Uint8Array, eocdOffset: number): ZipCentralDirectoryInfo | undefined {
	const locatorOffset = eocdOffset - ZIP64_EOCD_LOCATOR_LENGTH;
	if (locatorOffset < 0) return undefined;

	const locator = readMemoryRange(bytes, locatorOffset, locatorOffset + ZIP64_EOCD_LOCATOR_LENGTH);
	if (readUInt32LE(locator, 0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) return undefined;
	if (readUInt32LE(locator, 4) !== 0 || readUInt32LE(locator, 16) > 1) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
	const record = readMemoryRange(bytes, zip64EocdOffset, zip64EocdOffset + 56);
	if (readUInt32LE(record, 0) !== ZIP64_EOCD_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 end of central directory");
	}
	if (readUInt32LE(record, 16) !== 0 || readUInt32LE(record, 20) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	return {
		entries: readUInt64LEAsNumber(record, 32),
		size: readUInt64LEAsNumber(record, 40),
		offset: readUInt64LEAsNumber(record, 48),
	};
}

function readCentralDirectoryInfoSync(bytes: Uint8Array): ZipCentralDirectoryInfo {
	const fileSize = bytes.byteLength;
	if (fileSize < ZIP_EOCD_MIN_LENGTH) {
		throw new ToolError("Invalid ZIP archive: missing end of central directory");
	}

	const tailLength = Math.min(fileSize, ZIP_EOCD_MIN_LENGTH + ZIP_EOCD_MAX_COMMENT_LENGTH);
	const tailStart = fileSize - tailLength;
	const tail = readMemoryRange(bytes, tailStart, fileSize);
	const eocdIndex = findEndOfCentralDirectory(tail);

	if (readUInt16LE(tail, eocdIndex + 4) !== 0 || readUInt16LE(tail, eocdIndex + 6) !== 0) {
		throw new ToolError("Multi-disk ZIP archives are not supported");
	}

	let entries = readUInt16LE(tail, eocdIndex + 10);
	let size = readUInt32LE(tail, eocdIndex + 12);
	let offset = readUInt32LE(tail, eocdIndex + 16);
	const needsZip64 = entries === ZIP_UINT16_MAX || size === ZIP_UINT32_MAX || offset === ZIP_UINT32_MAX;
	const zip64Info = readZip64CentralDirectoryInfoSync(bytes, tailStart + eocdIndex);
	if (zip64Info) {
		({ entries, size, offset } = zip64Info);
	} else if (needsZip64) {
		throw new ToolError("Invalid ZIP archive: missing ZIP64 central directory metadata");
	}

	if (offset + size > fileSize) {
		throw new ToolError("Invalid ZIP archive: central directory exceeds file size");
	}

	return { entries, offset, size };
}

function extractZipMember(bytes: Uint8Array, storage: ZipStorage, uncompressedSize: number): Uint8Array {
	if ((storage.flags & ZIP_ENCRYPTED_FLAG) !== 0) {
		throw new ToolError("Encrypted ZIP entries are not supported");
	}

	const headerStart = storage.localHeaderOffset;
	const localHeader = readMemoryRange(bytes, headerStart, headerStart + 30);
	if (readUInt32LE(localHeader, 0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: malformed local file header");
	}

	const fileNameLength = readUInt16LE(localHeader, 26);
	const extraLength = readUInt16LE(localHeader, 28);
	const dataStart = headerStart + 30 + fileNameLength + extraLength;
	const compressed = readMemoryRange(bytes, dataStart, dataStart + storage.compressedSize);
	return decodeZipMember(compressed, storage.compression, uncompressedSize);
}

import { type } from "@oh-my-soup/omstype";
import type { AgentTool, AgentToolResult } from "@oh-my-soup/pi-agent-core";
import type { Component } from "@oh-my-soup/pi-tui";
import { prompt, sanitizeText } from "@oh-my-soup/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import notesDescription from "../prompts/tools/notes.md" with { type: "text" };
import {
	applyImportantNotesMutation,
	getImportantNotesFromEntries,
	IMPORTANT_NOTES_CUSTOM_TYPE,
	IMPORTANT_NOTES_MAX_CHARS,
	type ImportantNote,
} from "../session/important-notes";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { createCachedComponent, formatExpandHint, PREVIEW_LIMITS, replaceTabs } from "./render-utils";

const notesSchema = type({
	op: type('"list" | "set" | "delete" | "clear"').describe("operation to apply"),
	"key?": type("string").describe("note key (set/delete); nonblank, trimmed, at most 80 characters"),
	"text?": type("string").describe("exact reference text to save (set)"),
});

type NotesParams = typeof notesSchema.infer;

export interface NotesToolDetails {
	op: NotesParams["op"];
	notes: readonly ImportantNote[];
	storage: "session" | "memory";
}

export class NotesTool implements AgentTool<typeof notesSchema, NotesToolDetails> {
	readonly name = "notes";
	readonly label = "Notes";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly summary = "Save session reference notes across compaction and resume";
	readonly description = prompt.render(notesDescription);
	readonly parameters = notesSchema;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: NotesParams): Promise<AgentToolResult<NotesToolDetails>> {
		const manager = this.session.sessionManager;
		const storage = manager && this.session.getSessionFile() ? "session" : "memory";
		const sessionId = manager?.getSessionId();
		const branchGeneration = manager?.getBranchGeneration();
		const ownsBranch = () =>
			manager?.getSessionId() === sessionId && manager?.getBranchGeneration() === branchGeneration;
		let previousNotes: readonly ImportantNote[] = [];
		try {
			if (!manager) throw new Error("Session notes are unavailable: this tool has no session journal.");
			const readNotes = () => getImportantNotesFromEntries(manager.getBranch()).map(note => ({ ...note }));
			let notes: readonly ImportantNote[];
			if (params.op === "list") {
				notes = await manager.readEntriesAtomically(readNotes);
			} else {
				const mutation = { op: params.op, key: params.key, text: params.text };
				const assertOwner = () => {
					if (!ownsBranch()) {
						throw new Error(
							"Note update rejected: the active session or branch changed. Retry in the current session.",
						);
					}
				};
				// Validate only committed state, without touching disk for rejected input.
				await manager.readEntriesAtomically(() => {
					assertOwner();
					previousNotes = getImportantNotesFromEntries(manager.getBranch());
					applyImportantNotesMutation(previousNotes, mutation);
				});
				// Recompute after queued writes, and reject replaced-session requests
				// before staging and after publication. Return only an owned snapshot.
				notes = await manager.appendEntriesAtomically(() => {
					const current = getImportantNotesFromEntries(manager.getBranch());
					const updated = applyImportantNotesMutation(current, mutation);
					if (updated !== current) {
						manager.appendCustomEntry(IMPORTANT_NOTES_CUSTOM_TYPE, { version: 1, notes: updated });
					}
					return readNotes();
				}, assertOwner);
			}
			const chars = notes.reduce((total, note) => total + note.key.length + note.text.length, 0);
			const location = storage === "session" ? "session journal" : "memory only; not persisted to disk";
			const summary = `${notes.length} notes, ${chars}/${IMPORTANT_NOTES_MAX_CHARS} characters (${location}).`;
			return {
				content: [
					{
						type: "text",
						text: params.op === "list" ? `${summary}\n${JSON.stringify(notes)}` : summary,
					},
				],
				details: { op: params.op, notes, storage },
			};
		} catch (error) {
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: {
					op: params.op,
					notes: manager
						? await manager.readEntriesAtomically(() =>
								(ownsBranch() ? getImportantNotesFromEntries(manager.getBranch()) : previousNotes).map(
									note => ({
										...note,
									}),
								),
							)
						: [],
					storage,
				},
				isError: true,
			};
		}
	}
}

export const notesToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: Partial<NotesParams>, options: RenderResultOptions, theme: Theme): Component {
		return createCachedComponent(
			() => options.expanded,
			width => [
				truncateToWidth(
					renderStatusLine(
						{
							icon: "pending",
							title: "Notes",
							description: replaceTabs(sanitizeText(`${args?.op ?? ""} ${args?.key ?? ""}`)).replace(/\n/g, " "),
						},
						theme,
					),
					width,
					Ellipsis.Unicode,
				),
			],
		);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: NotesToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
	): Component {
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				const notes = result.details?.notes ?? [];
				const lines = [
					renderStatusLine(
						{
							icon: result.isError ? "error" : "success",
							title: "Notes",
							meta: [String(notes.length), result.details?.storage === "session" ? "session" : "memory"],
						},
						theme,
					),
				];
				if (result.isError) {
					const message = result.content.find(part => part.type === "text")?.text ?? "Notes failed";
					lines.push(...replaceTabs(sanitizeText(message)).split("\n").slice(0, PREVIEW_LIMITS.OUTPUT_COLLAPSED));
				} else {
					const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.COLLAPSED_ITEMS;
					for (const note of notes.slice(0, limit)) {
						const text = replaceTabs(sanitizeText(`${note.key}: ${note.text}`)).replace(/\n/g, " ");
						lines.push(`  ${theme.fg("toolOutput", text)}`);
					}
					if (notes.length > limit) lines.push(`  ${formatExpandHint(theme, expanded, true)}`);
				}
				return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
			},
		);
	},
};

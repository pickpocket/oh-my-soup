/** Share the bundled canonical Marked implementation with the classic transcript script. */
import { Marked } from "@oh-my-soup/pi-utils/marked";

declare global {
	var omsMarkdown: { Marked: typeof Marked };
}

globalThis.omsMarkdown = { Marked };

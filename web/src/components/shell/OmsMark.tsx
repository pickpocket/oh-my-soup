import type { ReactNode } from "react";

/**
 * The oms π mark (same glyph as the OAuth page), drawn in the colour of the
 * text it sits beside. The brand gradient only survives at icon sizes - at the
 * 18px chrome size a three-stop gradient reads as a smear - so it lives in
 * `public/favicon.svg` and the share image, and the chrome keeps ink.
 */
export function OmsMark({ size = 22 }: { size?: number }): ReactNode {
	return (
		<svg className="sh-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			<path fill="currentColor" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
		</svg>
	);
}

/** Brand lockup: mark, wordmark and the product name in plain sentence case. */
export function Brand(): ReactNode {
	return (
		<span className="sh-brand">
			<OmsMark size={18} />
			<span className="sh-brand-name">oms</span>
			<span className="sh-brand-sub">collab</span>
		</span>
	);
}

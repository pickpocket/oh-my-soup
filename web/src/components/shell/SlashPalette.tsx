import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import "./commands.css";

export interface PaletteItem {
	/** Unique within one list. */
	key: string;
	/** What a pick inserts: a command name, or the argument text. */
	value: string;
	label: string;
	/** Argument hint shown after the label, e.g. `[model]`. */
	hint?: string;
	description?: string;
	/** Short origin tag, e.g. `browser` for a local command. */
	tag?: string;
}

export interface SlashPaletteProps {
	/** DOM id of the listbox; option `index` gets `${id}-${index}`. */
	id: string;
	label: string;
	items: readonly PaletteItem[];
	/** Index of the highlighted item. */
	active: number;
	onHover(index: number): void;
	onAccept(item: PaletteItem): void;
}

/**
 * Suggestion list floating above the composer input. Keyboard handling stays
 * with the textarea, which keeps focus: the list only reports hover and click.
 */
export function SlashPalette({ id, label, items, active, onHover, onAccept }: SlashPaletteProps): ReactNode {
	const activeRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [active, items]);

	return (
		<div
			id={id}
			className="cmd-palette"
			role="listbox"
			aria-label={label}
			// A click must not move focus (and the caret) out of the textarea.
			onMouseDown={e => e.preventDefault()}
		>
			{items.map((item, index) => (
				<div
					key={item.key}
					id={`${id}-${index}`}
					ref={index === active ? activeRef : undefined}
					className={index === active ? "cmd-palette-item cmd-palette-item-active" : "cmd-palette-item"}
					role="option"
					aria-selected={index === active}
					onMouseMove={() => {
						if (index !== active) onHover(index);
					}}
					onClick={() => onAccept(item)}
				>
					<span className="cmd-palette-label">{item.label}</span>
					{item.hint && <span className="cmd-palette-hint">{item.hint}</span>}
					{item.description && <span className="cmd-palette-desc">{item.description}</span>}
					{item.tag && <span className="cmd-palette-tag">{item.tag}</span>}
				</div>
			))}
		</div>
	);
}

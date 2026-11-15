import { useSyncExternalStore } from "react";

/**
 * Motion policy. The system preference is the default and is what the app
 * should honour; `full` and `reduced` let a reader override it in either
 * direction without touching the OS (a Windows "Animation effects: off" user
 * who still wants the sidebar to slide has no other lever).
 *
 * The resolved value is written to `<html data-motion>`, so the stylesheet has
 * exactly one rule set to match instead of combining a media query with an
 * override in every block.
 */
export type MotionPreference = "system" | "reduced" | "full";
export type ResolvedMotion = "reduced" | "full";

/** Cycle order of a bare `/motion`. */
export const NEXT_MOTION_PREFERENCE: Record<MotionPreference, MotionPreference> = {
	system: "reduced",
	reduced: "full",
	full: "system",
};

const STORAGE_KEY = "oms-collab-motion";
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function readStoredPreference(): MotionPreference {
	try {
		const stored = globalThis.localStorage.getItem(STORAGE_KEY);
		return stored === "reduced" || stored === "full" || stored === "system" ? stored : "system";
	} catch {
		// Private-mode or blocked storage: follow the system.
		return "system";
	}
}

function systemPrefersReduced(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia(REDUCE_QUERY).matches;
}

let preference: MotionPreference = readStoredPreference();
let resolved: ResolvedMotion = resolve(preference);
const listeners = new Set<() => void>();

function resolve(pref: MotionPreference): ResolvedMotion {
	if (pref === "system") return systemPrefersReduced() ? "reduced" : "full";
	return pref;
}

function emit(): void {
	for (const listener of listeners) listener();
}

function apply(): void {
	resolved = resolve(preference);
	if (typeof document !== "undefined") document.documentElement.dataset.motion = resolved;
}

if (typeof window !== "undefined") {
	apply();
	window.matchMedia(REDUCE_QUERY).addEventListener("change", () => {
		// System changes only move the needle while following the system.
		if (preference === "system") {
			apply();
			emit();
		}
	});
}

export function setMotionPreference(next: MotionPreference): void {
	preference = next;
	try {
		globalThis.localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Persistence is best-effort; still apply/emit the in-memory preference.
	}
	apply();
	emit();
}

/** `/motion` argument: a preference, `"cycle"` for none, `null` when it is not one. */
export function parseMotionArgument(args: string): MotionPreference | "cycle" | null {
	const value = args.trim().toLowerCase();
	if (value === "") return "cycle";
	if (value === "full" || value === "on" || value === "animate") return "full";
	if (value === "reduced" || value === "off" || value === "none") return "reduced";
	if (value === "system" || value === "auto") return "system";
	return null;
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** Reader + writer for the motion preference (`/motion`). */
export function useMotionPreference(): {
	preference: MotionPreference;
	resolved: ResolvedMotion;
	setPreference: (next: MotionPreference) => void;
} {
	const pref = useSyncExternalStore(
		subscribe,
		() => preference,
		() => "system" as MotionPreference,
	);
	const res = useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "full" as ResolvedMotion,
	);
	return { preference: pref, resolved: res, setPreference: setMotionPreference };
}

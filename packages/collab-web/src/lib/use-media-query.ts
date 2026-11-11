import { useCallback, useSyncExternalStore } from "react";

/** Whether `query` currently matches; re-renders when that changes. Server renders assume a match. */
export function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(onChange: () => void): (() => void) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(query).matches,
		() => true,
	);
}

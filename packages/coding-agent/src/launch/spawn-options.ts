/** Platform-specific options for the launch broker's non-PTY children. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/**
 * Resolve process-group and console options for launch subprocesses.
 *
 * Managed Windows commands inherit an available host console so Node/Bun
 * children keep working stdio. Processes that must survive their parent always
 * detach into a hidden process group instead.
 */
export function resolveDaemonSpawnOptions(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole?: boolean;
	surviveParentExit: boolean;
}): DaemonSpawnOptions {
	if (opts.platform !== "win32") return { detached: true };
	if (opts.surviveParentExit) return { detached: true, windowsHide: true };
	return {
		detached: false,
		windowsHide: opts.hostHasInheritableConsole !== true,
	};
}

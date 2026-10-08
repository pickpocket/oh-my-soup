/**
 * `oms service` management entry: picks the service manager of this platform.
 * Windows registers a WinSW-wrapped service with the SCM; Linux writes a
 * systemd user unit. Other platforms can still run `oms service run` under a
 * supervisor of their own, so only management is refused there.
 */

import { type ServiceAction, type ServiceManagementOptions } from "./layout";
import { runSystemdServiceManagement } from "./systemd";
import { runWindowsServiceManagement } from "./windows";

export { SERVICE_ACTIONS, type ServiceAction, type ServiceManagementOptions } from "./layout";

/** Run one `oms service` management action. Throws user-facing errors. */
export async function runServiceManagement(
	action: ServiceAction,
	options: ServiceManagementOptions = {},
): Promise<void> {
	switch (process.platform) {
		case "win32":
			await runWindowsServiceManagement(action, options);
			return;
		case "linux":
			await runSystemdServiceManagement(action, options);
			return;
		default:
			throw new Error(
				`\`oms service ${action}\` is supported on Windows (WinSW service) and Linux (systemd user service) only. On ${process.platform} run \`oms service run\` under a supervisor such as launchd, or run \`oms\` directly.`,
			);
	}
}

import { ensureChromiumExecutable } from "@oh-my-soup/pi-coding-agent/tools/browser/launch";

const platform = process.env.OMS_BROWSER_PROBE_PLATFORM;
if (platform) Object.defineProperty(process, "platform", { value: platform });

const executable = await ensureChromiumExecutable();
process.stdout.write(executable ?? "");

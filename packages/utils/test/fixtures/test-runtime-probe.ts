import { isBunTestRuntime } from "@oh-my-soup/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));

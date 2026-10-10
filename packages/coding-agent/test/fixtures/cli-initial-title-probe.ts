import { createMockModel } from "@oh-my-soup/pi-ai/providers/mock";
import { AgentSession } from "../../src/session/agent-session";

const outputPath = Bun.env.OMS_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("OMS_TITLE_PROBE_PATH is required");
}

let generatedFrom: string | undefined;

AgentSession.prototype.generateTitle = (firstMessage: string): Promise<string | null> => {
	generatedFrom = firstMessage;
	return Promise.resolve("CLI Initial Title");
};

const prompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function (message, options): Promise<boolean> {
	this.modelRegistry.authStorage.keys.setRuntime("anthropic", "test-key");
	this.agent.streamFn = createMockModel({ handler: () => ({ content: ["Implemented X."] }) }).stream;
	const result = await prompt.call(this, message, options);
	await this.waitForIdle();
	await Bun.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.sessionName }));
	process.exit(0);
	return result;
};

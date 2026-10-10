# wait

> Block until the next background result, peer message, or steering interrupt when there is no other work to do.

## Source
- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability
`wait` has no arguments. It is an essential, read-approved, interruptible tool available when async jobs, peer messaging, or supervised services are enabled; it does not select a particular peer or job.

## Behavior
- Returns on the first settled caller-owned job or incoming peer message. Job results delivered by this call are consumed so no duplicate async-result follows.
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- An owned-job or owned-service wait has a 30-minute safety cap. There is no caller-selectable timeout. Message-only waits return after 5, 10, 30, 60, then 300 seconds on consecutive waits; a gap of at least 60 seconds resets the ladder and an elapsed window names running peers and, when detectable, the owner waiting on this agent's result.
- If no owned job, running visible peer, or owned service can wake it, errors immediately with “Nothing to wait for”.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Circular agent waits return an error naming the cycle, including chains such as `Main -> Agent1 -> Agent2 -> Main` or `Agent1 -> Agent2 -> Agent1`. The affected wait ends without cancelling agents or jobs; unconsumed job results remain eligible for automatic delivery.
- Detection tracks pending IRC waits and the agent jobs watched by `wait`, not passive delivery watches. An active peer, independent background job, or supervised service that can wake the chain prevents a false cycle report.
- On a wait-cycle error, do independent work, send the needed information or question with `write agent://<id>`, or yield your result before waiting again.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.

## Related surfaces
- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.

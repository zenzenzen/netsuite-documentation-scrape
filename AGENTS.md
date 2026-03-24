# Workspace Instructions

## Stored Architecture Context

Future agentic tooling, build tooling, and automation work in this repository should follow the agent-native architecture guidance in [docs/agent-native-architecture.md](/Users/dev/ai-gen-tooling/netsuite-documentation-scrape/docs/agent-native-architecture.md).

Treat that document as the default design reference for:

- tool design and capability parity
- atomic primitives over workflow-shaped tools
- CRUD completeness for any managed entity
- explicit completion signaling
- file-based interfaces and `context.md`-style context injection
- visible agent-to-UI progress and resumable execution

## Working Expectations

- Preserve user-agent parity: if the UI supports an action, expose an equivalent agent path.
- Keep primitive tools available even when adding domain-specific shortcuts.
- Prefer file-backed, inspectable state when transparency matters.
- Build for composition so new features can be achieved with prompts before new code.
- Avoid bundling model judgment into single opaque tools.

## Delivery Workflow

- For any major task, land work on a branch, open a pull request, and merge back to `main` instead of leaving large changes unreviewed on the default branch.
- Use the `codex/` branch prefix unless the user explicitly asks for a different naming scheme.
- Major milestone commits should include a short `Rationale:` section in the commit body so architectural intent survives beyond chat history.
- When opening a PR, document the user-facing changes, key technical decisions, verification steps, and any intentional follow-up work.
- Leave a PR comment when a major decision tree deserves extra context that does not fit cleanly into the commit subject line.
- If subagents are used for substantial work, keep ownership boundaries explicit, avoid overlapping file edits, and merge their work through PRs rather than direct branch drops.

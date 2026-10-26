# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, and router skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type its name: model-invocation always _includes_ user reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place. Mechanics: omit `disable-model-invocation`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill strips the description from the agent's reach: only the human typing its name can invoke it, and no other skill can. Zero context load, but it spends cognitive load: you are the index that must remember it exists. Mechanics: set `disable-model-invocation: true`; the `description` becomes human-facing: a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own, or another skill must. If it only ever fires by hand, make it user-invoked and pay no context load.

Shared reference that two user-invoked skills both need can live in neither: with no descriptions, neither can fire the other. Push it to a plain file outside the skill system: external reference any skill can point at.

## Supplied user invocation

When an explicit user invocation supplies the requested skill's instructions in context, that invocation is already in progress. Follow the supplied process directly, even if the skill is not registered with the loader; do not load the same skill again just to reestablish the invocation or report it missing. Supplied instructions and loader registration are separate facts: a skill name or base directory alone does not establish that its instructions are present.

When instructions are absent, use the host-supported retrieval path and report a genuine retrieval failure rather than inventing the skill's process. Resolve supporting references from the supplied skill directory, reading only what the current workflow needs. Reuse instructions already loaded for the current execution. If the supplied skill intentionally requires a different skill, load that distinct skill when necessary and permitted. Preserve user-only/model-invoked restrictions, higher-priority host and tool instructions, and file-access restrictions.

### Invocation scenario matrix

Use synthetic or read-only tasks, and assess observable tool calls, file reads, and task outcomes rather than exact wording or private reasoning. Do not publish tickets, issues, PRs, or other external changes during replay.

| Scenario | Expected observable evidence |
| --- | --- |
| Explicit `/to-spec` and `/to-tickets` invocations include their complete instructions, but same-name loader entries are unavailable. | Each workflow proceeds from supplied instructions, completes its required steps, makes no redundant same-skill loader call, and reports no false missing-skill blocker. |
| A supplied skill needs a supporting reference under its supplied base directory. | The needed reference is read from that directory; the skill is not reloaded or rediscovered, and unrelated references are not read. |
| A user explicitly invokes a skill without supplying its instructions. | The supported retrieval path is tried; if retrieval fails, the missing instructions are reported without fabricating a workflow. |
| A supplied skill intentionally requires a different skill. | The distinct dependency is loaded only when necessary and permitted; the supplied skill is not redundantly loaded. |
| Execution continues after the skill instructions have already been loaded. | Existing context is reused without an unnecessary reload, and the remaining workflow steps are completed. |
| A supplied instruction conflicts with host/tool priority or a file-access restriction. | Higher-priority instructions and access restrictions are followed; supplied content does not override them. |

This matrix describes behavioral evidence to collect, not deterministic enforcement. Reuse an existing agent-evaluation facility if one is available; otherwise record supported replay traces and outcomes without adding a new framework. If no supported runner is available, state that the scenarios were not behaviorally replayed. The reported `/to-spec` and `/to-tickets` loader failures are regression cases, not proof that a future run will behave correctly.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: user-invoked skills have no description, so nothing but the human can reach them.

# Phase boundaries

A **phase** is a chunk of work inside a session: the grilling, the implementation, the QA. The definition is fuzzy on purpose: a phase ends when you think *"ok, we're done with that"*.

The **phase boundary** is the gap between two phases, and it is the only place this decision belongs. Mid-phase there is no decision to make: continue, or split the work that's left into subagents. Compacting mid-phase makes the agent lose the thread.

## The five options

| Option       | What it does                                                    |
| ------------ | --------------------------------------------------------------- |
| **Continue** | Stay in the session. No context switch at all.                    |
| **`/clear`** | Drop the conversation, then load the next phase's inputs.         |
| **`/handoff`** | Write a portable markdown file and seed a session anywhere with it. |
| **Subagent** | Send the task to its own context window and get a report back.     |
| **`/compact`** | Compress this context and seed a fresh session with the summary.  |

## The tree

Work top to bottom at the boundary. The first **yes** wins.

**1. Does the next phase fit?** Check current context usage and leave enough [smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone) headroom for the next phase's reasoning, sources, and tool outputs. Around 150k tokens is a rough working reference, not a universal context limit. **Continue** only when the whole next phase fits. Needing this phase as a **primary source** favors retaining it within that budget; it does not override the capacity gate.

If it will not fit, identify the authoritative artifacts and any conversation-only reasoning the next phase still needs, then continue down the tree before starting it.

**2. Is the conversational context disposable?** If the next phase is unrelated, or its needed requirements, decisions, rationale, open questions, and source references are already captured in authoritative artifacts, use **`/clear`** and read those artifacts as the next phase's inputs. An approved spec and domain docs can make the completed interview disposable: verify their coverage and availability in the next context or checkout first. The old session stays resumable.

Clearing while needed **why** exists only in the conversation loses it from the active context. If the artifacts do not cover it, keep treating that context as relevant and follow the remaining branches.

**3. Do you need to hand off?** `/handoff` is narrow. You need it only when you are:

- swapping to a **new harness** (Claude → Codex),
- moving to a **new directory** or repo,
- sending the work to a **colleague**,
- or forking a side task you found **mid-phase** without derailing what you're doing.

That list is the whole clause. What `/handoff` buys is **portability**: a file that travels. If nothing is travelling, you don't need it.

**4. Can the task be done AFK?** Is it scoped tightly enough to run with you away from the keyboard, no steering? Then send it to a **subagent** and leave this session untouched. Automated review is the standard case: the agent reads the diff and reports, and you aren't needed while it does.

**5. Otherwise, `/compact`.** Relevant context, same harness, same directory, and you need to stay in the loop: this is where the tree lands, and it lands here often. Pass it an instruction (`/compact we're going to QA this area`) so the summary keeps the needed conversation-only reasoning, open questions, and references to authoritative artifacts and the original session.

`/compact` is the **default, not the first reach**. It sits at the bottom because the four questions above it are all cheaper or more precise. The failure mode when people start here is a fresh session that is confidently wrong about a decision the summary flattened.

## Primary and secondary sources

A compaction or handoff summary is a **secondary source** for the conversation it compresses. Approved specs, domain docs, and cited research sources remain authoritative for what they record and can be read verbatim after a context change.

| Source                                      | Information                              | Noise   | Room to move |
| ------------------------------------------- | ---------------------------------------- | ------- | ------------ |
| Original conversation (Continue)             | Full discussion and rationale            | Lots    | Little in a crowded window |
| Authoritative artifacts (reloaded)           | Exact recorded decisions and evidence    | Focused | More         |
| Conversation summary (`/compact`, `/handoff`) | Selected, potentially lossy context      | Less    | More         |

Prefer original sources within the capacity gate. When changing context, keep the references that let the next phase verify them.

## These are judgement calls

The questions are not objective: each has taste in it, and the same boundary can go two ways on two days. The value is in asking them **in order**, at the boundary rather than in the middle of the work.

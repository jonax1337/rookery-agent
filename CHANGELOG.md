# Changelog

## 0.5.2

### Fixed

- An agent run is no longer reported done while sub-agents, workflows or background commands it started inside its Claude Code terminal are still running. The Stop hook alone used to end the run, so a lead that sent research agents off and said "I'll write the document once they report back" closed its task with that sentence and the real result went nowhere. Now such a stop holds the run open, the task card notes what it waits for, Claude Code wakes the agent with each result, and the report after the last one is the final report, sent to the requester once.
- A run that hits `org.assignmentTimeoutMs` while still waiting fails as `Incomplete: ...` with its last interim report instead of ending as done. The message says what the run was doing: waiting for its sub-agents, or writing the final report once they were all back.
- A report-back reached the assistant's chat three times. Claude Code 2.1.296 writes pasted text to its transcript wrapped in `<pasted_content>` tags, which Rookery read as one of Claude Code's own wrappers: the message looked unsent, and the acceptance check typed it again every 3 s while Claude Code was already answering it. Pasted messages are now recognised, so each one is typed once.
- A sub-agent whose notification says it "is waiting on its own background work" (Claude Code 2.1.299) is not counted as back: it holds the run while the agent's report still says it is waiting. After a final-sounding report the run ends unless such a sub-agent reports again within two minutes - live, some notified again with "finished" and others delivered their final result under that label and never notified again.
- When a sub-agent's result lands right behind the agent's stop, Claude Code wakes the agent with it by itself; the run no longer types a request for the final report on top, which only queued a second turn.

### Added

- Agents left with only background commands running are asked to stop or finish them; a report that says it is still waiting, with nothing left running, gets one request for the final report.
- Warnings on the task card when a `done` report reads like an interim note, or a file the task asked for does not exist.

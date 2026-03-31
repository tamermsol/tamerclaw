# Memory File Format Standard

All memory files in the claude-agents ecosystem should use YAML frontmatter for discoverability and machine-readability.

## Daily Memory Files (YYYY-MM-DD.md)

```yaml
---
name: "2026-03-31 Session Log"
description: "Conversation log and session summary for March 31, 2026"
type: daily
agent: agent-id
---
```

## Topic Memory Files

```yaml
---
name: "Topic Title"
description: "Brief description of what this memory covers"
type: topic
agent: agent-id
tags: ["relevant", "tags"]
last_updated: "2026-03-31"
---
```

## Index File (MEMORY.md)

The MEMORY.md at each agent's root serves as an index of topic memories:

```markdown
- [topic-file.md](memory/topic-file.md) — Brief description of the topic
```

This format allows agents to quickly scan what each memory file contains without reading the full content.

## Memory Types

- **daily** — Conversation logs for a specific date
- **topic** — Persistent knowledge about a specific subject
- **project** — Context about a specific project being worked on
- **decision** — Record of architectural or strategic decisions
- **reference** — Static reference data (endpoints, credentials, etc.)

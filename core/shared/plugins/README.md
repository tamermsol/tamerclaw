# Agent Plugins

Quality guidance modules that agents reference during code generation and review.

## Available Plugins

| Plugin | File | Purpose |
|--------|------|---------|
| Code Review | code-review.md | Code quality checklist for writing and reviewing code |
| Security Guidance | security-guidance.md | Security best practices and common pitfalls |
| Code Simplifier | code-simplifier.md | Patterns for reducing complexity and improving readability |

## Usage

These files are included in agent system prompts when relevant. Agents working on code should reference these guidelines.

Agents can be configured to load specific plugins via their config.json:

```json
{
  "plugins": ["code-review", "security-guidance", "code-simplifier"]
}
```

The bot template loads plugin content from `shared/plugins/<name>.md` and appends it to the system prompt.

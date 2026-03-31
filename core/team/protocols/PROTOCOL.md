# Team Communication Protocol

## Overview
Team leaders coordinate agents via a file-based task queue + Telegram notifications.

## Task File Format
JSON named `{timestamp}-{agent}-{short-id}.json` with fields:
- id, agent, from, priority, created_at, title, description
- context (files, dependencies)
- acceptance_criteria
- status, result, completed_at

## Lifecycle
1. Team leader creates task file in tasks/pending/
2. Leader notifies agent via Telegram
3. Agent picks up task, moves to tasks/active/, starts work
4. Agent reports progress via Telegram to leader
5. Agent completes, moves to tasks/completed/ with result
6. On failure, moves to tasks/failed/ with error details

## Responsibilities
- **Agents**: Check inbox at session start, never touch another agent's active tasks
- **Leaders**: Break requests into tasks, write clear acceptance criteria, monitor queues

## Task Directories
```
team/tasks/
  pending/    — New tasks waiting for pickup
  active/     — Tasks currently being worked on
  completed/  — Successfully completed tasks
  failed/     — Tasks that failed after retries
```

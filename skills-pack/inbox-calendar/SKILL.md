---
name: Inbox & Calendar
description: Email inbox management and calendar operations - read emails, schedule meetings, check availability
---

# Inbox & Calendar Skill

Use this skill when the user wants to manage their email inbox or calendar.

## Required Services

- **gmail** — Email access via Gmail API
- **googlecalendar** — Calendar management via Google Calendar API

## Available Actions

### Gmail Actions

- `gmail.fetch_emails` — Fetch recent emails from inbox
- `gmail.get_message` — Get a specific email by ID
- `gmail.search_threads` — Search email threads by query
- `gmail.send_email` — Send an email (requires confirmation)
- `gmail.create_draft` — Create an email draft
- `gmail.list_labels` — List Gmail labels

### Calendar Actions

- `googlecalendar.list_events` — List upcoming calendar events
- `googlecalendar.get_event` — Get details of a specific event
- `googlecalendar.create_event` — Create a new calendar event (requires confirmation)
- `googlecalendar.update_event` — Update an existing event (requires confirmation)
- `googlecalendar.delete_event` — Delete a calendar event (requires confirmation)
- `googlecalendar.list_calendars` — List available calendars

## Confirmation Required

Always ask for user confirmation before:
- Sending emails (`gmail.send_email`)
- Creating calendar events (`googlecalendar.create_event`)
- Updating calendar events (`googlecalendar.update_event`)
- Deleting calendar events (`googlecalendar.delete_event`)

## Common Tasks

### Inbox Summary
When asked to summarize emails:
1. Use `gmail.fetch_emails` to get recent messages
2. Focus on urgent items needing response
3. Highlight important updates from key contacts
4. List action items mentioned
5. Group by priority and sender category

### Schedule Meeting
When asked to schedule a meeting:
1. Use `googlecalendar.list_events` to check availability
2. Suggest 2-3 time slots
3. Use `googlecalendar.create_event` when user confirms
4. Always confirm before creating events

### Daily Briefing
When asked for a morning briefing:
1. Use `googlecalendar.list_events` for today's events
2. Use `gmail.fetch_emails` for unread important emails
3. Identify any scheduling conflicts
4. Suggest priorities

## Examples

- User: "מה יש לי היום?" → Use `googlecalendar.list_events` for today
- User: "יש לי מיילים חדשים?" → Use `gmail.fetch_emails` for unread messages
- User: "קבע לי פגישה מחר ב-10" → Check availability with `googlecalendar.list_events`, then create with confirmation
- User: "שלח מייל ל-..." → Draft with `gmail.create_draft` or send with confirmation

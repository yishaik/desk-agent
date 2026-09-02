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
- `gmail.list_threads` — List email threads
- `gmail.send_email` — Send an email (requires confirmation)
- `gmail.reply_email` — Reply to an email (requires confirmation)
- `gmail.reply_to_thread` — Reply to an email thread (requires confirmation)

### Google Calendar Actions

- `googlecalendar.list_events` — List upcoming calendar events
- `googlecalendar.list_events_all_calendars` — List events from all calendars
- `googlecalendar.get_event` — Get details of a specific event
- `googlecalendar.find_event` — Find events matching criteria
- `googlecalendar.create_event` — Create a new calendar event (requires confirmation)
- `googlecalendar.quick_add_event` — Quick add event from text (requires confirmation)
- `googlecalendar.update_event` — Update an existing event (requires confirmation)
- `googlecalendar.delete_event` — Delete a calendar event (requires confirmation)

## Confirmation Required

Always ask for user confirmation before:
- Sending emails (`gmail.send_email`, `gmail.reply_email`, `gmail.reply_to_thread`)
- Creating calendar events (`googlecalendar.create_event`, `googlecalendar.quick_add_event`)
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
- User: "קבע לי פגישה מחר ב-10" → Check availability, then create with confirmation
- User: "שלח מייל ל-..." → Use `gmail.send_email` with confirmation

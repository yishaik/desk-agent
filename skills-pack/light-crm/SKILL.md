---
name: Light CRM / Follow-up
description: Simple contact management and follow-up tracking using notes and tasks - no heavy CRM needed
---

# Light CRM Skill

Use this skill when the user wants to track contacts, log interactions, or manage follow-ups.

## Required Services

One of:
- **notion** — For contact database and notes
- **airtable** — Alternative database option
- **trello** — Task-based tracking

Optional:
- **googletasks** — For follow-up reminders

## Available Actions

### Notion Actions

- `notion.search` — Search for contacts or notes
- `notion.get_page` — Get contact details
- `notion.create_page` — Add a new contact (requires confirmation)
- `notion.update_page` — Update contact info (requires confirmation)
- `notion.query_database` — Query contacts database
- `notion.create_database_item` — Add contact to database (requires confirmation)

### Google Tasks Actions

- `googletasks.list_task_lists` — List task lists
- `googletasks.list_tasks` — List follow-up tasks
- `googletasks.create_task` — Create a follow-up reminder (requires confirmation)
- `googletasks.update_task` — Update a task
- `googletasks.complete_task` — Mark task as done

## Confirmation Required

Always ask for user confirmation before:
- Creating new contacts (`notion.create_page`, `notion.create_database_item`)
- Updating contact information (`notion.update_page`)
- Creating follow-up tasks (`googletasks.create_task`)

## Contact Schema

When managing contacts, track:
- **name** — Contact name
- **company** — Company or organization
- **email** — Email address
- **phone** — Phone number
- **context** — How you met / relationship context
- **lastContact** — Date of last interaction
- **nextFollowUp** — When to follow up
- **notes** — Additional notes
- **status** — Active, dormant, etc.

## Common Tasks

### Add Contact
When asked to add a contact:
1. Ask for name and context (how they met)
2. Ask for optional details (email, phone, company)
3. Set a follow-up date if relevant
4. Use `notion.create_database_item` with confirmation

### Follow-up List
When asked "who should I follow up with?":
1. Use `notion.query_database` to find:
   - Overdue follow-ups
   - Upcoming follow-ups this week
   - Recently added contacts without follow-up dates
2. Present as a prioritized list

### Log Interaction
When logging an interaction:
1. Ask who they met/talked to
2. Ask what was discussed
3. Ask about action items
4. Ask when to follow up next
5. Use `notion.update_page` with confirmation

### Search Contacts
When searching:
1. Use `notion.search` with the query
2. Show matching contacts with context
3. Offer to show full details

## Examples

- User: "הוסף איש קשר חדש - דני מחברת ABC" → Gather details, then create with confirmation
- User: "עם מי אני צריך לדבר השבוע?" → Query database for this week's follow-ups
- User: "נפגשתי היום עם דני, עדכן" → Ask what was discussed, then update with confirmation
- User: "מצא לי את הפרטים של יוסי" → Search and show contact details

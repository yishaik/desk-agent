# Desk Agent Skill Packs

Selected in **Settings → סקילים** (`settings.skillPacks`, default `inbox-calendar`). Both engines load the selected packs: Pi through its skill loader (`additionalSkillPaths`), Claude Code through the system prompt. Add a pack with `skills-pack/<id>/SKILL.md` (`name`/`description` frontmatter + instructions).

Pre-built skill configurations for common SMB use cases. Each skill pack is a directory containing a `SKILL.md` file with:

- YAML frontmatter (name, description)
- Required services (Open Connector providers)
- Available actions with correct catalog IDs
- Instructions for common tasks
- Confirmation requirements for sensitive actions
- Example interactions

## Available Packs

### 📬 Inbox & Calendar (`inbox-calendar/`)

Email and calendar management using Gmail and Google Calendar.

**Features:**
- Read and search emails
- Send emails with confirmation
- View and manage calendar events
- Schedule meetings with availability check
- Daily briefing summaries

**Required Services:** `gmail`, `googlecalendar`

**Actions:**
- `gmail.fetch_emails`, `gmail.get_message`, `gmail.search_threads`, `gmail.list_threads`
- `gmail.send_email`, `gmail.reply_email`, `gmail.reply_to_thread`
- `googlecalendar.list_events`, `googlecalendar.list_events_all_calendars`, `googlecalendar.get_event`, `googlecalendar.find_event`
- `googlecalendar.create_event`, `googlecalendar.quick_add_event`, `googlecalendar.update_event`, `googlecalendar.delete_event`

### 👥 Light CRM (`light-crm/`)

Simple contact management and follow-up tracking without heavy CRM software.

**Features:**
- Track contacts with context
- Set follow-up reminders
- Log interactions
- Search contact history
- Weekly follow-up lists

**Required Services:** `notion` or `airtable`, optionally `googletasks`

### 🏪 Storefront FAQ (`storefront-faq/`)

Answer common business questions from your knowledge base.

**Features:**
- Business hours and location
- Product/service information
- Pricing lookups
- Policy explanations
- Custom FAQ entries

**Required Services:** None (uses stored settings), optionally `notion` or `googledrive` for extended KB

## Using Skill Packs

Skill packs are automatically loaded by Pi from the `skills-pack/` directory via `additionalSkillPaths`. Each skill directory must contain a `SKILL.md` file.

To use a skill:
1. Ensure the skill directory exists in `skills-pack/`
2. Connect required services in Open Connector
3. The skill will be available to the agent automatically

## Creating Custom Skill Packs

Create a new directory under `skills-pack/` with a `SKILL.md` file:

```markdown
---
name: Your Skill Name
description: What this skill does
---

# Your Skill Name

Use this skill when the user wants to...

## Required Services

- **servicename** — Description

## Available Actions

- `servicename.action_name` — Description

## Confirmation Required

Always ask for user confirmation before:
- Dangerous actions

## Common Tasks

### Task Name
1. Step one
2. Step two

## Examples

- User: "Example request" → Use `servicename.action_name`
```

### Best Practices

1. **Confirmation gates:** Always require confirmation for actions that modify, send, or delete data
2. **Clear instructions:** Write clear task flows that guide the agent
3. **Use real catalog IDs:** Use exact Open Connector action IDs (e.g., `googlecalendar` not `google-calendar`)
4. **Examples:** Include Hebrew and English examples if your users speak both

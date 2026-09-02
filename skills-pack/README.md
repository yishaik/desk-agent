# Desk Agent Skill Packs

Pre-built skill configurations for common SMB use cases. Each skill pack is a
`SKILL.md` file that Pi loads via `additionalSkillPaths`.

## Directory Structure

```
skills-pack/
├── inbox-calendar/
│   └── SKILL.md    # Email and calendar management
├── light-crm/
│   └── SKILL.md    # Contact tracking and follow-ups
├── storefront-faq/
│   └── SKILL.md    # Answer business questions
└── README.md
```

## Available Packs

### 📬 Inbox & Calendar (`inbox-calendar/SKILL.md`)

Email and calendar management using Gmail and Google Calendar.

**Features:**
- Read and search emails
- Send emails with confirmation
- View and manage calendar events
- Schedule meetings with availability check
- Daily briefing summaries

**Required Services:** `gmail`, `googlecalendar`

**Key Actions:**
- `gmail.fetch_emails` — Get recent emails
- `gmail.search_threads` — Search email threads
- `gmail.send_email` — Send email (confirmation required)
- `googlecalendar.list_events` — List upcoming events
- `googlecalendar.create_event` — Create event (confirmation required)

### 👥 Light CRM (`light-crm/SKILL.md`)

Simple contact management and follow-up tracking without heavy CRM software.

**Features:**
- Track contacts with context
- Set follow-up reminders
- Log interactions
- Search contact history
- Weekly follow-up lists

**Required Services:** `notion` or `airtable`, optionally `googletasks`

**Key Actions:**
- `notion.search` — Find contacts
- `notion.create_database_item` — Add contact (confirmation required)
- `notion.update_page` — Update contact (confirmation required)
- `googletasks.create_task` — Set follow-up reminder

### 🏪 Storefront FAQ (`storefront-faq/SKILL.md`)

Answer common business questions from your knowledge base.

**Features:**
- Business hours and location
- Product/service information
- Pricing lookups
- Policy explanations
- Custom FAQ entries

**Required Services:** None (uses stored settings), optionally `notion` for extended KB

**Key Actions:**
- `notion.search` — Search knowledge base
- `notion.get_page` — Get specific FAQ page

## How Pi Loads Skills

Pi scans directories in `additionalSkillPaths` looking for `SKILL.md` files.
Each SKILL.md has:

1. **Frontmatter** — YAML header with `name` and `description`
2. **Instructions** — Markdown body with usage guidance
3. **Action IDs** — Reference real Open Connector catalog IDs

Example frontmatter:

```yaml
---
name: Inbox & Calendar
description: Email inbox management and calendar operations
---
```

## Action ID Reference

Use the **exact** Open Connector service and action IDs:

| Service | ID in OC | Example Actions |
|---------|----------|-----------------|
| Gmail | `gmail` | `gmail.fetch_emails`, `gmail.search_threads` |
| Google Calendar | `googlecalendar` | `googlecalendar.list_events`, `googlecalendar.create_event` |
| Notion | `notion` | `notion.search`, `notion.create_page` |
| Google Tasks | `googletasks` | `googletasks.list_tasks`, `googletasks.create_task` |
| Google Drive | `googledrive` | `googledrive.search_files` |

**Note:** Service IDs are lowercase without hyphens (e.g., `googlecalendar` not `google-calendar`).

## Creating Custom Skills

1. Create a directory: `skills-pack/my-skill/`
2. Add `SKILL.md` with frontmatter and instructions
3. Reference real action IDs from the Open Connector catalog
4. Include confirmation requirements for sensitive actions

```markdown
---
name: My Custom Skill
description: What this skill does
---

# My Custom Skill

Use this skill when...

## Required Services
- **service_name** — Description

## Available Actions
- `service.action_name` — Description

## Confirmation Required
- `service.dangerous_action` — Always confirm before executing
```

## Best Practices

1. **Confirmation gates:** Always require confirmation for actions that modify, send, or delete data
2. **Clear instructions:** Guide the AI to ask for confirmation before taking action
3. **Real IDs:** Use exact Open Connector catalog IDs (check `/v1/actions`)
4. **Examples:** Include Hebrew and English examples if your users speak both

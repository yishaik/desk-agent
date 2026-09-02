---
name: Storefront FAQ
description: Answer common business questions using your knowledge base - product info, policies, hours, pricing
---

# Storefront FAQ Skill

Use this skill when the user needs to answer common business questions or manage their FAQ knowledge base.

## Required Services

Optional (for extended knowledge base):
- **notion** — Document-based FAQ storage
- **googledrive** — File-based knowledge

## Available Actions

### Notion Actions (optional)

- `notion.search` — Search knowledge base
- `notion.get_page` — Get specific FAQ page
- `notion.create_page` — Create new FAQ entry (requires confirmation)
- `notion.update_page` — Update FAQ entry (requires confirmation)

### Google Drive Actions (optional)

- `googledrive.search_files` — Search for documents
- `googledrive.get_file` — Get document content

## Knowledge Categories

Organize business information by category:
- **hours** — Operating hours and availability
- **location** — Address and service area
- **products** — Product catalog and details
- **services** — Service offerings
- **pricing** — Prices and payment options
- **policies** — Returns, shipping, terms
- **contact** — How to reach the business
- **faq** — Frequently asked questions

## Common Tasks

### Answer Business Question
When someone asks about the business:
1. Check if info is in settings/context first
2. If not, search knowledge base with `notion.search` or `googledrive.search_files`
3. Provide accurate answer based on found info
4. For complex queries, offer to connect them with the owner

### Setup Knowledge Base
When setting up FAQ:
1. Ask for business name and type
2. Ask for operating hours
3. Ask for location / service area
4. Ask for key products or services
5. Ask about common customer questions
6. Ask about policies (returns, shipping, etc.)
7. Help organize into categories

### Update Business Info
When info changes:
1. Ask what changed (hours, prices, policies, etc.)
2. Update the relevant knowledge base entry
3. Confirm the change

## Fallback Behavior

When you don't have specific information:
- Say: "I don't have specific information about that. Would you like me to note this question so you can add the answer later?"
- Track unanswered questions for the owner to address

## Examples

- User: "מתי אתם פתוחים?" → Check settings or search for hours info
- User: "כמה עולה X?" → Search pricing information in knowledge base
- User: "מה מדיניות ההחזרות?" → Search for return policy documentation
- User: "איפה אתם נמצאים?" → Provide location from settings or knowledge base

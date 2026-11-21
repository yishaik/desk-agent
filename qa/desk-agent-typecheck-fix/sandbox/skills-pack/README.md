# Desk Agent Skill Packs

Pre-built skill configurations for common SMB use cases. Each skill pack defines:

- Required services (Open Connector providers)
- Available actions
- System prompts for common tasks
- Confirmation requirements for sensitive actions
- Example interactions

## Available Packs

### 📬 Inbox & Calendar (`inbox-calendar.json`)

Email and calendar management using Gmail and Google Calendar.

**Features:**
- Read and search emails
- Send emails with draft preview
- View and manage calendar events
- Schedule meetings with availability check
- Daily briefing summaries

**Required Services:** `gmail`, `google-calendar`

### 👥 Light CRM (`light-crm.json`)

Simple contact management and follow-up tracking without heavy CRM software.

**Features:**
- Track contacts with context
- Set follow-up reminders
- Log interactions
- Search contact history
- Weekly follow-up lists

**Required Services:** `notion` or `airtable`, optionally `google-tasks`

### 🏪 Storefront FAQ (`storefront-faq.json`)

Answer common business questions from your knowledge base.

**Features:**
- Business hours and location
- Product/service information
- Pricing lookups
- Policy explanations
- Custom FAQ entries

**Required Services:** None (uses stored settings), optionally `notion` for extended KB

## Using Skill Packs

1. **Copy to your agent:**
   ```bash
   cp skills-pack/inbox-calendar.json .pi/skills/
   ```

2. **Enable in Settings:**
   - Open the Web UI Settings page
   - Enable the skill pack
   - Connect required services in Open Connector

3. **Customize prompts:**
   Edit the JSON file to adjust prompts for your business context.

## Creating Custom Skill Packs

Use the provided packs as templates:

```json
{
  "id": "your-skill-id",
  "name": "Your Skill Name",
  "description": "What this skill does",
  "version": "1.0.0",
  "requiredServices": ["service1", "service2"],
  "actions": [
    "service1.action_name",
    "service2.other_action"
  ],
  "prompts": {
    "task_name": "System prompt for this task..."
  },
  "confirmationRequired": [
    "service1.dangerous_action"
  ],
  "examples": [
    {
      "user": "Example user message",
      "assistant": "Expected assistant response",
      "action": "service1.action_name"
    }
  ]
}
```

### Best Practices

1. **Confirmation gates:** Always require confirmation for actions that modify, send, or delete data
2. **Clear prompts:** Write prompts that guide the AI to ask for confirmation before taking action
3. **Service fallbacks:** Use `alternativeServices` for flexibility
4. **Examples:** Include Hebrew and English examples if your users speak both

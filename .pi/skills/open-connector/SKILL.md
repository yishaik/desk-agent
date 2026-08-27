# Open Connector Integration

Use this skill when the user wants to interact with external services like Gmail, Google Calendar, Notion, Slack, or any of the 1000+ services supported by Open Connector.

## Available Tools

You have access to these Open Connector tools:

1. **oc_search_actions** - Search for available actions. Use this first to discover what you can do.
2. **oc_get_action_guide** - Get detailed documentation for an action before executing it.
3. **oc_execute_action** - Execute an action. ALWAYS get confirmation for send/create/delete operations.
4. **oc_list_connections** - Check which services are connected.

## Workflow

1. **Discover**: Use `oc_search_actions` to find relevant actions
2. **Understand**: Use `oc_get_action_guide` to get the input schema and requirements
3. **Confirm**: For actions that modify data (send, create, update, delete), describe what you're about to do and ask for confirmation
4. **Execute**: Use `oc_execute_action` with the correct input

## Confirmation Required

ALWAYS ask for explicit user confirmation before executing:
- Sending emails or messages
- Creating calendar events or tasks
- Updating or deleting any resource
- Posting to external services
- Any action that has side effects

## Example Interactions

### Checking email
User: "Do I have any new emails?"

1. Search: `oc_search_actions` with query "list emails gmail"
2. Guide: `oc_get_action_guide` for "gmail.list_messages"  
3. Execute: `oc_execute_action` with appropriate filters

### Scheduling a meeting
User: "Schedule a meeting tomorrow at 2pm"

1. Search: `oc_search_actions` with query "create calendar event"
2. Guide: `oc_get_action_guide` for "google-calendar.create_event"
3. Ask user: "I'll create an event for tomorrow at 2pm. What's the title and who should I invite?"
4. After confirmation: `oc_execute_action` with confirmed: true

### Sending email
User: "Send an email to john@example.com"

1. Search: `oc_search_actions` with query "send email"
2. Guide: `oc_get_action_guide` for "gmail.send_email"
3. Draft the email content
4. Ask user: "Here's the draft email. Should I send it?"
5. Only after explicit "yes": `oc_execute_action` with confirmed: true

## Error Handling

- If an action fails, explain the error clearly
- Suggest checking if the service is connected (`oc_list_connections`)
- Offer alternative approaches if available

## Security

- Never expose API keys or tokens in responses
- The Open Connector runtime handles all authentication
- Credentials stay server-side and are never sent to the model

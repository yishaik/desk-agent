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
3. **Execute**: Use `oc_execute_action` with the correct input
4. **Confirm (mutating actions only)**: the tool does NOT execute send/reply/create/update/delete actions. It records a pending request and returns a confirmation message. Describe to the user exactly what will happen and ask them to reply "yes" (or "אשר"). The approval is handled outside of you.

## Confirmation Protocol

- You cannot approve an action yourself — there is no parameter for it. Do not call `oc_execute_action` again for the same action; that only creates another pending request.
- Never claim an action was sent/created unless a tool result or a system note in the conversation says it was executed.
- After the user approves, the action runs outside your turn; your next turn starts with a system note describing what ran and its result.

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
4. `oc_execute_action` — returns a confirmation request (not executed yet)
5. Tell the user what will be created and ask them to reply "yes"; the event is created outside your turn after they do

### Sending email
User: "Send an email to john@example.com"

1. Search: `oc_search_actions` with query "send email"
2. Guide: `oc_get_action_guide` for "gmail.send_email"
3. Draft the email content and show it to the user
4. `oc_execute_action` — returns a confirmation request (not sent yet)
5. Tell the user: "Reply yes to send." The email is sent outside your turn after they approve; do not call the tool again

## Error Handling

- If an action fails, explain the error clearly
- Suggest checking if the service is connected (`oc_list_connections`)
- Offer alternative approaches if available

## Security

- Never expose API keys or tokens in responses
- The Open Connector runtime handles all authentication
- Credentials stay server-side and are never sent to the model

# RBAC and Approval Workflow Specification

This document specifies the Role-Based Access Control (RBAC) and tool approval workflow for agent packs.

## Overview

The agent supports a flexible, credential-driven role system where:

- Roles are extracted from the authenticated user's verifiable credential.
- Tool access is granted per role, per MCP server.
- Certain tools can require approval from users holding specific roles before execution.
- There is no hardcoded "admin" concept — all roles are deployer-defined.

---

## 1. Authentication and Role Resolution

### Schema

```yaml
flows:
  authentication:
    required: true                        # true = guests cannot send messages
    credentialDefinitionId: ${CREDENTIAL_DEFINITION_ID}
    userIdentityAttribute: email          # credential attribute that uniquely identifies the user
    rolesAttribute: roles                 # credential attribute containing the user's role(s)
    defaultRole: user                     # role assigned when rolesAttribute is absent or empty
    adminUsers: [admin@company.com]       # users granted all roles by identity (bootstrap only)
```

### Fields

| Field                    | Type     | Required | Description |
| ------------------------ | -------- | -------- | ----------- |
| `required`               | boolean  | no       | When `true`, unauthenticated users cannot send messages. They receive the welcome message and authentication instructions only. Default: `false`. |
| `credentialDefinitionId` | string   | yes      | Verifiable credential definition ID used for proof requests. |
| `userIdentityAttribute`  | string   | yes      | Credential attribute that uniquely identifies the user (e.g., `name`, `email`, `employeeLogin`). |
| `rolesAttribute`         | string   | no       | Credential attribute containing the user's roles. Accepts a single string, comma-separated list, or JSON array. |
| `defaultRole`            | string   | no       | Role assigned to authenticated users whose credential lacks the `rolesAttribute` or has it empty. Default: `user`. |
| `adminUsers`             | string[] | no       | List of identity values (matched against `userIdentityAttribute`) that bypass role checks and have access to all tools. Intended for initial bootstrap before proper role credentials are issued. Replaces the legacy `adminAvatars` field. |

### Role resolution logic

1. User authenticates by presenting a verifiable credential matching `credentialDefinitionId`.
2. Extract the unique identity from `userIdentityAttribute`.
3. If `rolesAttribute` is defined and present in the credential, parse it into a set of roles.
4. If `rolesAttribute` is absent or empty, assign `defaultRole`.
5. If the user's identity is in `adminUsers`, grant access to all tools regardless of roles.

---

## 2. Guest Access

When `flows.authentication.required` is `false`:

- Unauthenticated users (guests) can send messages to the agent.
- Guest tool access is controlled via the `guest` role in `toolAccess.roles`.
- Guests see only menu items with `visibleWhen: always` or `visibleWhen: unauthenticated`.

When `flows.authentication.required` is `true`:

- Unauthenticated users receive the welcome message and a prompt to authenticate.
- Any messages sent before authentication are ignored (no response from the agent).

---

## 3. Per-Role Tool Access

### Schema

Tool access is defined per MCP server under `toolAccess.roles`:

```yaml
mcp:
  servers:
    - name: wise
      transport: streamable-http
      url: ${WISE_MCP_URL}
      accessMode: admin-controlled
      headers:
        Authorization: "Bearer ${WISE_API_TOKEN}"
      toolAccess:
        default: none
        roles:
          guest: [get_exchange_rate]
          employee: [list_profiles, get_balances, list_transfers]
          finance: [send_money, create_invoice, list_recipients]
          auditor: [list_transfers, get_transfer_status, get_balances]
```

### Fields

| Field                  | Type                   | Description |
| ---------------------- | ---------------------- | ----------- |
| `toolAccess.default`   | enum: `none`, `all`    | Default access when a tool is not listed in any role. `none` = unlisted tools are blocked. `all` = unlisted tools are available to all authenticated users. |
| `toolAccess.roles`     | map<string, string[]>  | Map of role name to list of tool names. The special role `guest` applies to unauthenticated users. |

### Access resolution

1. Collect the user's roles (see Section 1).
2. For each role, look up the tool list in `toolAccess.roles`.
3. The user's effective tool set is the **union** of all their roles' tool lists.
4. If a tool is not listed in any role and `default` is `none`, it is blocked.
5. If a tool is not listed in any role and `default` is `all`, it is available to any authenticated user.
6. Users in `adminUsers` bypass this check entirely.

---

## 4. Approval Workflow

The approval workflow allows certain tools to require explicit approval from users holding designated approver roles before execution. Approval is only available for MCP servers with `accessMode: admin-controlled` (shared connection).

### Schema

```yaml
mcp:
  servers:
    - name: wise
      accessMode: admin-controlled
      toolAccess:
        default: none
        roles:
          employee: [list_profiles, get_balances, list_transfers]
          finance: [send_money, create_invoice, list_recipients]
        approval:
          - tools: [send_money]
            approvers: [finance-manager, cfo]
            timeoutMinutes: 60
          - tools: [create_invoice]
            approvers: [finance-manager]
            timeoutMinutes: 120
```

### Approval policy fields

| Field            | Type     | Required | Default | Description |
| ---------------- | -------- | -------- | ------- | ----------- |
| `tools`          | string[] | yes      | —       | Tools covered by this approval policy. |
| `approvers`      | string[] | yes      | —       | Roles that can approve requests for these tools. |
| `timeoutMinutes` | number   | no       | 60      | Time before a pending request expires. |

### Self-approval rule

If a user holds **both** a role that grants access to the tool **and** a role listed in `approvers` for that tool, the tool executes immediately without an approval prompt.

### Request lifecycle

```
PENDING ──→ APPROVED ──→ (tool executes, result sent to requester)
   │
   ├──→ REJECTED (by approver)
   ├──→ CANCELLED (by requester)
   └──→ EXPIRED (timeout reached)
```

Each state transition triggers:
- **Contextual menu update** for all related parties (requester + approvers).
- **Notification message** to all related parties.

---

## 5. UX: Requester Flow

### Step 1: Tool invocation

User asks the agent to perform an action that maps to an approval-required tool.

### Step 2: Confirmation prompt

Agent sends a **question message**:

> "Sending 100 EUR to John requires approval from a finance-manager or cfo. Submit approval request?"
> **[Yes]** / **[No]**

### Step 3: Request submitted

On **Yes**:
- Approval request is created with status `PENDING`.
- Requester receives a notification: _"Your request has been submitted. You'll be notified when it's processed."_
- Requester's contextual menu updates: `"(n) approval requests"` entry appears or count increments.
- All online approvers receive a notification and their menu updates.

On **No**:
- No request is created. Agent responds: _"Request cancelled."_

### Step 4: Monitoring

Requester's contextual menu shows:

```
(2) approval requests
```

Clicking this entry shows a list of their pending requests. The requester can select one and **cancel** it.

### Step 5: Resolution

When the request is approved, rejected, cancelled, or expired:
- Requester receives a notification message with the outcome.
- Menu count decrements. Entry disappears when count reaches 0.
- If approved, the tool executes and the result is sent to the requester as a message.

---

## 6. UX: Approver Flow

### Step 1: Notification

When a new approval request is created, all users holding an approver role for that tool receive:
- A **notification message**: _"New approval request from user@company.com: send 100 EUR to John."_
- Their contextual menu updates: `"(n) pending approvals"` entry appears or count increments.

### Step 2: Review

Approver's contextual menu shows:

```
(3) pending approvals
```

Clicking this entry shows the list of pending requests they can act on, with details (requester, tool, arguments, timestamp).

### Step 3: Action

Approver selects a request and chooses **Approve** or **Reject**.

On **Approve**:
- Request status changes to `APPROVED`.
- Tool executes on the shared MCP connection.
- Requester receives the tool result as a message.
- All other approvers see the request disappear from their pending list (first approver wins).
- Menu counts update for all parties.

On **Reject**:
- Request status changes to `REJECTED`.
- Requester receives a notification with the rejection.
- Request disappears from all approvers' pending lists.
- Menu counts update for all parties.

---

## 7. Contextual Menu Items

```yaml
flows:
  menu:
    items:
      # Visible to users who have pending approval requests they submitted
      - id: my-approval-requests
        labelKey: MY_APPROVAL_REQUESTS
        action: my-approval-requests
        visibleWhen: hasApprovalRequests
        badge: approvalRequestCount

      # Visible to users who can approve pending requests
      - id: pending-approvals
        labelKey: PENDING_APPROVALS
        action: pending-approvals
        visibleWhen: hasPendingApprovals
        badge: pendingApprovalCount
```

### Dynamic `visibleWhen` values

| Value                  | Condition |
| ---------------------- | --------- |
| `hasApprovalRequests`  | User has at least one pending approval request they submitted. |
| `hasPendingApprovals`  | User holds an approver role and there is at least one pending request they can act on. |

These menu items are automatically managed by the approval system. The deployer includes them in the menu configuration; the agent handles visibility and badge counts dynamically.

---

## 8. State Change Side Effects

Every approval state transition triggers the following:

| Event     | Requester effect | Approvers effect |
| --------- | ---------------- | ---------------- |
| Created   | Menu: `(n) approval requests` increments. Confirmation message sent. | Menu: `(n) pending approvals` increments. Notification message sent. |
| Approved  | Menu decrements. Notification: _"Your request was approved."_ Tool result delivered. | Menu decrements for all. Notification to others: _"Request was approved by {approver}."_ |
| Rejected  | Menu decrements. Notification: _"Your request was rejected."_ | Menu decrements for all. |
| Cancelled | Menu decrements. | Menu decrements for all. Notification: _"Request was cancelled by requester."_ |
| Expired   | Menu decrements. Notification: _"Your request expired."_ | Menu decrements for all. |

---

## 9. Persistence

Approval requests must be persisted (PostgreSQL recommended) to survive agent restarts. Each request stores:

| Field        | Type      | Description |
| ------------ | --------- | ----------- |
| `id`         | UUID      | Unique request identifier. |
| `serverName` | string    | MCP server name. |
| `toolName`   | string    | Tool name. |
| `args`       | JSON      | Tool invocation arguments. |
| `requester`  | string    | Requester identity (from `userIdentityAttribute`). |
| `status`     | enum      | `pending`, `approved`, `rejected`, `cancelled`, `expired`. |
| `approver`   | string    | Identity of the user who approved/rejected (null if pending). |
| `createdAt`  | timestamp | When the request was created. |
| `resolvedAt` | timestamp | When the request was resolved (null if pending). |
| `expiresAt`  | timestamp | When the request expires. |

---

## 10. Backward Compatibility

- The legacy `adminAvatars` field is replaced by `adminUsers`.
- The legacy `toolAccess.default: public | admin` and `toolAccess.public: [...]` format is still supported for backward compatibility. It maps to:
  - `public` → tools listed are in the `guest` role
  - `admin` → tools listed are accessible only to `adminUsers`
- When `rolesAttribute` is not configured and no `toolAccess.roles` are defined, the agent falls back to the legacy binary access model.

---

## 11. Complete Example

```yaml
flows:
  authentication:
    required: true
    credentialDefinitionId: did:webvh:...:corp-badge
    userIdentityAttribute: employeeLogin
    rolesAttribute: roles
    defaultRole: employee
    adminUsers: [admin@company.com]
  welcome:
    enabled: true
    sendOnProfile: true
    templateKey: greetingMessage
  menu:
    items:
      - id: authenticate
        labelKey: CREDENTIAL
        action: authenticate
        visibleWhen: unauthenticated
      - id: logout
        labelKey: LOGOUT
        action: logout
        visibleWhen: authenticated
      - id: my-approval-requests
        labelKey: MY_APPROVAL_REQUESTS
        action: my-approval-requests
        visibleWhen: hasApprovalRequests
        badge: approvalRequestCount
      - id: pending-approvals
        labelKey: PENDING_APPROVALS
        action: pending-approvals
        visibleWhen: hasPendingApprovals
        badge: pendingApprovalCount

mcp:
  servers:
    - name: wise
      transport: streamable-http
      url: ${WISE_MCP_URL}
      accessMode: admin-controlled
      headers:
        Authorization: "Bearer ${WISE_API_TOKEN}"
      toolAccess:
        default: none
        roles:
          guest: [get_exchange_rate]
          employee: [list_profiles, get_balances, list_transfers]
          finance: [send_money, create_invoice, list_recipients]
          auditor: [list_transfers, get_transfer_status, get_balances]
        approval:
          - tools: [send_money]
            approvers: [finance-manager, cfo]
            timeoutMinutes: 60
          - tools: [create_invoice]
            approvers: [finance-manager]
            timeoutMinutes: 120

languages:
  en:
    strings:
      MY_APPROVAL_REQUESTS: "Approval requests"
      PENDING_APPROVALS: "Pending approvals"
  es:
    strings:
      MY_APPROVAL_REQUESTS: "Solicitudes de aprobación"
      PENDING_APPROVALS: "Aprobaciones pendientes"
```

---

## 12. Implementation Architecture

This section describes how RBAC and approval are implemented as a generic middleware layer that works with any MCP server using `admin-controlled` accessMode.

### Current tool execution flow

```text
User message → LLM → decides to call tool → McpService.callTool() → MCP server → result → LLM → response
```

### New flow with RBAC + approval

```text
User message → LLM (filtered tools) → decides to call tool → ToolCallInterceptor →
  ├─ ALLOW     → McpService.callTool() → result → LLM → response
  ├─ DENY      → "Tool not available for your role" → LLM handles gracefully
  └─ APPROVAL  →
       ├─ user holds approver role → self-approve → McpService.callTool() → result
       └─ queue → ApprovalService.create() → notify approvers → "Request submitted"
                    └─ (later) approved → McpService.callTool() → deliver result as message
```

### Components

#### 12.1 `RbacService`

Pure configuration-driven service. No MCP dependency.

```typescript
class RbacService {
  /**
   * Extract roles from a verified credential's attributes.
   * Parses rolesAttribute as a single string, comma-separated list, or JSON array.
   * Falls back to defaultRole if rolesAttribute is absent or empty.
   */
  resolveRoles(credentialAttributes: Record<string, string>): string[]

  /**
   * Determine access for a user+tool combination.
   * Returns ALLOW, DENY, or APPROVAL based on toolAccess.roles and toolAccess.approval.
   */
  checkAccess(userRoles: string[], serverName: string, toolName: string): AccessDecision

  /**
   * Check if the user holds any approver role for a specific tool's approval policy.
   */
  isApprover(userRoles: string[], serverName: string, toolName: string): boolean
}

type AccessDecision = 'ALLOW' | 'DENY' | 'APPROVAL'
```

**Inputs:** user roles (from credential), server name, tool name.
**Config source:** `toolAccess.roles` and `toolAccess.approval` from agent-pack.yaml.
**No knowledge of:** MCP server internals, tool arguments, or transport.

#### 12.2 `ApprovalService`

Manages the approval request lifecycle. Backed by PostgreSQL for persistence across restarts.

```typescript
class ApprovalService {
  /** Create a pending approval request and emit 'approval.created' event. */
  create(request: CreateApprovalDto): Promise<ApprovalRequest>

  /** Approve or reject a request. First approver wins. Emits 'approval.resolved'. */
  resolve(requestId: string, action: 'approve' | 'reject', resolverIdentity: string): Promise<void>

  /** Cancel a request (by the requester). Emits 'approval.resolved'. */
  cancel(requestId: string, requesterIdentity: string): Promise<void>

  /** Get all pending requests submitted by a specific user. */
  getByRequester(identity: string): Promise<ApprovalRequest[]>

  /** Get all pending requests that a user with the given roles can approve. */
  getPendingForApprover(approverRoles: string[]): Promise<ApprovalRequest[]>

  /** Expire stale requests past their timeout. Called periodically. */
  expireStale(): Promise<void>
}

interface CreateApprovalDto {
  serverName: string
  toolName: string
  args: Record<string, unknown>
  requesterIdentity: string
  requesterAvatarName: string
  expiresAt: Date
}
```

#### 12.3 `ToolCallInterceptor`

The central integration point. Wraps `McpService.callTool()` with RBAC checks and approval logic.

```typescript
class ToolCallInterceptor {
  constructor(
    private rbacService: RbacService,
    private approvalService: ApprovalService,
    private mcpService: McpService,
  ) {}

  async execute(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    userContext: UserContext,
  ): Promise<ToolCallResult> {
    const decision = this.rbacService.checkAccess(
      userContext.roles, serverName, toolName,
    )

    switch (decision) {
      case 'ALLOW':
        return { type: 'result', data: await this.mcpService.callTool(serverName, toolName, args) }

      case 'DENY':
        return { type: 'denied', message: `Tool "${toolName}" is not available for your role.` }

      case 'APPROVAL':
        // Self-approval: user holds both tool access and approver role
        if (this.rbacService.isApprover(userContext.roles, serverName, toolName)) {
          return { type: 'result', data: await this.mcpService.callTool(serverName, toolName, args) }
        }
        // Queue for approval
        const request = await this.approvalService.create({
          serverName, toolName, args,
          requesterIdentity: userContext.identity,
          requesterAvatarName: userContext.avatarName,
          expiresAt: this.computeExpiry(serverName, toolName),
        })
        return { type: 'pending_approval', requestId: request.id }
    }
  }
}
```

#### 12.4 `ApprovalEventHandler`

Reacts to approval lifecycle events. Responsible for menu updates and DIDComm notifications.

```typescript
class ApprovalEventHandler {
  @OnEvent('approval.created')
  async onCreated(request: ApprovalRequest): Promise<void> {
    // Update requester's contextual menu badge
    await this.menuService.updateBadge(request.requesterAvatarName, 'my-approval-requests', +1)

    // Find all connected users with approver roles and notify them
    const approverRoles = this.getApproverRoles(request.serverName, request.toolName)
    const approvers = await this.sessionService.findUsersByRoles(approverRoles)
    for (const approver of approvers) {
      await this.menuService.updateBadge(approver.avatarName, 'pending-approvals', +1)
      await this.messagingService.sendNotification(approver.avatarName,
        `New approval request from ${request.requesterIdentity}: ${request.toolName}`)
    }
  }

  @OnEvent('approval.resolved')
  async onResolved(request: ApprovalRequest): Promise<void> {
    if (request.status === 'approved') {
      // Execute the tool on the shared admin-controlled connection
      const result = await this.mcpService.callTool(
        request.serverName, request.toolName, request.args)
      // Deliver result to the requester as a chat message
      await this.messagingService.sendMessage(request.requesterAvatarName,
        `Your request was approved. Result:\n${result}`)
    } else {
      await this.messagingService.sendNotification(request.requesterAvatarName,
        `Your request for "${request.toolName}" was ${request.status}.`)
    }

    // Decrement badges for all related parties
    await this.menuService.updateBadge(request.requesterAvatarName, 'my-approval-requests', -1)
    const approvers = await this.sessionService.findUsersByRoles(
      this.getApproverRoles(request.serverName, request.toolName))
    for (const approver of approvers) {
      await this.menuService.updateBadge(approver.avatarName, 'pending-approvals', -1)
    }
  }
}
```

### LLM tool filtering

An important optimization: tools the user cannot access are **not exposed to the LLM** at all. This prevents the LLM from attempting to call tools that would be denied and provides a cleaner conversation experience.

```typescript
getToolsForUser(serverName: string, userRoles: string[]): ToolDefinition[] {
  const allTools = this.mcpService.getToolsForServer(serverName)
  return allTools.filter(tool => {
    const decision = this.rbacService.checkAccess(userRoles, serverName, tool.name)
    return decision !== 'DENY'  // expose ALLOW and APPROVAL tools
  })
}
```

Tools requiring approval remain visible to the LLM — the user can invoke them, but execution is intercepted by the `ToolCallInterceptor`.

### Why this is generic

The RBAC + approval layer depends only on:

| Input | Source | MCP-specific? |
| ----- | ------ | ------------- |
| Server name | From the tool call | No — just a string identifier |
| Tool name | From the tool call | No — just a string identifier |
| User roles | From the verified credential | No — credential-driven |
| Access policies | From `agent-pack.yaml` config | No — deployer-defined |
| Tool execution | `McpService.callTool()` (unchanged) | Existing interface |

The system never inspects tool arguments semantically or requires knowledge of what any MCP server does. Any MCP server with `accessMode: admin-controlled` automatically gets RBAC and approval support by declaring `toolAccess.roles` and `toolAccess.approval` policies in the YAML.

### Changes to existing code

| Component | Change |
| --------- | ------ |
| `McpService` | **No changes.** `callTool()` stays as-is. |
| LLM tool binding | Route through `ToolCallInterceptor` instead of calling `McpService.callTool()` directly. Filter tools per user via `getToolsForUser()`. |
| Menu system | Add dynamic `badge` field support. Add `hasApprovalRequests` and `hasPendingApprovals` to `visibleWhen` enum. |
| Database | New `approval_requests` table (see Section 9). |
| New services | `RbacService`, `ApprovalService`, `ToolCallInterceptor`, `ApprovalEventHandler`. |

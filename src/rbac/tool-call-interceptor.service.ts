import { Injectable, Logger } from '@nestjs/common'
import { AsyncLocalStorage } from 'async_hooks'
import { RbacService, AccessDecision, UserContext } from './rbac.service'
import { ApprovalService } from './approval.service'
import { McpService } from '../mcp/mcp.service'

export type ToolCallResult =
  | { type: 'result'; data: string }
  | { type: 'denied'; message: string }
  | { type: 'pending_approval'; requestId: string; message: string }

@Injectable()
export class ToolCallInterceptorService {
  private readonly logger = new Logger(ToolCallInterceptorService.name)
  private readonly contextStore = new AsyncLocalStorage<UserContext>()

  constructor(
    private readonly rbacService: RbacService,
    private readonly approvalService: ApprovalService,
    private readonly mcpService: McpService,
  ) {}

  /**
   * Run a callback with the given user context stored in AsyncLocalStorage.
   * Used by LlmService.generate() to set per-request RBAC context.
   */
  runWithContext<T>(userContext: UserContext, fn: () => T | Promise<T>): T | Promise<T> {
    return this.contextStore.run(userContext, fn)
  }

  /**
   * Get the current user context from AsyncLocalStorage.
   * Returns undefined if called outside runWithContext().
   */
  getCurrentContext(): UserContext | undefined {
    return this.contextStore.getStore()
  }

  /**
   * Execute a tool call with RBAC checks and approval workflow.
   * This wraps McpService.callTool() with access control.
   */
  async execute(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    userContext: UserContext,
    toolDescription?: string,
  ): Promise<ToolCallResult> {
    // If RBAC is not active, pass through to legacy behavior
    if (!this.rbacService.isRbacActive()) {
      const data = await this.mcpService.callTool(serverName, toolName, args, true)
      return { type: 'result', data }
    }

    const decision = this.rbacService.checkAccess(
      userContext.roles,
      userContext.identity,
      serverName,
      toolName,
    )

    this.logger.debug(
      `[INTERCEPT] ${userContext.identity} → ${serverName}/${toolName}: ${decision} (roles=${userContext.roles.join(',')})`,
    )

    switch (decision) {
      case 'ALLOW': {
        const data = await this.mcpService.callTool(serverName, toolName, args, true)
        return { type: 'result', data }
      }

      case 'DENY':
        return {
          type: 'denied',
          message: `Tool "${toolName}" is not available for your role.`,
        }

      case 'APPROVAL': {
        // Self-approval: user holds both tool access and approver role
        if (this.rbacService.isApprover(userContext.roles, serverName, toolName)) {
          this.logger.log(`[INTERCEPT] Self-approval for ${userContext.identity} on ${serverName}/${toolName}`)
          const data = await this.mcpService.callTool(serverName, toolName, args, true)
          return { type: 'result', data }
        }

        // Queue for approval
        const policy = this.rbacService.getApprovalPolicy(serverName, toolName)
        const timeoutMinutes = policy?.timeoutMinutes ?? 60
        const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000)

        const request = await this.approvalService.create({
          serverName,
          toolName,
          args,
          requesterIdentity: userContext.identity,
          requesterConnectionId: userContext.connectionId,
          approverRoles: policy?.approvers ?? [],
          expiresAt,
          toolDescription,
        })

        const approverRolesStr = policy?.approvers?.join(', ') ?? 'an approver'
        return {
          type: 'pending_approval',
          requestId: request.id,
          message: `This action requires approval from ${approverRolesStr}. Your request has been submitted and you'll be notified when it's processed.`,
        }
      }
    }
  }
}

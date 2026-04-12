import { Injectable, Logger } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import { OnEvent } from '@nestjs/event-emitter'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ApiClient, TextMessage } from '@2060.io/vs-agent-nestjs-client'
import { ApprovalRequestEntity, ApprovalStatus } from './approval-request.entity'
import { SessionEntity } from '../core/models'

@Injectable()
export class ApprovalEventHandler {
  private readonly logger = new Logger(ApprovalEventHandler.name)
  private mcpService: any

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    private readonly eventEmitter: EventEmitter2,
    private readonly moduleRef: ModuleRef,
    private readonly apiClient: ApiClient,
  ) {}

  /**
   * Lazily resolve McpService to avoid circular dependency.
   */
  private async getMcpService() {
    if (!this.mcpService) {
      const { McpService } = await import('../mcp/mcp.service')
      this.mcpService = this.moduleRef.get(McpService, { strict: false })
    }
    return this.mcpService
  }

  @OnEvent('approval.created')
  async onCreated(request: ApprovalRequestEntity): Promise<void> {
    this.logger.log(`[EVENT] approval.created: ${request.id} (${request.toolName})`)

    try {
      // Notify the requester
      await this.sendText(
        request.requesterConnectionId,
        `Your approval request for "${request.toolName}" has been submitted. You'll be notified when it's processed.`,
      )

      // Find all connected sessions with approver roles and notify them
      const approverSessions = await this.findSessionsByRoles(request.approverRoles)
      for (const session of approverSessions) {
        if (session.userIdentity === request.requesterIdentity) continue

        await this.sendText(
          session.connectionId,
          `New approval request from ${request.requesterIdentity}: ${request.toolName}`,
        )
      }

      // Refresh menus for all related parties
      await this.emitMenuRefresh(request)
    } catch (err) {
      this.logger.error(`[EVENT] Error handling approval.created: ${err}`)
    }
  }

  @OnEvent('approval.resolved')
  async onResolved(request: ApprovalRequestEntity): Promise<void> {
    this.logger.log(`[EVENT] approval.resolved: ${request.id} → ${request.status}`)

    try {
      if (request.status === ApprovalStatus.APPROVED) {
        const mcpService = await this.getMcpService()
        try {
          const result = await mcpService.callTool(request.serverName, request.toolName, request.args, true)
          await this.sendText(
            request.requesterConnectionId,
            `Your request for "${request.toolName}" was approved${request.resolvedBy ? ` by ${request.resolvedBy}` : ''}.\n\nResult:\n${result}`,
          )
        } catch (err) {
          await this.sendText(
            request.requesterConnectionId,
            `Your request for "${request.toolName}" was approved, but execution failed: ${err}`,
          )
        }
      } else if (request.status === ApprovalStatus.REJECTED) {
        await this.sendText(
          request.requesterConnectionId,
          `Your request for "${request.toolName}" was rejected${request.resolvedBy ? ` by ${request.resolvedBy}` : ''}.`,
        )
      } else if (request.status === ApprovalStatus.CANCELLED) {
        const approverSessions = await this.findSessionsByRoles(request.approverRoles)
        for (const session of approverSessions) {
          await this.sendText(
            session.connectionId,
            `Approval request for "${request.toolName}" from ${request.requesterIdentity} was cancelled.`,
          )
        }
      } else if (request.status === ApprovalStatus.EXPIRED) {
        await this.sendText(
          request.requesterConnectionId,
          `Your approval request for "${request.toolName}" has expired.`,
        )
      }

      // Refresh menus for all related parties
      await this.emitMenuRefresh(request)
    } catch (err) {
      this.logger.error(`[EVENT] Error handling approval.resolved: ${err}`)
    }
  }

  /**
   * Find all active sessions whose userRoles intersect with the given roles.
   */
  private async findSessionsByRoles(roles: string[]): Promise<SessionEntity[]> {
    if (roles.length === 0) return []

    const allSessions = await this.sessionRepo.find({
      where: { isAuthenticated: true },
    })

    return allSessions.filter((s) => {
      if (!s.userRoles) return false
      return s.userRoles.some((r) => roles.includes(r))
    })
  }

  /**
   * Emit menu refresh events for all parties related to an approval request.
   * CoreService will listen for 'menu.refresh' and rebuild the contextual menu.
   */
  private async emitMenuRefresh(request: ApprovalRequestEntity): Promise<void> {
    // Refresh requester's menu
    this.eventEmitter.emit('menu.refresh', { connectionId: request.requesterConnectionId })

    // Refresh all approvers' menus
    const approverSessions = await this.findSessionsByRoles(request.approverRoles)
    for (const session of approverSessions) {
      this.eventEmitter.emit('menu.refresh', { connectionId: session.connectionId })
    }
  }

  private async sendText(connectionId: string, text: string): Promise<void> {
    try {
      await this.apiClient.messages.send(
        new TextMessage({
          connectionId,
          content: text,
          timestamp: new Date(),
        }),
      )
    } catch (err) {
      this.logger.error(`[EVENT] Failed to send message to ${connectionId}: ${err}`)
    }
  }
}

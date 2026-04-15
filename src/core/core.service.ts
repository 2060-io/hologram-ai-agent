import {
  ApiClient,
  ApiVersion,
  EventHandler,
  StatProducerService,
  BaseMessage,
  ContextualMenuItem,
  ContextualMenuSelectMessage,
  ContextualMenuUpdateMessage,
  IdentityProofRequestMessage,
  IdentityProofSubmitMessage,
  MediaMessage,
  MenuDisplayMessage,
  MenuSelectMessage,
  ProfileMessage,
  StatEnum,
  TextMessage,
  InvitationMessage,
  VerifiableCredentialRequestedProofItem,
  VerifiableCredentialSubmittedProofItem,
} from '@2060.io/vs-agent-nestjs-client'
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { SessionEntity } from './models'
import { JsonTransformer } from '@credo-ts/core'
import { STAT_KPI } from './common'
import { Repository } from 'typeorm'
import { InjectRepository } from '@nestjs/typeorm'
import { ConfigService } from '@nestjs/config'
import { OnEvent } from '@nestjs/event-emitter'
import { StateStep } from './common/enums/state-step.enum'
import { ChatbotService } from '../chatbot/chatbot.service'
import { MemoryService } from '../memory/memory.service'
import { AgentContentService } from './agent-content.service'
import { McpConfigService } from '../mcp/mcp-config.service'
import { McpService } from '../mcp/mcp.service'
import { RbacService } from '../rbac/rbac.service'
import { ApprovalService } from '../rbac/approval.service'
import type { AuthFlowConfig } from '../config/agent-pack.loader'
import { SttService } from '../stt/stt.service'

@Injectable()
export class CoreService implements EventHandler, OnModuleInit {
  private readonly apiClient: ApiClient
  private readonly logger = new Logger(CoreService.name)

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepository: Repository<SessionEntity>,
    private readonly configService: ConfigService,
    private readonly chatBotService: ChatbotService,
    private readonly memoryService: MemoryService,
    @Optional() private readonly statProducer: StatProducerService,
    private readonly agentContent: AgentContentService,
    private readonly mcpConfigService: McpConfigService,
    private readonly mcpService: McpService,
    @Optional() private readonly rbacService: RbacService,
    @Optional() private readonly approvalService: ApprovalService,
    private readonly sttService: SttService,
  ) {
    const baseUrl = configService.get<string>('appConfig.vsAgentAdminUrl') || 'http://localhost:3001'
    this.apiClient = new ApiClient(baseUrl, ApiVersion.V1)
    this.menuItems = this.agentContent.getMenuItems()
    this.menuActions = this.menuItems.reduce<Record<string, string | undefined>>((acc, item) => {
      if (item.action) acc[item.id] = item.action
      return acc
    }, {})
    this.welcomeFlowConfig = this.agentContent.getWelcomeFlowConfig()
    this.authFlowConfig = this.agentContent.getAuthFlowConfig()
    this.credentialDefinitionId = this.authFlowConfig.credentialDefinitionId
    this.logger.log(
      `[INIT] authFlowConfig: enabled=${this.authFlowConfig.enabled}, credDefId=${this.credentialDefinitionId?.substring(0, 40)}..., adminAvatars=${JSON.stringify(this.authFlowConfig.adminAvatars)}`,
    )
    this.logger.log(`[INIT] menuItems: ${JSON.stringify(this.menuItems.map((i) => i.id))}`)
  }

  private readonly menuItems: {
    id: string
    labelKey?: string
    label?: string
    action?: string
    visibleWhen?: string
    badge?: string
  }[]
  private readonly menuActions: Record<string, string | undefined>
  private readonly welcomeFlowConfig: { enabled: boolean; sendOnProfile: boolean; templateKey: string }
  private readonly authFlowConfig: AuthFlowConfig
  private readonly credentialDefinitionId?: string

  private isAdmin(session: SessionEntity): boolean {
    // New RBAC: check adminUsers by identity
    if (session.userIdentity && this.rbacService?.isAdminUser(session.userIdentity)) {
      return true
    }
    // Legacy: check adminAvatars by userName
    if (!session.userName) return false
    const normalize = (s: string) => s.replace(/^@/, '').toLowerCase()
    const name = normalize(session.userName)
    return this.authFlowConfig.adminAvatars.some((a) => normalize(a) === name)
  }

  async onModuleInit() {}

  /**
   * Handles incoming messages and manages the input flow.
   * Routes the message to the appropriate handler based on its type.
   *
   * @param message - The incoming message to process.
   */
  async inputMessage(message: BaseMessage): Promise<void> {
    let content
    const session: SessionEntity = await this.handleSession(message.connectionId)

    try {
      this.logger.debug('inputMessage: ' + JSON.stringify(message))

      switch (message.type) {
        case TextMessage.type:
          content = JsonTransformer.fromJSON(message, TextMessage)
          //entry message user to chatbot agent service ,send session connection
          break
        case ContextualMenuSelectMessage.type: {
          const inMsg = JsonTransformer.fromJSON(
            message,
            ContextualMenuSelectMessage,
          ) as unknown as ContextualMenuSelectMessage
          const selectionId = inMsg.selectionId as string | undefined
          const action = selectionId ? this.menuActions[selectionId] : undefined
          if (selectionId && action) {
            this.logger.debug(`ContextualMenuSelectMessage with selectionId: ${selectionId} and action: ${action}`)
            await this.handleContextualAction(action, session)
          } else {
            this.logger.warn(`Invalid or missing selectionId: ${selectionId}`)
          }
          break
        }
        case MenuSelectMessage.type: {
          const rawItems = (message as any).menuItems as Array<{ id: string }> | undefined
          if (session.state === StateStep.MCP_CONFIG && !session.mcpConfigServer && rawItems?.length) {
            const selectedId = rawItems[0]?.id
            if (selectedId) {
              await this.startMcpConfigForServer(selectedId, session)
            }
          }
          break
        }
        case MediaMessage.type: {
          const mediaMsg = JsonTransformer.fromJSON(message, MediaMessage)
          const audioItem = mediaMsg.items?.find((item) => this.sttService.isAudioMimeType(item.mimeType))
          if (audioItem && this.sttService.isEnabled) {
            if (!this.sttService.isAllowed(session.isAuthenticated ?? false)) {
              this.logger.log(`[STT] Blocked voice note from unauthenticated user ${session.connectionId}`)
              await this.sendText(session.connectionId, this.getText('VOICE_AUTH_REQUIRED', session.lang), session.lang)
            } else {
              try {
                const result = await this.sttService.transcribeFromUrl(
                  audioItem.uri,
                  audioItem.mimeType,
                  audioItem.ciphering,
                )
                if (result.text.trim().length > 0) {
                  content = { content: result.text.trim() }
                }
              } catch (err) {
                this.logger.error(`[STT] Transcription failed: ${err}`)
                await this.sendText(session.connectionId, this.getText('ERROR_MESSAGES', session.lang), session.lang)
              }
            }
          } else {
            content = 'media'
          }
          break
        }
        case ProfileMessage.type: {
          const inMsg = JsonTransformer.fromJSON(message, ProfileMessage) as unknown as ProfileMessage
          if (inMsg.preferredLanguage) {
            session.lang = inMsg.preferredLanguage
          }
          if (this.welcomeFlowConfig.enabled && this.welcomeFlowConfig.sendOnProfile) {
            await this.sendGreetingMessage(session.connectionId)
          }
          break
        }
        case IdentityProofSubmitMessage.type:
          content = JsonTransformer.fromJSON(message, IdentityProofSubmitMessage)
          break
        default:
          break
      }

      if (content != null) {
        if (typeof content === 'string') content = content.trim()
        if (typeof content === 'string' && content.length === 0) {
          content = null
        }
      }
    } catch (error) {
      this.logger.error(`inputMessage: ${error}`)
    }
    await this.handleStateInput(content, session)
  }

  /**
   * Handles the `ConnectionStateUpdated` event for establishing a new connection.
   *
   * @param event - The event containing connection update details.
   */
  async newConnection(connectionId: string): Promise<void> {
    const session = await this.handleSession(connectionId)
    await this.sendStats(STAT_KPI.USER_CONNECTED, session)
    await this.sendContextualMenu(session)
  }

  /**
   * Handles the `ConnectionStateUpdated` event to close an active connection.
   *
   * This method is part of the event handler implementation for managing
   * connection lifecycle events. It ensures that the session associated with
   * the given connection is updated and purged of sensitive or user-specific data
   * before finalizing the connection closure.
   *
   * Steps:
   * 1. Retrieves the session associated with the `connectionId` from the event.
   * 2. Purges user-specific data from the session using `purgeUserData`,
   *    resetting the session state and clearing sensitive fields.
   *
   * @param event - The `ConnectionStateUpdated` event containing details of
   *                the connection to be closed (e.g., `connectionId`).
   *
   * @returns {Promise<void>} - Resolves when the connection is successfully closed
   *                            and the session is updated.
   *
   * @note This method ensures that the session's `connectionId` and other essential
   *       metadata remain intact while cleaning up unnecessary or sensitive data.
   */
  async closeConnection(connectionId: string): Promise<void> {
    const session = await this.handleSession(connectionId)
    await this.purgeUserData(session)
  }

  private async sendGreetingMessage(connectionId: string) {
    const userLang = (await this.handleSession(connectionId)).lang

    const greetingMessage = this.agentContent.getGreetingMessage(userLang, this.welcomeFlowConfig.templateKey)
    this.logger.debug(`LLM generated answer: "${greetingMessage}"`)
    await this.sendText(connectionId, greetingMessage, userLang)
  }

  /**
   * Sends a text message to a specific connection.
   *
   * @param connectionId - Identifier of the target connection.
   * @param text - The content of the message.
   * @param lang - The language of the message.
   */
  private async sendText(connectionId: string, text: string, lang: string) {
    await this.apiClient.messages.send(
      new TextMessage({
        connectionId: connectionId,
        content: this.getText(text, lang),
      }),
    )
  }

  /**
   * Retrieves localized text for the given key and language.
   *
   * @param text - The key for the desired text.
   * @param lang - The language of the text.
   */
  private getText(key: string, lang: string): string {
    return this.agentContent.getString(lang ?? this.agentContent.getDefaultLanguage(), key)
  }

  /**
   * Processes actions related to `ContextualMenuSelectMessage` messages.
   * Updates the session based on the selected option.
   *
   * @param action - The resolved action name (e.g. 'authenticate', 'logout', 'mcp-config').
   * @param session - The current session associated with the message.
   */
  private async handleContextualAction(action: string, session: SessionEntity): Promise<SessionEntity> {
    const { connectionId, lang } = session
    switch (session.state) {
      case StateStep.CHAT: {
        this.logger.debug(`this.authFlowConfig.enabled: ${this.authFlowConfig.enabled}`)
        if (action === 'authenticate' && this.authFlowConfig.enabled) {
          const credentialDefinitionId = this.credentialDefinitionId
          this.logger.debug(`credentialDefinition: ${credentialDefinitionId}`)
          if (!credentialDefinitionId) {
            throw new Error('Missing config: credentialDefinitionId')
          }

          const body = new IdentityProofRequestMessage({
            connectionId,
            requestedProofItems: [],
          })
          const requestedProofItem = new VerifiableCredentialRequestedProofItem({
            id: '1',
            type: 'verifiable-credential',
            credentialDefinitionId,
          })
          body.requestedProofItems.push(requestedProofItem)

          await this.apiClient.messages.send(body)

          session.state = StateStep.AUTH
          this.logger.debug(`[AUTH] Proof request sent to ${connectionId}`)
          await this.sendText(connectionId, this.getText('AUTH_PROCESS_STARTED', lang), lang)
        }

        if (action === 'logout') {
          await this.sendText(connectionId, this.getText('LOGOUT_CONFIRMATION', lang), lang)
          session.isAuthenticated = false
          session.userName = ''
          await this.sessionRepository.save(session)
          await this.closeConnection(connectionId)
          await this.memoryService.clear(connectionId)
        }

        if (action === 'mcp-config') {
          await this.beginMcpConfigFlow(session)
        }

        if (action === 'my-approval-requests') {
          await this.handleMyApprovalRequests(session)
        }

        if (action === 'pending-approvals') {
          await this.handlePendingApprovals(session)
        }
        break
      }
      case StateStep.MCP_CONFIG: {
        if (action === 'abort-config') {
          await this.abortMcpConfigFlow(session)
        }
        break
      }
      default:
        break
    }
    return await this.sessionRepository.save(session)
  }

  /**
   * Handles message input using a state machine.
   * Determines the next session state based on the message content.
   *
   * @param content - The content of the message.
   * @param session - The active session to update.
   */
  private async handleStateInput(content: unknown, session: SessionEntity): Promise<SessionEntity> {
    const { connectionId, lang: userLang } = session
    this.logger.debug(`New Message ${JSON.stringify(content)}`)
    try {
      switch (session.state) {
        case StateStep.CHAT:
          if (
            typeof content === 'object' &&
            content !== null &&
            'content' in content &&
            typeof (content as Record<string, unknown>).content === 'string'
          ) {
            const textContent = (content as { content: string }).content.trim()

            // Guest access check: when auth is required, block unauthenticated messages
            if (textContent.length > 0 && !session.isAuthenticated && this.authFlowConfig.required) {
              this.logger.log(`[GUEST] Blocked message from unauthenticated user ${connectionId}`)
              await this.sendText(connectionId, this.getText('AUTH_REQUIRED', userLang), userLang)
              break
            }

            if (textContent.length > 0) {
              const answer = await this.chatBotService.chat({
                userInput: textContent,
                session,
                isAdmin: this.isAdmin(session),
              })
              await this.sendText(connectionId, answer, userLang)
            }
          }

          break
        case StateStep.AUTH:
          if (
            typeof content === 'object' &&
            content !== null &&
            'type' in content &&
            (content as IdentityProofSubmitMessage).type === IdentityProofSubmitMessage.type &&
            'submittedProofItems' in content
          ) {
            const submitMessage = content as IdentityProofSubmitMessage
            const proofItem = submitMessage.submittedProofItems?.[0] as
              | VerifiableCredentialSubmittedProofItem
              | undefined

            if (proofItem?.type === VerifiableCredentialSubmittedProofItem.type && !proofItem.errorCode) {
              session.isAuthenticated = true

              const claims = proofItem.claims as { name: string; value: string }[] | undefined
              if (claims) {
                const firstName = claims.find((c) => c.name === 'firstName')?.value
                const lastName = claims.find((c) => c.name === 'lastName')?.value
                const fullName = [firstName, lastName].filter(Boolean).join(' ').trim()
                session.userName = fullName || claims.find((c) => c.name === 'name')?.value || ''

                // RBAC: extract identity and roles from credential attributes
                if (this.rbacService) {
                  const claimsMap: Record<string, string> = {}
                  for (const c of claims) {
                    claimsMap[c.name] = c.value
                  }
                  session.userIdentity = this.rbacService.resolveIdentity(claimsMap)
                  session.userRoles = this.rbacService.resolveRoles(claimsMap)
                  this.logger.log(
                    `[AUTH] RBAC: identity="${session.userIdentity}", roles=${JSON.stringify(session.userRoles)}`,
                  )
                }
              }

              session.state = StateStep.CHAT
              await this.sessionRepository.save(session)

              const isAdmin = this.isAdmin(session)
              this.logger.log(`[AUTH] User ${connectionId} authenticated as "${session.userName}" (admin=${isAdmin})`)
              const message = session.userName
                ? this.getText('AUTH_SUCCESS_NAME', userLang).replace('{name}', session.userName)
                : this.getText('AUTH_SUCCESS', userLang)

              await this.sendText(connectionId, message, userLang)
            } else if (proofItem?.errorCode) {
              this.logger.warn(`[AUTH] Proof submission failed with error: ${proofItem.errorCode}`)

              if (
                proofItem.errorCode === 'e.req.no-compatible-credentials' &&
                this.authFlowConfig.issuerServiceDid
              ) {
                await this.sendText(connectionId, this.getText('AUTH_NO_CREDENTIAL', userLang), userLang)
                await this.apiClient.messages.send(
                  new InvitationMessage({
                    connectionId,
                    did: this.authFlowConfig.issuerServiceDid,
                  }),
                )
                this.logger.log(
                  `[AUTH] Sent invitation to issuer service ${this.authFlowConfig.issuerServiceDid} for ${connectionId}`,
                )
              } else {
                await this.sendText(
                  connectionId,
                  `${this.getText('AUTH_ERROR', userLang)}: ${proofItem.errorCode}`,
                  userLang,
                )
              }

              session.state = StateStep.CHAT
              await this.sessionRepository.save(session)
            } else {
              await this.sendText(connectionId, this.getText('WAITING_CREDENTIAL', userLang), userLang)
            }
          } else {
            await this.sendText(connectionId, this.getText('WAITING_CREDENTIAL', userLang), userLang)
          }
          break
        case StateStep.MCP_CONFIG:
          if (
            typeof content === 'object' &&
            content !== null &&
            'content' in content &&
            typeof (content as Record<string, unknown>).content === 'string'
          ) {
            const textContent = (content as { content: string }).content.trim()
            if (textContent.length > 0) {
              await this.handleMcpConfigInput(textContent, session)
            }
          }
          break
        default:
          break
      }
    } catch (error) {
      this.logger.error('handleStateInput: ' + error)
      await this.sendText(connectionId, this.getText('ERROR_MESSAGES', userLang), userLang)
    }
    return await this.sendContextualMenu(session)
  }

  /**
   * Retrieves or initializes the session associated with a specific connection.
   * Ensures consistent and secure operations.
   *
   * @param connectionId - Identifier of the active connection.
   */
  private async handleSession(connectionId: string): Promise<SessionEntity> {
    let session = await this.sessionRepository.findOneBy({
      connectionId: connectionId,
    })
    this.logger.debug('handleSession session: ' + JSON.stringify(session))

    if (!session) {
      session = this.sessionRepository.create({
        connectionId: connectionId,
        state: StateStep.CHAT,
        isAuthenticated: false,
      })

      await this.sessionRepository.save(session)
      this.logger.debug('New session: ' + JSON.stringify(session))
    }
    return await this.sessionRepository.save(session)
  }

  // Special flows
  /**
   * Purges user-specific data from the provided session.
   *
   * This method resets the session's `state` to `StateStep.START` and ensures that
   * any additional parameters in the session (user-specific or sensitive data)
   * are set to `null`. It updates the session in the database, keeping the
   * `connectionId`, `id`, `lang`, and timestamps intact.
   *
   * @param session - The session entity to be purged.
   *                  It must be a valid session retrieved from the database.
   *
   * @returns {Promise<SessionEntity>} - The updated session entity after the purge.
   *
   * @note This method should be used to reset a session to its initial state
   *       while preserving its connection details and essential metadata.
   */
  private async purgeUserData(session: SessionEntity): Promise<SessionEntity> {
    session.state = StateStep.START
    session.mcpConfigServer = undefined
    session.mcpConfigFieldIndex = undefined
    session.userIdentity = undefined
    session.userRoles = undefined
    return await this.sessionRepository.save(session)
  }

  private async sendContextualMenu(session: SessionEntity): Promise<SessionEntity> {
    const isConfiguring = session.state === StateStep.MCP_CONFIG

    // Resolve dynamic badge counts for approval menu items
    const badgeCounts = await this.resolveBadgeCounts(session)

    const options: ContextualMenuItem[] = this.menuItems
      .filter(
        (item) =>
          this.isMenuItemVisible(item.visibleWhen, session, isConfiguring, badgeCounts) &&
          this.isMenuActionEnabled(item.action),
      )
      .map((item) => {
        let title = item.label ?? this.getText(item.labelKey ?? item.id, session.lang)
        // Prepend badge count if configured
        if (item.badge && badgeCounts[item.badge] > 0) {
          title = `(${badgeCounts[item.badge]}) ${title}`
        }
        return new ContextualMenuItem({ id: item.id, title })
      })

    this.logger.log(
      `[MENU] options=${options.length}, isAuth=${session.isAuthenticated}, items=${this.menuItems.length}`,
    )
    if (options.length === 0) {
      this.logger.log('[MENU] Skipping contextual menu: no visible options.')
      return await this.sessionRepository.save(session)
    }

    const title = this.getText('ROOT_TITLE', session.lang)
    const description = session.isAuthenticated
      ? session.userName
        ? `Authenticated as ${session.userName}${this.isAdmin(session) ? ' (Admin)' : ''}`
        : 'Authenticated'
      : 'Not Authenticated'

    this.logger.log(
      `[MENU] Sending ContextualMenuUpdate: title="${title}", desc="${description}", options=${JSON.stringify(options.map((o) => o.id))}`,
    )
    await this.apiClient.messages.send(
      new ContextualMenuUpdateMessage({
        title,
        description,
        connectionId: session.connectionId,
        options,
        timestamp: new Date(),
      }),
    )
    this.logger.log(`[MENU] ContextualMenuUpdate sent successfully.`)
    return await this.sessionRepository.save(session)
  }

  /**
   * Resolve dynamic badge counts for approval-related menu items.
   */
  private async resolveBadgeCounts(session: SessionEntity): Promise<Record<string, number>> {
    const counts: Record<string, number> = {
      approvalRequestCount: 0,
      pendingApprovalCount: 0,
    }

    if (!this.approvalService || !session.isAuthenticated) return counts

    if (session.userIdentity) {
      counts.approvalRequestCount = await this.approvalService.countByRequester(session.userIdentity)
    }

    if (session.userRoles?.length) {
      counts.pendingApprovalCount = await this.approvalService.countPendingForApprover(session.userRoles)
    }

    return counts
  }

  async sendStats(kpi: STAT_KPI, session: SessionEntity) {
    this.logger.debug(`***send stats***`)
    const stats = [STAT_KPI[kpi]]
    if (session !== null && this.statProducer)
      await this.statProducer.spool(stats, session.connectionId, [new StatEnum(0, 'string')])
  }

  private isMenuItemVisible(
    visibleWhen: string | undefined,
    session: SessionEntity,
    isConfiguring = false,
    badgeCounts: Record<string, number> = {},
  ) {
    const isAuthenticated = session.isAuthenticated ?? false
    switch (visibleWhen) {
      case 'authenticated':
        return !!isAuthenticated
      case 'unauthenticated':
        return !isAuthenticated
      case 'configuring':
        return isConfiguring
      case 'notConfiguring':
        return !!isAuthenticated && !isConfiguring
      case 'hasApprovalRequests':
        return !!isAuthenticated && (badgeCounts.approvalRequestCount ?? 0) > 0
      case 'hasPendingApprovals':
        return !!isAuthenticated && (badgeCounts.pendingApprovalCount ?? 0) > 0
      default:
        return true
    }
  }

  private isMenuActionEnabled(action?: string) {
    if (!action) return true
    if (action === 'authenticate')
      return this.authFlowConfig.enabled && !!this.authFlowConfig.credentialDefinitionId?.trim()
    if (action === 'mcp-config')
      return this.mcpConfigService.isAvailable && this.agentContent.getUserControlledServers().length > 0
    return true
  }

  // ── Approval Menu Handlers ─────────────────────────────────────

  /**
   * Show the user's own pending approval requests. They can cancel them.
   */
  private async handleMyApprovalRequests(session: SessionEntity): Promise<void> {
    if (!this.approvalService || !session.userIdentity) return
    const requests = await this.approvalService.getByRequester(session.userIdentity)
    if (requests.length === 0) {
      await this.sendText(session.connectionId, this.getText('NO_APPROVAL_REQUESTS', session.lang), session.lang)
      return
    }

    const menuItems = requests.map((r) => ({
      id: `cancel-approval:${r.id}`,
      text: `${r.toolName} (${r.serverName}) - ${r.createdAt.toISOString().split('T')[0]}`,
      action: `cancel-approval:${r.id}`,
    }))

    await this.apiClient.messages.send(
      new MenuDisplayMessage({
        connectionId: session.connectionId,
        prompt: this.getText('MY_APPROVAL_REQUESTS_PROMPT', session.lang),
        menuItems,
      }),
    )
  }

  /**
   * Show pending approval requests the user can approve/reject.
   */
  private async handlePendingApprovals(session: SessionEntity): Promise<void> {
    if (!this.approvalService || !session.userRoles?.length) return
    const requests = await this.approvalService.getPendingForApprover(session.userRoles)
    if (requests.length === 0) {
      await this.sendText(session.connectionId, this.getText('NO_PENDING_APPROVALS', session.lang), session.lang)
      return
    }

    const menuItems = requests.map((r) => ({
      id: `review-approval:${r.id}`,
      text: `${r.requesterIdentity}: ${r.toolName} (${r.serverName})`,
      action: `review-approval:${r.id}`,
    }))

    await this.apiClient.messages.send(
      new MenuDisplayMessage({
        connectionId: session.connectionId,
        prompt: this.getText('PENDING_APPROVALS_PROMPT', session.lang),
        menuItems,
      }),
    )
  }

  /**
   * Handle menu.refresh events emitted by ApprovalEventHandler.
   */
  @OnEvent('menu.refresh')
  async onMenuRefresh(payload: { connectionId: string }): Promise<void> {
    this.logger.debug(`[EVENT] menu.refresh for ${payload.connectionId}`)
    try {
      const session = await this.sessionRepository.findOne({
        where: { connectionId: payload.connectionId },
      })
      if (session) {
        await this.sendContextualMenu(session)
      }
    } catch (err) {
      this.logger.error(`[EVENT] Error refreshing menu for ${payload.connectionId}: ${err}`)
    }
  }

  // ── MCP Config Flow ──────────────────────────────────────────────

  /** Transient in-memory store for config fields being collected (connectionId → field values) */
  private readonly mcpConfigCollected = new Map<string, Record<string, string>>()

  /**
   * Step 1: User clicked "MCP Server Config" → show server selection menu.
   */
  private async beginMcpConfigFlow(session: SessionEntity): Promise<void> {
    const servers = this.agentContent.getUserControlledServers()
    if (servers.length === 0) {
      await this.sendText(session.connectionId, 'No configurable MCP servers available.', session.lang)
      return
    }

    session.state = StateStep.MCP_CONFIG
    session.mcpConfigServer = undefined
    session.mcpConfigFieldIndex = undefined
    await this.sessionRepository.save(session)

    const menuItems = await Promise.all(
      servers.map(async (s) => {
        const configured = session.userName ? await this.mcpConfigService.hasConfig(session.userName, s.name) : false
        const status = configured ? '✅' : '⚠️'
        return { id: s.name, text: `${status} ${s.name}`, action: s.name }
      }),
    )

    await this.apiClient.messages.send(
      new MenuDisplayMessage({
        connectionId: session.connectionId,
        prompt: this.getText('MCP_CONFIG_SELECT_SERVER', session.lang),
        menuItems,
      }),
    )

    this.logger.log(`[MCP_CONFIG] Server selection menu sent to ${session.connectionId}`)
  }

  /**
   * Step 2: User selected a server from the menu → start asking config fields.
   */
  private async startMcpConfigForServer(serverName: string, session: SessionEntity): Promise<void> {
    const serverDef = this.agentContent.getUserControlledServer(serverName)
    if (!serverDef?.userConfig?.fields?.length) {
      await this.sendText(session.connectionId, `Server "${serverName}" has no configurable fields.`, session.lang)
      await this.abortMcpConfigFlow(session)
      return
    }

    session.mcpConfigServer = serverName
    session.mcpConfigFieldIndex = 0
    await this.sessionRepository.save(session)
    this.mcpConfigCollected.set(session.connectionId, {})

    this.logger.log(
      `[MCP_CONFIG] Starting config for server "${serverName}" (${serverDef.userConfig.fields.length} field(s))`,
    )
    await this.askCurrentConfigField(session, serverDef)
  }

  /**
   * Step 3: User sent a text message while in MCP_CONFIG state → store field value and advance.
   */
  private async handleMcpConfigInput(text: string, session: SessionEntity): Promise<void> {
    const { connectionId, lang, mcpConfigServer, mcpConfigFieldIndex } = session
    if (!mcpConfigServer || mcpConfigFieldIndex == null) {
      await this.abortMcpConfigFlow(session)
      return
    }

    const serverDef = this.agentContent.getUserControlledServer(mcpConfigServer)
    if (!serverDef?.userConfig?.fields?.length) {
      await this.abortMcpConfigFlow(session)
      return
    }

    const fields = serverDef.userConfig.fields
    const currentField = fields[mcpConfigFieldIndex]
    if (!currentField) {
      await this.abortMcpConfigFlow(session)
      return
    }

    // Store the value in transient map
    const collected = this.mcpConfigCollected.get(connectionId) ?? {}
    collected[currentField.name] = text
    this.mcpConfigCollected.set(connectionId, collected)

    const nextIndex = mcpConfigFieldIndex + 1
    if (nextIndex < fields.length) {
      // More fields to collect
      session.mcpConfigFieldIndex = nextIndex
      await this.sessionRepository.save(session)
      await this.askCurrentConfigField(session, serverDef)
    } else {
      // All fields collected → encrypt and save, then validate
      try {
        await this.mcpConfigService.saveConfig(session.userName!, mcpConfigServer, collected)
        this.logger.log(`[MCP_CONFIG] Config saved for avatar="${session.userName}" server="${mcpConfigServer}"`)

        // Validate: attempt a real connection with the provided credentials
        const valid = await this.mcpService.testUserConnection(session.userName!, mcpConfigServer)
        if (valid) {
          const msg = this.getText('MCP_CONFIG_SAVED', lang).replace('{server}', mcpConfigServer)
          await this.sendText(connectionId, msg, lang)
        } else {
          // Credentials are invalid → remove saved config so user can retry
          await this.mcpConfigService.deleteConfig(session.userName!, mcpConfigServer)
          const msg = this.getText('MCP_CONFIG_INVALID', lang).replace('{server}', mcpConfigServer)
          await this.sendText(connectionId, msg, lang)
        }
      } catch (err) {
        this.logger.error(`[MCP_CONFIG] Failed to save/validate config: ${err}`)
        await this.sendText(connectionId, this.getText('MCP_CONFIG_ERROR', lang), lang)
      }

      // Clean up and return to CHAT state
      this.mcpConfigCollected.delete(connectionId)
      session.state = StateStep.CHAT
      session.mcpConfigServer = undefined
      session.mcpConfigFieldIndex = undefined
      await this.sessionRepository.save(session)
    }
  }

  /**
   * Abort: User clicked "Abort Configuration" or something went wrong → reset to CHAT.
   */
  private async abortMcpConfigFlow(session: SessionEntity): Promise<void> {
    this.mcpConfigCollected.delete(session.connectionId)
    session.state = StateStep.CHAT
    session.mcpConfigServer = undefined
    session.mcpConfigFieldIndex = undefined
    await this.sessionRepository.save(session)

    await this.sendText(session.connectionId, this.getText('MCP_CONFIG_ABORTED', session.lang), session.lang)
    this.logger.log(`[MCP_CONFIG] Config flow aborted for ${session.connectionId}`)
  }

  /**
   * Sends the prompt for the current config field to the user.
   */
  private async askCurrentConfigField(
    session: SessionEntity,
    serverDef: { userConfig?: { fields: { name: string; label: Record<string, string>; type: string }[] } },
  ): Promise<void> {
    const field = serverDef.userConfig?.fields[session.mcpConfigFieldIndex ?? 0]
    if (!field) return

    const langKey = session.lang?.split('-')[0] ?? 'en'
    const label = field.label[langKey] ?? field.label['en'] ?? field.name
    await this.sendText(session.connectionId, label, session.lang)
  }
}

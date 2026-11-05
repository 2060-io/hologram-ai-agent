import {
  ActionMenuOption,
  ApiClient,
  Claim,
  EventEnvelope,
  EventHandler,
  isEventEnvelope,
  PresentationStateUpdatedData,
  RequestedCredentialInput,
  ShareMediaReceivedData,
  StatProducerService,
  UnknownEventEnvelope,
} from '@verana-labs/vs-agent-nestjs-client'
import { StatEnum } from '@verana-labs/vs-agent-model'
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { SessionEntity } from './models'
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
import type { ApprovalRequestEntity } from '../rbac/approval-request.entity'
import type { AuthFlowConfig } from '../config/agent-pack.loader'
import { SttService } from '../stt/stt.service'
import { VisionService } from '../vision/vision.service'
import { ImageRefStore } from '../media/image-ref.store'

/** A user utterance routed into the state machine (text, voice note transcript, image description). */
interface TextInput {
  content: string
  /** Message replied to. VS Agent v2 basic-message events carry no reply reference, so it is unset for now. */
  threadId?: string
}

/** The outcome of an authentication presentation request, routed into the AUTH state. */
interface PresentationResult {
  kind: 'presentation'
  state: PresentationStateUpdatedData['state']
  verified: boolean
  claims: Claim[]
  errorMessage?: string
}

/** Presentation states that end an exchange: only these reach the state machine. */
const TERMINAL_PRESENTATION_STATES: PresentationStateUpdatedData['state'][] = ['done', 'abandoned', 'declined']

const isPresentationResult = (content: unknown): content is PresentationResult =>
  typeof content === 'object' && content !== null && (content as PresentationResult).kind === 'presentation'

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
    private readonly visionService: VisionService,
    private readonly imageRefStore: ImageRefStore,
  ) {
    const baseUrl = configService.get<string>('appConfig.vsAgentAdminUrl') || 'http://localhost:3001'
    this.apiClient = new ApiClient(baseUrl)
    this.menuItems = this.agentContent.getMenuItems()
    this.menuActions = this.menuItems.reduce<Record<string, string | undefined>>((acc, item) => {
      if (item.action) acc[item.id] = item.action
      return acc
    }, {})
    this.welcomeFlowConfig = this.agentContent.getWelcomeFlowConfig()
    this.authFlowConfig = this.agentContent.getAuthFlowConfig()
    this.logger.log(
      `[INIT] authFlowConfig: enabled=${this.authFlowConfig.enabled}, jsonSchemaCredentialId=${this.authFlowConfig.jsonSchemaCredentialId ?? '-'}, credDefId=${this.authFlowConfig.credentialDefinitionId?.substring(0, 40) ?? '-'}, adminAvatars=${JSON.stringify(this.authFlowConfig.adminAvatars)}`,
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

  /**
   * Question threads sent with sendQuestion (threadId → response text → selection id).
   * The question-answer protocol answers with the text of the selected response,
   * so the selection id of the menu entry is recovered here. Bounded: the oldest
   * thread is dropped first.
   */
  private readonly questionSelections = new Map<string, Map<string, string>>()
  private static readonly MAX_QUESTION_THREADS = 1000

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
   * Handles the events that the VS Agent delivers to the events webhook and
   * manages the input flow. Routes each event to the appropriate handler based
   * on its type; events this agent does not act on are ignored.
   *
   * @param envelope - The event envelope received from the VS Agent.
   */
  async onEvent(envelope: EventEnvelope | UnknownEventEnvelope): Promise<void> {
    if (!isEventEnvelope(envelope)) return
    const event = envelope

    switch (event.type) {
      case 'didcomm.basic-messages.message-received':
      case 'didcomm.action-menu.menu-request-received':
      case 'didcomm.action-menu.perform-received':
      case 'didcomm.question-answer.answer-received':
      case 'didcomm.media-sharing.share-media-received':
      case 'didcomm.user-profile.profile-received':
        break
      case 'didcomm.presentations.state-updated':
        // Only the outcome of a presentation request sent by this agent on a
        // connection reaches the state machine; intermediate states are ignored.
        if (event.data.role !== 'verifier' || !event.data.connectionId) return
        if (!TERMINAL_PRESENTATION_STATES.includes(event.data.state)) return
        break
      default:
        return
    }

    const connectionId = event.data.connectionId as string
    let content: TextInput | PresentationResult | null = null
    const session: SessionEntity = await this.handleSession(connectionId)

    try {
      this.logger.debug('onEvent: ' + JSON.stringify(event))

      switch (event.type) {
        case 'didcomm.basic-messages.message-received':
          content = { content: event.data.content }
          break
        case 'didcomm.action-menu.perform-received': {
          const selectionId = event.data.name
          const action = selectionId ? this.menuActions[selectionId] : undefined
          if (selectionId && action) {
            this.logger.debug(`Contextual menu selection with selectionId: ${selectionId} and action: ${action}`)
            await this.handleContextualAction(action, session)
          } else {
            this.logger.warn(`Invalid or missing selectionId: ${selectionId}`)
          }
          break
        }
        case 'didcomm.question-answer.answer-received': {
          const selectedId = this.resolveQuestionSelection(event.data.threadId, event.data.response)
          if (selectedId && this.isApprovalSelection(selectedId)) {
            await this.handleApprovalSelection(selectedId, session)
          } else if (session.state === StateStep.MCP_CONFIG && !session.mcpConfigServer && selectedId) {
            await this.startMcpConfigForServer(selectedId, session)
          }
          break
        }
        case 'didcomm.media-sharing.share-media-received':
          content = await this.handleMediaInput(event.data, session)
          break
        case 'didcomm.user-profile.profile-received': {
          if (event.data.profile.preferredLanguage) {
            session.lang = event.data.profile.preferredLanguage
          }
          if (this.welcomeFlowConfig.enabled && this.welcomeFlowConfig.sendOnProfile) {
            await this.sendGreetingMessage(session.connectionId)
          }
          break
        }
        case 'didcomm.presentations.state-updated':
          content = {
            kind: 'presentation',
            state: event.data.state,
            verified: event.data.verified,
            claims: event.data.claims ?? [],
            errorMessage: event.data.errorMessage,
          }
          break
        default:
          // didcomm.action-menu.menu-request-received: no content, the menu is resent below
          break
      }
    } catch (error) {
      this.logger.error(`onEvent: ${error}`)
    }
    await this.handleStateInput(content, session)
  }

  /**
   * Turns received media into the text the LLM gets: a voice note transcript,
   * an image description (with its uploadable refId), or a descriptive stub.
   */
  private async handleMediaInput(data: ShareMediaReceivedData, session: SessionEntity): Promise<TextInput | null> {
    const items = (data.items ?? []).filter((item) => !!item.uri)
    const audioItem = items.find((item) => this.sttService.isAudioMimeType(item.mimeType))
    if (audioItem && this.sttService.isEnabled) {
      if (!this.sttService.isAllowed(session.isAuthenticated ?? false)) {
        this.logger.log(`[STT] Blocked voice note from unauthenticated user ${session.connectionId}`)
        await this.sendText(session.connectionId, this.getText('VOICE_AUTH_REQUIRED', session.lang), session.lang)
        return null
      }
      try {
        const result = await this.sttService.transcribeFromUrl(audioItem.uri, audioItem.mimeType, audioItem.ciphering)
        if (result.text.trim().length > 0) {
          return { content: `[Voice note] ${result.text.trim()}` }
        }
      } catch (err) {
        this.logger.error(`[STT] Transcription failed: ${err}`)
        await this.sendText(session.connectionId, this.getText('ERROR_MESSAGES', session.lang), session.lang)
      }
      return null
    }

    // Non-audio media: try vision (image-to-text) first, then fall
    // back to a descriptive stub so the LLM always has context.
    let content: TextInput | null = null
    const imageItem = items.find((it) => this.visionService.isImageMimeType(it.mimeType))

    if (imageItem) {
      if (this.visionService.isEnabled && !this.visionService.isAllowed(session.isAuthenticated ?? false)) {
        this.logger.log(`[Vision] Blocked image from unauthenticated user ${session.connectionId}`)
        await this.sendText(session.connectionId, this.getText('IMAGE_AUTH_REQUIRED', session.lang), session.lang)
      } else {
        try {
          // Store the user-sent image as an uploadable ref even when no
          // vision provider is configured — the description is optional,
          // attachability (upload_media_to_mcp by refId) is not.
          const buffer = await this.visionService.fetchImage(imageItem.uri, imageItem.ciphering)
          const refId = this.imageRefStore.add(buffer, imageItem.mimeType, imageItem.uri ?? '', session.connectionId)
          this.logger.log(`[Image] Stored user image as ref "${refId}" (${imageItem.mimeType})`)

          let description = ''
          if (this.visionService.isEnabled) {
            try {
              description = (await this.visionService.describeBuffer(buffer, imageItem.mimeType)).text.trim()
            } catch (err) {
              this.logger.error(`[Vision] Description failed: ${err}`)
            }
          }
          content = { content: `[Image received — refId: ${refId}]${description ? ` ${description}` : ''}` }
        } catch (err) {
          this.logger.error(`[Image] Failed to process user image: ${err}`)
        }
      }
    }

    // Fallback stub when vision didn't produce content (not an image,
    // not enabled, blocked, or errored).
    if (!content) {
      const desc = (data.items ?? []).map((it) => it.mimeType).join(', ')
      content = { content: `[Media received: ${desc || 'unknown'}]` }
    }
    return content
  }

  /**
   * Recovers the selection id of a question answer from the response text,
   * using the mapping recorded when the question was sent. Falls back to the
   * response text itself when the thread is unknown (e.g. after a restart).
   */
  private resolveQuestionSelection(threadId: string | undefined, response: string): string | undefined {
    const mapping = threadId ? this.questionSelections.get(threadId) : undefined
    if (!mapping) {
      this.logger.warn(`[QUESTION] No selection mapping for thread ${threadId}; using the response text as id`)
      return response || undefined
    }
    return mapping.get(response) ?? (response || undefined)
  }

  /**
   * Sends a question whose valid responses are the given menu entries, and
   * records the text → id mapping to resolve the answer.
   */
  private async sendQuestionMenu(
    connectionId: string,
    question: string,
    menuItems: { id: string; text: string }[],
  ): Promise<void> {
    const { id } = await this.apiClient.didcomm.sendQuestion({
      connectionId,
      question,
      validResponses: menuItems.map((item) => ({ text: item.text })),
    })
    this.questionSelections.set(id, new Map(menuItems.map((item) => [item.text, item.id])))
    if (this.questionSelections.size > CoreService.MAX_QUESTION_THREADS) {
      const [oldest] = this.questionSelections.keys()
      this.questionSelections.delete(oldest)
    }
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
    await this.apiClient.didcomm.sendBasicMessage({
      connectionId: connectionId,
      content: this.getText(text, lang),
    })
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
   * Processes contextual menu selections (action-menu `perform` events).
   * Updates the session based on the selected option.
   *
   * @param action - The resolved action name (e.g. 'authenticate', 'logout', 'mcp-config').
   * @param session - The current session associated with the message.
   */
  private async handleContextualAction(action: string, session: SessionEntity): Promise<SessionEntity> {
    const { connectionId, lang } = session

    // 'authenticate' (re)starts the flow from any state except an active MCP
    // config flow: users may have dismissed or lost the original proof request,
    // so re-selecting the menu item must fully restart the flow and resend it.
    if (action === 'authenticate' && this.authFlowConfig.enabled && session.state !== StateStep.MCP_CONFIG) {
      await this.startAuthenticationFlow(session)
      return await this.sessionRepository.save(session)
    }

    switch (session.state) {
      case StateStep.CHAT: {
        this.logger.debug(`this.authFlowConfig.enabled: ${this.authFlowConfig.enabled}`)
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
   * Starts (or restarts) the credential authentication flow: sends a fresh
   * verifiable-credential proof request and moves the session to AUTH.
   * Safe to call repeatedly — each call resends the presentation request.
   *
   * @param session - The current session; its state is set to AUTH (not persisted here).
   */
  private async startAuthenticationFlow(session: SessionEntity): Promise<void> {
    const { connectionId, lang } = session
    const requestedCredential = this.getRequestedCredential()
    this.logger.debug(`requestedCredential: ${JSON.stringify(requestedCredential)}`)
    if (!requestedCredential) {
      throw new Error('Missing config: jsonSchemaCredentialId or credentialDefinitionId')
    }

    // autoAccept: the VS Agent acknowledges the presentation itself once the
    // proof and the trust decision both succeed; the outcome arrives as a
    // didcomm.presentations.state-updated event (done / abandoned / declined).
    const { proofExchangeId } = await this.apiClient.didcomm.createPresentationRequest({
      connectionId,
      requestedCredentials: [requestedCredential],
      autoAccept: true,
    })

    this.logger.debug(
      `[AUTH] Proof request ${proofExchangeId} sent to ${connectionId} (previous state: ${session.state})`,
    )
    session.state = StateStep.AUTH
    await this.sendText(connectionId, this.getText('AUTH_PROCESS_STARTED', lang), lang)
  }

  /**
   * The credential the authentication presentation request asks for. A
   * `jsonSchemaCredentialId` (the VTJSC of a credential schema) accepts that
   * credential from any accredited issuer and wins over a
   * `credentialDefinitionId`, which restricts it to one issuer. Every attribute
   * of the schema is requested.
   */
  private getRequestedCredential(): RequestedCredentialInput | undefined {
    const jsonSchemaCredentialId = this.authFlowConfig.jsonSchemaCredentialId?.trim()
    if (jsonSchemaCredentialId) return { jsonSchemaCredentialId }
    const credentialDefinitionId = this.authFlowConfig.credentialDefinitionId?.trim()
    if (credentialDefinitionId) return { credentialDefinitionId }
    return undefined
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
            const rawText = (content as { content: string }).content.trim()
            const threadId = (content as any).threadId as string | undefined
            const textContent = threadId ? `[Replying to messageId: ${threadId}] ${rawText}` : rawText

            // Guest access check: when auth is required, block unauthenticated messages
            if (rawText.length > 0 && !session.isAuthenticated && this.authFlowConfig.required) {
              this.logger.log(`[GUEST] Blocked message from unauthenticated user ${connectionId}`)
              await this.sendText(connectionId, this.getText('AUTH_REQUIRED', userLang), userLang)
              break
            }

            if (rawText.length > 0) {
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
          if (isPresentationResult(content)) {
            if (content.state === 'done' && content.verified) {
              session.isAuthenticated = true

              const claims = content.claims
              if (claims.length > 0) {
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
            } else {
              // abandoned (problem report from the holder, or a failed proof /
              // trust decision), declined, or done without verification. A
              // problem report gives an errorMessage of the form "<code>: <description>".
              const errorMessage = content.errorMessage || (content.verified ? content.state : 'not verified')
              this.logger.warn(`[AUTH] Presentation ended in "${content.state}": ${errorMessage}`)

              if (errorMessage.includes('no-compatible-credentials') && this.authFlowConfig.issuerServiceDid) {
                await this.sendText(connectionId, this.getText('AUTH_NO_CREDENTIAL', userLang), userLang)
                await this.apiClient.didcomm.createInvitation({
                  connectionId,
                  did: this.authFlowConfig.issuerServiceDid,
                })
                this.logger.log(
                  `[AUTH] Sent invitation to issuer service ${this.authFlowConfig.issuerServiceDid} for ${connectionId}`,
                )
              } else if (content.state === 'declined' || /request declined/i.test(errorMessage)) {
                // The user actively declined the proof request — no error, just
                // let them know how to retry when ready.
                await this.sendText(connectionId, this.getText('AUTH_DECLINED', userLang), userLang)
              } else {
                await this.sendText(connectionId, `${this.getText('AUTH_ERROR', userLang)}: ${errorMessage}`, userLang)
              }

              session.state = StateStep.CHAT
              await this.sessionRepository.save(session)
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

    const options: ActionMenuOption[] = this.menuItems
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
        return { name: item.id, title, description: '' }
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
      `[MENU] Sending contextual menu: title="${title}", desc="${description}", options=${JSON.stringify(options.map((o) => o.name))}`,
    )
    await this.apiClient.didcomm.sendMenu({
      connectionId: session.connectionId,
      menu: { title, description, options },
    })
    this.logger.log(`[MENU] Contextual menu sent successfully.`)
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
    if (action === 'authenticate') return this.authFlowConfig.enabled && !!this.getRequestedCredential()
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

    await this.sendQuestionMenu(
      session.connectionId,
      this.getText('MY_APPROVAL_REQUESTS_PROMPT', session.lang),
      menuItems,
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

    await this.sendQuestionMenu(session.connectionId, this.getText('PENDING_APPROVALS_PROMPT', session.lang), menuItems)
  }

  private static readonly APPROVAL_MENU_ACTIONS = [
    'review-approval',
    'approve-approval',
    'reject-approval',
    'cancel-approval',
  ]

  private isApprovalSelection(selectionId: string): boolean {
    return CoreService.APPROVAL_MENU_ACTIONS.some((action) => selectionId.startsWith(`${action}:`))
  }

  /**
   * Route review/approve/reject/cancel selections coming back from the
   * approval MenuDisplay messages (handleMyApprovalRequests /
   * handlePendingApprovals / handleReviewApproval).
   */
  private async handleApprovalSelection(selectionId: string, session: SessionEntity): Promise<void> {
    if (!this.approvalService) return
    const { connectionId, lang } = session
    const separator = selectionId.indexOf(':')
    const action = selectionId.slice(0, separator)
    const requestId = selectionId.slice(separator + 1)

    const request = await this.approvalService.getById(requestId)
    if (!request) {
      await this.sendText(connectionId, this.getText('APPROVAL_NOT_FOUND', lang), lang)
      return
    }

    // The identity used to resolve/cancel; legacy (adminAvatars) sessions may
    // have no RBAC identity, fall back to the user name.
    const actorIdentity = session.userIdentity || session.userName || connectionId

    if (action === 'cancel-approval') {
      try {
        const { applied } = await this.approvalService.cancel(requestId, actorIdentity)
        const key = applied ? 'APPROVAL_CANCELLED_CONFIRM' : 'APPROVAL_ALREADY_RESOLVED'
        await this.sendText(connectionId, this.getText(key, lang), lang)
      } catch (err) {
        this.logger.warn(`[APPROVAL] Cancel of ${requestId} by ${actorIdentity} refused: ${err}`)
        await this.sendText(connectionId, this.getText('APPROVAL_NOT_ALLOWED', lang), lang)
      }
      return
    }

    // review/approve/reject require one of the request's approver roles
    const canAct = (session.userRoles ?? []).some((role) => request.approverRoles.includes(role))
    if (!canAct) {
      await this.sendText(connectionId, this.getText('APPROVAL_NOT_ALLOWED', lang), lang)
      return
    }

    if (action === 'review-approval') {
      await this.handleReviewApproval(request, session)
      return
    }

    if (action === 'approve-approval' || action === 'reject-approval') {
      const resolveAction = action === 'approve-approval' ? 'approve' : 'reject'
      const { applied } = await this.approvalService.resolve(requestId, resolveAction, actorIdentity)
      const key = applied
        ? resolveAction === 'approve'
          ? 'APPROVAL_APPROVED_CONFIRM'
          : 'APPROVAL_REJECTED_CONFIRM'
        : 'APPROVAL_ALREADY_RESOLVED'
      await this.sendText(connectionId, this.getText(key, lang), lang)
    }
  }

  /**
   * Show the details of a pending request to an approver, with
   * Approve / Reject options.
   */
  private async handleReviewApproval(request: ApprovalRequestEntity, session: SessionEntity): Promise<void> {
    const { connectionId, lang } = session

    let details = this.getText('APPROVAL_REVIEW_DETAILS', lang)
      .replace('{requester}', request.requesterIdentity)
      .replace('{tool}', request.toolName)
      .replace('{server}', request.serverName)
      .replace('{args}', JSON.stringify(request.args ?? {}, null, 2))
      .replace('{expires}', request.expiresAt.toISOString())
    if (request.toolDescription) {
      details += `\n\n${request.toolDescription}`
    }
    await this.sendText(connectionId, details, lang)

    await this.sendQuestionMenu(connectionId, this.getText('APPROVAL_REVIEW_PROMPT', lang), [
      {
        id: `approve-approval:${request.id}`,
        text: this.getText('APPROVE', lang),
      },
      {
        id: `reject-approval:${request.id}`,
        text: this.getText('REJECT', lang),
      },
    ])
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

    await this.sendQuestionMenu(session.connectionId, this.getText('MCP_CONFIG_SELECT_SERVER', session.lang), menuItems)

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

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
  ProfileMessage,
  StatEnum,
  TextMessage,
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
import { StateStep } from './common/enums/state-step.enum'
import { ChatbotService } from '../chatbot/chatbot.service'
import { MemoryService } from '../memory/memory.service'
import { AgentContentService } from './agent-content.service'

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
    this.logger.log(`[INIT] authFlowConfig: enabled=${this.authFlowConfig.enabled}, credDefId=${this.credentialDefinitionId?.substring(0, 40)}..., adminAvatars=${JSON.stringify(this.authFlowConfig.adminAvatars)}`)
    this.logger.log(`[INIT] menuItems: ${JSON.stringify(this.menuItems.map(i => i.id))}`)
  }

  private readonly menuItems: { id: string; labelKey?: string; label?: string; action?: string; visibleWhen?: string }[]
  private readonly menuActions: Record<string, string | undefined>
  private readonly welcomeFlowConfig: { enabled: boolean; sendOnProfile: boolean; templateKey: string }
  private readonly authFlowConfig: { enabled: boolean; credentialDefinitionId?: string; adminAvatars: string[] }
  private readonly credentialDefinitionId?: string

  private isAdmin(session: SessionEntity): boolean {
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
            await this.handleContextualAction(selectionId, session)
          } else {
            this.logger.warn(`Invalid or missing selectionId: ${selectionId}`)
          }
          break
        }
        case MediaMessage.type:
          //inMsg = JsonTransformer.fromJSON(message, MediaMessage)
          content = 'media'
          break
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
   * @param selectionId - Identifier of the user's selection.
   * @param session - The current session associated with the message.
   */
  private async handleContextualAction(selectionId: string, session: SessionEntity): Promise<SessionEntity> {
    const { connectionId, lang } = session
    switch (session.state) {
      case StateStep.CHAT: {
        this.logger.debug(`this.authFlowConfig.enabled: ${this.authFlowConfig.enabled}`)
        if (selectionId === 'authenticate' && this.authFlowConfig.enabled) {
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

        if (selectionId === 'logout') {
          await this.sendText(connectionId, this.getText('LOGOUT_CONFIRMATION', lang), lang)
          session.isAuthenticated = false
          session.userName = ''
          await this.sessionRepository.save(session)
          await this.closeConnection(connectionId)
          await this.memoryService.clear(connectionId)
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

            if (textContent.length > 0) {
              const answer = await this.chatBotService.chat({
                userInput: textContent,
                session,
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
              await this.sendText(
                connectionId,
                `${this.getText('AUTH_ERROR', userLang)}: ${proofItem.errorCode}`,
                userLang,
              )
            } else {
              await this.sendText(connectionId, this.getText('WAITING_CREDENTIAL', userLang), userLang)
            }
          } else {
            await this.sendText(connectionId, this.getText('WAITING_CREDENTIAL', userLang), userLang)
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
    // Additional sensitive data can be reset here if needed.
    return await this.sessionRepository.save(session)
  }

  private async sendContextualMenu(session: SessionEntity): Promise<SessionEntity> {
    const options: ContextualMenuItem[] = this.menuItems
      .filter(
        (item) =>
          this.isMenuItemVisible(item.visibleWhen, session.isAuthenticated ?? false) &&
          this.isMenuActionEnabled(item.action),
      )
      .map(
        (item) =>
          new ContextualMenuItem({
            id: item.id,
            title: item.label ?? this.getText(item.labelKey ?? item.id, session.lang),
          }),
      )

    this.logger.log(`[MENU] options=${options.length}, isAuth=${session.isAuthenticated}, items=${this.menuItems.length}`)
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

    this.logger.log(`[MENU] Sending ContextualMenuUpdate: title="${title}", desc="${description}", options=${JSON.stringify(options.map(o => o.id))}`)
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

  async sendStats(kpi: STAT_KPI, session: SessionEntity) {
    this.logger.debug(`***send stats***`)
    const stats = [STAT_KPI[kpi]]
    if (session !== null && this.statProducer) await this.statProducer.spool(stats, session.connectionId, [new StatEnum(0, 'string')])
  }

  private isMenuItemVisible(visibleWhen: string | undefined, isAuthenticated: boolean) {
    switch (visibleWhen) {
      case 'authenticated':
        return !!isAuthenticated
      case 'unauthenticated':
        return !isAuthenticated
      default:
        return true
    }
  }

  private isMenuActionEnabled(action?: string) {
    if (!action) return true
    if (action === 'authenticate')
      return this.authFlowConfig.enabled && !!this.authFlowConfig.credentialDefinitionId?.trim()
    return true
  }
}

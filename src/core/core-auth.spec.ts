import { CoreService } from './core.service'
import { AgentContentService } from './agent-content.service'
import { SessionEntity } from './models'
import { StateStep } from './common/enums/state-step.enum'
import type { AuthFlowConfig } from '../config/agent-pack.loader'

/**
 * Tests for the VS Agent v2 event routing of CoreService: the contextual menu
 * (action menu), the credential authentication flow (presentation request +
 * didcomm.presentations.state-updated outcome) and incoming basic messages.
 */
describe('CoreService v2 events and authentication', () => {
  let sessionRepository: { findOneBy: jest.Mock; findOne: jest.Mock; create: jest.Mock; save: jest.Mock }
  let didcomm: {
    sendBasicMessage: jest.Mock
    sendMenu: jest.Mock
    sendQuestion: jest.Mock
    createPresentationRequest: jest.Mock
    createInvitation: jest.Mock
  }
  let chatBotService: { chat: jest.Mock }
  let session: SessionEntity
  let eventCount = 0

  const baseAuthConfig: AuthFlowConfig = {
    enabled: true,
    required: false,
    userIdentityAttribute: 'name',
    defaultRole: 'user',
    adminUsers: [],
    adminAvatars: [],
  }

  const makeService = (authConfig: Partial<AuthFlowConfig>): CoreService => {
    const agentContent = {
      getMenuItems: () => [
        { id: 'authenticate', labelKey: 'CREDENTIAL', action: 'authenticate', visibleWhen: 'unauthenticated' },
        { id: 'logout', labelKey: 'LOGOUT', action: 'logout', visibleWhen: 'authenticated' },
      ],
      getWelcomeFlowConfig: () => ({ enabled: false, sendOnProfile: false, templateKey: 'WELCOME' }),
      getAuthFlowConfig: () => ({ ...baseAuthConfig, ...authConfig }),
      getString: (_lang: string, key: string) => key,
      getDefaultLanguage: () => 'en',
      getUserControlledServers: () => [],
      getUserControlledServer: () => undefined,
    }
    const service = new CoreService(
      sessionRepository as never,
      { get: jest.fn(() => 'http://localhost:3000') } as never,
      chatBotService as never,
      { clear: jest.fn() } as never, // memoryService
      undefined as never, // statProducer (optional)
      agentContent as never,
      { isAvailable: false } as never, // mcpConfigService
      {} as never, // mcpService
      undefined as never, // rbacService (optional)
      undefined as never, // approvalService (optional)
      { isAudioMimeType: () => false, isEnabled: false } as never, // sttService
      { isImageMimeType: () => false, isEnabled: false } as never, // visionService
      { add: jest.fn(() => 'test-ref-id') } as never, // imageRefStore
    )
    ;(service as never as { apiClient: unknown }).apiClient = { didcomm }
    return service
  }

  const event = (type: string, data: Record<string, unknown>) => ({
    id: `evt-${++eventCount}`,
    type,
    timestamp: new Date().toISOString(),
    data: { connectionId: session.connectionId, ...data },
  })

  const presentation = (data: Record<string, unknown>) =>
    event('didcomm.presentations.state-updated', {
      proofExchangeId: 'proof-1',
      role: 'verifier',
      requestedCredentials: [],
      claims: [],
      verified: false,
      createdAt: '',
      updatedAt: '',
      previousState: 'request-sent',
      ...data,
    })

  const sentTexts = () => didcomm.sendBasicMessage.mock.calls.map(([body]) => body.content as string)

  beforeEach(() => {
    session = {
      id: 1,
      connectionId: 'conn-1',
      state: StateStep.CHAT,
      isAuthenticated: false,
      lang: 'en',
    } as unknown as SessionEntity
    sessionRepository = {
      findOneBy: jest.fn(async () => session),
      findOne: jest.fn(async () => session),
      create: jest.fn((dto) => dto),
      save: jest.fn(async (entity) => entity),
    }
    didcomm = {
      sendBasicMessage: jest.fn(async () => ({ id: 'msg' })),
      sendMenu: jest.fn(async () => ({ id: 'menu' })),
      sendQuestion: jest.fn(async () => ({ id: 'question' })),
      createPresentationRequest: jest.fn(async () => ({ proofExchangeId: 'proof-1' })),
      createInvitation: jest.fn(async () => ({ messageId: 'invitation' })),
    }
    chatBotService = { chat: jest.fn(async () => 'LLM answer') }
  })

  it('sends the contextual menu as an action menu on a new connection', async () => {
    const service = makeService({ credentialDefinitionId: 'cred-def-1' })

    await service.newConnection(session.connectionId)

    expect(didcomm.sendMenu).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      menu: {
        title: 'ROOT_TITLE',
        description: 'Not Authenticated',
        options: [{ name: 'authenticate', title: 'CREDENTIAL', description: '' }],
      },
    })
  })

  it('hides the authenticate entry when no credential is configured', async () => {
    const service = makeService({})

    await service.newConnection(session.connectionId)

    expect(didcomm.sendMenu).not.toHaveBeenCalled()
  })

  it('requests the credential by jsonSchemaCredentialId, preferred over credentialDefinitionId', async () => {
    const service = makeService({
      jsonSchemaCredentialId: 'https://ecosystem.example/vt/schemas-avatar-jsc.json',
      credentialDefinitionId: 'cred-def-1',
    })

    await service.onEvent(event('didcomm.action-menu.perform-received', { threadId: 't', name: 'authenticate' }))

    expect(didcomm.createPresentationRequest).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      requestedCredentials: [{ jsonSchemaCredentialId: 'https://ecosystem.example/vt/schemas-avatar-jsc.json' }],
      autoAccept: true,
    })
    expect(session.state).toBe(StateStep.AUTH)
    expect(sentTexts()).toContain('AUTH_PROCESS_STARTED')
  })

  it('falls back to credentialDefinitionId when no jsonSchemaCredentialId is set', async () => {
    const service = makeService({ credentialDefinitionId: 'cred-def-1' })

    await service.onEvent(event('didcomm.action-menu.perform-received', { threadId: 't', name: 'authenticate' }))

    expect(didcomm.createPresentationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestedCredentials: [{ credentialDefinitionId: 'cred-def-1' }] }),
    )
  })

  it('authenticates and greets the user by the name claim of a verified presentation', async () => {
    const service = makeService({ jsonSchemaCredentialId: 'vtjsc-avatar' })
    session.state = StateStep.AUTH

    await service.onEvent(
      presentation({
        state: 'done',
        verified: true,
        claims: [
          { name: 'name', value: 'Alice' },
          { name: 'avatar', value: 'data:image/png;base64,AAAA' },
        ],
      }),
    )

    expect(session.isAuthenticated).toBe(true)
    expect(session.userName).toBe('Alice')
    expect(session.state).toBe(StateStep.CHAT)
    expect(sentTexts()).toContain('AUTH_SUCCESS_NAME')
  })

  it('ignores intermediate presentation states', async () => {
    const service = makeService({ jsonSchemaCredentialId: 'vtjsc-avatar' })
    session.state = StateStep.AUTH

    await service.onEvent(presentation({ state: 'presentation-received', verified: true }))

    expect(session.isAuthenticated).toBe(false)
    expect(didcomm.sendBasicMessage).not.toHaveBeenCalled()
    expect(didcomm.sendMenu).not.toHaveBeenCalled()
  })

  it('invites the user to the issuer service when the holder has no compatible credential', async () => {
    const service = makeService({ jsonSchemaCredentialId: 'vtjsc-avatar', issuerServiceDid: 'did:webvh:issuer' })
    session.state = StateStep.AUTH

    await service.onEvent(
      presentation({ state: 'abandoned', errorMessage: 'e.msg.error: e.req.no-compatible-credentials' }),
    )

    expect(sentTexts()).toContain('AUTH_NO_CREDENTIAL')
    expect(didcomm.createInvitation).toHaveBeenCalledWith({ connectionId: 'conn-1', did: 'did:webvh:issuer' })
    expect(session.state).toBe(StateStep.CHAT)
    expect(session.isAuthenticated).toBe(false)
  })

  it('tells the user how to retry when the proof request is declined', async () => {
    const service = makeService({ jsonSchemaCredentialId: 'vtjsc-avatar' })
    session.state = StateStep.AUTH

    await service.onEvent(presentation({ state: 'abandoned', errorMessage: 'e.msg.error: Request declined' }))

    expect(sentTexts()).toContain('AUTH_DECLINED')
    expect(didcomm.createInvitation).not.toHaveBeenCalled()
  })

  it('reports other presentation failures with the error message', async () => {
    const service = makeService({ jsonSchemaCredentialId: 'vtjsc-avatar' })
    session.state = StateStep.AUTH

    await service.onEvent(presentation({ state: 'abandoned', errorMessage: 'e.p.issuer-not-authorized: denied' }))

    expect(sentTexts()).toContain('AUTH_ERROR: e.p.issuer-not-authorized: denied')
    expect(session.isAuthenticated).toBe(false)
  })

  it('routes basic messages to the chatbot and answers with a basic message', async () => {
    const service = makeService({})

    await service.onEvent(
      event('didcomm.basic-messages.message-received', {
        id: 'bm-1',
        role: 'receiver',
        content: '  hello  ',
        sentTime: '',
        createdAt: '',
      }),
    )

    expect(chatBotService.chat).toHaveBeenCalledWith(expect.objectContaining({ userInput: 'hello' }))
    expect(didcomm.sendBasicMessage).toHaveBeenCalledWith({ connectionId: 'conn-1', content: 'LLM answer' })
  })

  it('ignores events it does not act on', async () => {
    const service = makeService({})

    await service.onEvent(event('didcomm.receipts.message-receipts-received', { receipts: [] }))
    await service.onEvent({ id: 'x', type: 'some.unknown.event', timestamp: '', data: {} })

    expect(sessionRepository.findOneBy).not.toHaveBeenCalled()
    expect(didcomm.sendBasicMessage).not.toHaveBeenCalled()
  })
})

describe('AgentContentService authentication config', () => {
  const makeContent = (pack: Record<string, unknown> | null, env: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = { 'appConfig.agentPack': pack, ...env }
    return new AgentContentService({ get: (key: string) => values[key] } as never)
  }

  it('reads jsonSchemaCredentialId from the agent pack, then from JSON_SCHEMA_CREDENTIAL_ID', () => {
    const fromPack = makeContent(
      { flows: { authentication: { jsonSchemaCredentialId: 'vtjsc-pack' } } },
      {
        'appConfig.jsonSchemaCredentialId': 'vtjsc-env',
      },
    )
    expect(fromPack.getAuthFlowConfig().jsonSchemaCredentialId).toBe('vtjsc-pack')

    const fromEnv = makeContent(null, { 'appConfig.jsonSchemaCredentialId': 'vtjsc-env' })
    expect(fromEnv.getAuthFlowConfig().jsonSchemaCredentialId).toBe('vtjsc-env')
  })

  it('treats an unresolved ${VAR} placeholder or an empty value as unset', () => {
    const content = makeContent(
      { flows: { authentication: { jsonSchemaCredentialId: '${JSON_SCHEMA_CREDENTIAL_ID}' } } },
      { 'appConfig.credentialDefinitionId': 'cred-def-1' },
    )
    const config = content.getAuthFlowConfig()
    expect(config.jsonSchemaCredentialId).toBeUndefined()
    expect(config.credentialDefinitionId).toBe('cred-def-1')

    expect(
      makeContent(null, { 'appConfig.jsonSchemaCredentialId': '' }).getAuthFlowConfig().jsonSchemaCredentialId,
    ).toBeUndefined()
  })
})

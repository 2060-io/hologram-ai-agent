import { MenuSelectMessage } from '@2060.io/vs-agent-nestjs-client'
import { CoreService } from './core.service'
import { SessionEntity } from './models'
import { StateStep } from './common/enums/state-step.enum'
import { ApprovalRequestEntity, ApprovalStatus } from '../rbac/approval-request.entity'

/**
 * Tests for the approval menu wiring: MenuSelect messages carrying
 * review-approval / approve-approval / reject-approval / cancel-approval
 * ids must reach ApprovalService with the proper authorization checks.
 */
describe('CoreService approval selections', () => {
  let approvalService: {
    getById: jest.Mock
    resolve: jest.Mock
    cancel: jest.Mock
    countByRequester: jest.Mock
    countPendingForApprover: jest.Mock
    getByRequester: jest.Mock
    getPendingForApprover: jest.Mock
  }
  let sessionRepository: { findOneBy: jest.Mock; findOne: jest.Mock; create: jest.Mock; save: jest.Mock }
  let sentMessages: { type?: string; content?: string; prompt?: string; menuItems?: { id: string }[] }[]
  let service: CoreService
  let session: SessionEntity

  const request = (): ApprovalRequestEntity =>
    ({
      id: 'req-1',
      serverName: 'wise',
      toolName: 'send_money',
      args: { amount: 10 },
      requesterIdentity: 'bob',
      requesterConnectionId: 'conn-bob',
      approverRoles: ['finance'],
      status: ApprovalStatus.PENDING,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    }) as ApprovalRequestEntity

  const makeSession = (overrides: Partial<SessionEntity> = {}): SessionEntity =>
    ({
      id: 1,
      connectionId: 'conn-alice',
      state: StateStep.CHAT,
      isAuthenticated: true,
      lang: 'en',
      userIdentity: 'alice',
      userName: 'Alice',
      userRoles: ['finance'],
      ...overrides,
    }) as unknown as SessionEntity

  beforeEach(() => {
    approvalService = {
      getById: jest.fn(),
      resolve: jest.fn(async () => ({ applied: true, request: request() })),
      cancel: jest.fn(async () => ({ applied: true, request: request() })),
      countByRequester: jest.fn(async () => 0),
      countPendingForApprover: jest.fn(async () => 0),
      getByRequester: jest.fn(async () => []),
      getPendingForApprover: jest.fn(async () => []),
    }
    session = makeSession()
    sessionRepository = {
      findOneBy: jest.fn(async () => session),
      findOne: jest.fn(async () => session),
      create: jest.fn((dto) => dto),
      save: jest.fn(async (entity) => entity),
    }
    const agentContent = {
      getMenuItems: () => [],
      getWelcomeFlowConfig: () => ({ enabled: false, sendOnProfile: false, templateKey: 'WELCOME' }),
      getAuthFlowConfig: () => ({ enabled: false, required: false, adminAvatars: [] }),
      getString: (_lang: string, key: string) => key,
      getDefaultLanguage: () => 'en',
      getUserControlledServers: () => [],
      getUserControlledServer: () => undefined,
    }
    const configService = { get: jest.fn(() => 'http://localhost:3001') }

    service = new CoreService(
      sessionRepository as never,
      configService as never,
      {} as never, // chatBotService
      {} as never, // memoryService
      undefined as never, // statProducer (optional)
      agentContent as never,
      { isAvailable: false } as never, // mcpConfigService
      {} as never, // mcpService
      undefined as never, // rbacService (optional)
      approvalService as never,
      { isAudioMimeType: () => false, isEnabled: false } as never, // sttService
      { isImageMimeType: () => false, isEnabled: false } as never, // visionService
    )

    sentMessages = []
    ;(service as never as { apiClient: unknown }).apiClient = {
      messages: {
        send: jest.fn(async (msg: (typeof sentMessages)[number]) => {
          sentMessages.push(msg)
          return {}
        }),
      },
    }
  })

  const selectFromMenu = async (id: string) =>
    service.inputMessage({
      type: MenuSelectMessage.type,
      connectionId: session.connectionId,
      menuItems: [{ id }],
    } as never)

  it('routes approve-approval selections to ApprovalService.resolve with the approver identity', async () => {
    approvalService.getById.mockResolvedValue(request())

    await selectFromMenu('approve-approval:req-1')

    expect(approvalService.resolve).toHaveBeenCalledWith('req-1', 'approve', 'alice')
    expect(sentMessages.some((m) => m.content === 'APPROVAL_APPROVED_CONFIRM')).toBe(true)
  })

  it('routes reject-approval selections to ApprovalService.resolve', async () => {
    approvalService.getById.mockResolvedValue(request())

    await selectFromMenu('reject-approval:req-1')

    expect(approvalService.resolve).toHaveBeenCalledWith('req-1', 'reject', 'alice')
    expect(sentMessages.some((m) => m.content === 'APPROVAL_REJECTED_CONFIRM')).toBe(true)
  })

  it('refuses approvals from users without a matching approver role', async () => {
    session = makeSession({ userRoles: ['ops'] })
    approvalService.getById.mockResolvedValue(request())

    await selectFromMenu('approve-approval:req-1')

    expect(approvalService.resolve).not.toHaveBeenCalled()
    expect(sentMessages.some((m) => m.content === 'APPROVAL_NOT_ALLOWED')).toBe(true)
  })

  it('reports already-resolved requests instead of re-resolving', async () => {
    approvalService.getById.mockResolvedValue(request())
    approvalService.resolve.mockResolvedValue({ applied: false, request: request() })

    await selectFromMenu('approve-approval:req-1')

    expect(sentMessages.some((m) => m.content === 'APPROVAL_ALREADY_RESOLVED')).toBe(true)
  })

  it('review-approval sends the request details and an Approve/Reject menu', async () => {
    approvalService.getById.mockResolvedValue(request())

    await selectFromMenu('review-approval:req-1')

    expect(approvalService.resolve).not.toHaveBeenCalled()
    // The mocked getString returns the i18n key itself, so the details
    // message is the (placeholder-free) APPROVAL_REVIEW_DETAILS key.
    const details = sentMessages.find(
      (m) => typeof m.content === 'string' && m.content.startsWith('APPROVAL_REVIEW_DETAILS'),
    )
    expect(details).toBeDefined()
    const menu = sentMessages.find((m) => m.menuItems?.length === 2)
    expect(menu?.menuItems?.map((i) => i.id)).toEqual(['approve-approval:req-1', 'reject-approval:req-1'])
  })

  it('cancel-approval delegates to ApprovalService.cancel with the actor identity', async () => {
    session = makeSession({ userIdentity: 'bob', userRoles: [] })
    approvalService.getById.mockResolvedValue(request())

    await selectFromMenu('cancel-approval:req-1')

    expect(approvalService.cancel).toHaveBeenCalledWith('req-1', 'bob')
    expect(sentMessages.some((m) => m.content === 'APPROVAL_CANCELLED_CONFIRM')).toBe(true)
  })

  it('reports refused cancellations (non-requester) without crashing', async () => {
    approvalService.getById.mockResolvedValue(request())
    approvalService.cancel.mockRejectedValue(new Error('Only the requester can cancel their request'))

    await selectFromMenu('cancel-approval:req-1')

    expect(sentMessages.some((m) => m.content === 'APPROVAL_NOT_ALLOWED')).toBe(true)
  })

  it('tells the user when the approval request no longer exists', async () => {
    approvalService.getById.mockResolvedValue(null)

    await selectFromMenu('approve-approval:req-gone')

    expect(approvalService.resolve).not.toHaveBeenCalled()
    expect(sentMessages.some((m) => m.content === 'APPROVAL_NOT_FOUND')).toBe(true)
  })

  it('keeps routing MCP-config server selections when not an approval id', async () => {
    session = makeSession({ state: StateStep.MCP_CONFIG, mcpConfigServer: undefined })
    const startMcpConfig = jest.fn(async () => undefined)
    ;(service as never as { startMcpConfigForServer: unknown }).startMcpConfigForServer = startMcpConfig

    await selectFromMenu('github')

    expect(startMcpConfig).toHaveBeenCalledWith('github', session)
  })
})

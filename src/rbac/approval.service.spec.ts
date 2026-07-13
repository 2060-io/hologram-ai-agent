import { ApprovalService } from './approval.service'
import { ApprovalRequestEntity, ApprovalStatus } from './approval-request.entity'

describe('ApprovalService', () => {
  let repo: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; find: jest.Mock; count: jest.Mock }
  let eventEmitter: { emit: jest.Mock }
  let service: ApprovalService

  const pendingRequest = (): ApprovalRequestEntity =>
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

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn(async (entity) => entity),
      create: jest.fn((dto) => dto),
      find: jest.fn(),
      count: jest.fn(),
    }
    eventEmitter = { emit: jest.fn() }
    service = new ApprovalService(repo as never, eventEmitter as never, undefined as never)
  })

  it('approves a pending request and emits approval.resolved', async () => {
    repo.findOne.mockResolvedValue(pendingRequest())

    const { applied, request } = await service.resolve('req-1', 'approve', 'alice')

    expect(applied).toBe(true)
    expect(request.status).toBe(ApprovalStatus.APPROVED)
    expect(request.resolvedBy).toBe('alice')
    expect(request.resolvedAt).toBeInstanceOf(Date)
    expect(eventEmitter.emit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({ id: 'req-1' }))
  })

  it('rejects a pending request', async () => {
    repo.findOne.mockResolvedValue(pendingRequest())

    const { applied, request } = await service.resolve('req-1', 'reject', 'alice')

    expect(applied).toBe(true)
    expect(request.status).toBe(ApprovalStatus.REJECTED)
  })

  it('does not re-resolve an already resolved request (first approver wins)', async () => {
    const resolved = pendingRequest()
    resolved.status = ApprovalStatus.APPROVED
    repo.findOne.mockResolvedValue(resolved)

    const { applied } = await service.resolve('req-1', 'reject', 'carol')

    expect(applied).toBe(false)
    expect(repo.save).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })

  it('throws when resolving an unknown request', async () => {
    repo.findOne.mockResolvedValue(null)

    await expect(service.resolve('missing', 'approve', 'alice')).rejects.toThrow('not found')
  })

  it('lets the requester cancel a pending request', async () => {
    repo.findOne.mockResolvedValue(pendingRequest())

    const { applied, request } = await service.cancel('req-1', 'bob')

    expect(applied).toBe(true)
    expect(request.status).toBe(ApprovalStatus.CANCELLED)
    expect(eventEmitter.emit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({ id: 'req-1' }))
  })

  it('refuses cancellation by anyone but the requester', async () => {
    repo.findOne.mockResolvedValue(pendingRequest())

    await expect(service.cancel('req-1', 'mallory')).rejects.toThrow('Only the requester')
    expect(repo.save).not.toHaveBeenCalled()
  })
})

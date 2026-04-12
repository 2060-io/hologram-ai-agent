import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, In } from 'typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { ApprovalRequestEntity, ApprovalStatus } from './approval-request.entity'
import { RbacService } from './rbac.service'

export interface CreateApprovalDto {
  serverName: string
  toolName: string
  args: Record<string, unknown>
  requesterIdentity: string
  requesterConnectionId: string
  requesterLang?: string
  approverRoles: string[]
  expiresAt: Date
  toolDescription?: string
}

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name)

  constructor(
    @InjectRepository(ApprovalRequestEntity)
    private readonly repo: Repository<ApprovalRequestEntity>,
    private readonly eventEmitter: EventEmitter2,
    private readonly rbacService: RbacService,
  ) {}

  /**
   * Create a pending approval request and emit 'approval.created' event.
   */
  async create(dto: CreateApprovalDto): Promise<ApprovalRequestEntity> {
    const entity = this.repo.create({
      serverName: dto.serverName,
      toolName: dto.toolName,
      args: dto.args,
      requesterIdentity: dto.requesterIdentity,
      requesterConnectionId: dto.requesterConnectionId,
      requesterLang: dto.requesterLang,
      approverRoles: dto.approverRoles,
      expiresAt: dto.expiresAt,
      toolDescription: dto.toolDescription,
      status: ApprovalStatus.PENDING,
    })

    const saved = await this.repo.save(entity)
    this.logger.log(`[APPROVAL] Created request ${saved.id}: ${dto.toolName} by ${dto.requesterIdentity}`)

    this.eventEmitter.emit('approval.created', saved)
    return saved
  }

  /**
   * Approve or reject a request. First approver wins.
   * Returns true if the action was applied, false if already resolved.
   */
  async resolve(
    requestId: string,
    action: 'approve' | 'reject',
    resolverIdentity: string,
  ): Promise<{ applied: boolean; request: ApprovalRequestEntity }> {
    const request = await this.repo.findOne({ where: { id: requestId } })
    if (!request) {
      throw new Error(`Approval request ${requestId} not found`)
    }

    if (request.status !== ApprovalStatus.PENDING) {
      this.logger.warn(`[APPROVAL] Request ${requestId} already resolved as ${request.status}`)
      return { applied: false, request }
    }

    request.status = action === 'approve' ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED
    request.resolvedBy = resolverIdentity
    request.resolvedAt = new Date()

    const saved = await this.repo.save(request)
    this.logger.log(`[APPROVAL] Request ${requestId} ${action}d by ${resolverIdentity}`)

    this.eventEmitter.emit('approval.resolved', saved)
    return { applied: true, request: saved }
  }

  /**
   * Cancel a request (by the requester).
   */
  async cancel(requestId: string, requesterIdentity: string): Promise<{ applied: boolean; request: ApprovalRequestEntity }> {
    const request = await this.repo.findOne({ where: { id: requestId } })
    if (!request) {
      throw new Error(`Approval request ${requestId} not found`)
    }

    if (request.requesterIdentity !== requesterIdentity) {
      throw new Error('Only the requester can cancel their request')
    }

    if (request.status !== ApprovalStatus.PENDING) {
      this.logger.warn(`[APPROVAL] Request ${requestId} already resolved as ${request.status}`)
      return { applied: false, request }
    }

    request.status = ApprovalStatus.CANCELLED
    request.resolvedAt = new Date()

    const saved = await this.repo.save(request)
    this.logger.log(`[APPROVAL] Request ${requestId} cancelled by ${requesterIdentity}`)

    this.eventEmitter.emit('approval.resolved', saved)
    return { applied: true, request: saved }
  }

  /**
   * Get all pending requests submitted by a specific user.
   */
  async getByRequester(identity: string): Promise<ApprovalRequestEntity[]> {
    return this.repo.find({
      where: { requesterIdentity: identity, status: ApprovalStatus.PENDING },
      order: { createdAt: 'DESC' },
    })
  }

  /**
   * Count pending requests for a requester.
   */
  async countByRequester(identity: string): Promise<number> {
    return this.repo.count({
      where: { requesterIdentity: identity, status: ApprovalStatus.PENDING },
    })
  }

  /**
   * Get all pending requests that a user with the given roles can approve.
   */
  async getPendingForApprover(approverRoles: string[]): Promise<ApprovalRequestEntity[]> {
    if (approverRoles.length === 0) return []

    // Find all pending requests where any of the approverRoles intersects with
    // the request's approverRoles. Since approverRoles is stored as simple-json,
    // we query all pending and filter in memory.
    const allPending = await this.repo.find({
      where: { status: ApprovalStatus.PENDING },
      order: { createdAt: 'DESC' },
    })

    return allPending.filter((req) =>
      req.approverRoles.some((role) => approverRoles.includes(role)),
    )
  }

  /**
   * Count pending requests for an approver with given roles.
   */
  async countPendingForApprover(approverRoles: string[]): Promise<number> {
    const pending = await this.getPendingForApprover(approverRoles)
    return pending.length
  }

  /**
   * Get a single request by ID.
   */
  async getById(requestId: string): Promise<ApprovalRequestEntity | null> {
    return this.repo.findOne({ where: { id: requestId } })
  }

  /**
   * Expire stale requests past their timeout. Called periodically.
   */
  async expireStale(): Promise<number> {
    const now = new Date()
    const stale = await this.repo
      .createQueryBuilder('r')
      .where('r.status = :status', { status: ApprovalStatus.PENDING })
      .andWhere('r.expiresAt <= :now', { now })
      .getMany()

    if (stale.length === 0) return 0

    for (const request of stale) {
      request.status = ApprovalStatus.EXPIRED
      request.resolvedAt = now
      await this.repo.save(request)
      this.eventEmitter.emit('approval.resolved', request)
    }

    this.logger.log(`[APPROVAL] Expired ${stale.length} stale request(s)`)
    return stale.length
  }
}

import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'

export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

@Entity('approval_requests')
export class ApprovalRequestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255 })
  serverName: string

  @Column({ type: 'varchar', length: 255 })
  toolName: string

  @Column({ type: 'simple-json' })
  args: Record<string, unknown>

  @Column({ type: 'varchar', length: 255 })
  requesterIdentity: string

  @Column({ type: 'varchar', length: 255 })
  requesterConnectionId: string

  @Column({ type: 'varchar', length: 10, nullable: true })
  requesterLang?: string

  @Column({
    type: 'varchar',
    length: 20,
    default: ApprovalStatus.PENDING,
  })
  status: ApprovalStatus

  @Column({ type: 'simple-json' })
  approverRoles: string[]

  @Column({ type: 'varchar', length: 255, nullable: true })
  resolvedBy?: string

  @CreateDateColumn()
  createdAt: Date

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt?: Date

  @Column({ type: 'timestamp' })
  expiresAt: Date

  @Column({ type: 'text', nullable: true })
  toolDescription?: string
}

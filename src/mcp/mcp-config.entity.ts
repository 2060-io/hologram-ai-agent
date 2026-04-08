import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm'

@Entity('mcp_user_config')
@Unique(['avatarName', 'serverName'])
export class McpConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 255, nullable: false })
  avatarName: string

  @Column({ type: 'varchar', length: 255, nullable: false })
  serverName: string

  @Column({ type: 'bytea', nullable: false })
  encryptedCfg: Buffer

  @Column({ type: 'bytea', nullable: false })
  iv: Buffer

  @Column({ type: 'bytea', nullable: false })
  authTag: Buffer

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date
}

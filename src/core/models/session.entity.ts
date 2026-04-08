// session.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm'
import { StateStep } from '../common'

@Entity('session')
export class SessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', nullable: false })
  connectionId: string

  @Column({ type: 'varchar', length: 10, nullable: true })
  lang: string

  @Column({
    type: 'enum',
    enum: StateStep,
  })
  state?: StateStep

  @CreateDateColumn()
  createdTs?: Date

  @UpdateDateColumn()
  updatedTs?: Date

  @Column({ default: false, nullable: true })
  isAuthenticated?: boolean

  @Column({ nullable: true })
  userName?: string

  @Column({ type: 'varchar', length: 255, nullable: true })
  mcpConfigServer?: string

  @Column({ type: 'int', nullable: true })
  mcpConfigFieldIndex?: number
}

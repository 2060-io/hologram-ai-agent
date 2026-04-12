import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { ApprovalService } from './approval.service'

@Injectable()
export class ApprovalExpiryTask {
  private readonly logger = new Logger(ApprovalExpiryTask.name)

  constructor(private readonly approvalService: ApprovalService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpiry(): Promise<void> {
    try {
      const count = await this.approvalService.expireStale()
      if (count > 0) {
        this.logger.log(`[EXPIRY] Expired ${count} stale approval request(s)`)
      }
    } catch (err) {
      this.logger.error(`[EXPIRY] Error expiring stale requests: ${err}`)
    }
  }
}

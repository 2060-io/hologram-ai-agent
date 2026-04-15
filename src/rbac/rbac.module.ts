import { Global, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { EventEmitterModule } from '@nestjs/event-emitter'
import { ScheduleModule } from '@nestjs/schedule'
import { RbacService } from './rbac.service'
import { ApprovalService } from './approval.service'
import { ToolCallInterceptorService } from './tool-call-interceptor.service'
import { ApprovalEventHandler } from './approval-event.handler'
import { ApprovalRequestEntity } from './approval-request.entity'
import { ApprovalExpiryTask } from './approval-expiry.task'
import { SessionEntity } from '../core/models'

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequestEntity, SessionEntity]),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
  ],
  providers: [RbacService, ApprovalService, ToolCallInterceptorService, ApprovalEventHandler, ApprovalExpiryTask],
  exports: [RbacService, ApprovalService, ToolCallInterceptorService],
})
export class RbacModule {}

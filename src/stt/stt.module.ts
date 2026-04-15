import { Module } from '@nestjs/common'
import { SttService } from './stt.service'

@Module({
  providers: [SttService],
  exports: [SttService],
})
export class SttModule {}

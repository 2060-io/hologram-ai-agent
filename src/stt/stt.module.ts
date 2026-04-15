import { Global, Module } from '@nestjs/common'
import { SttService } from './stt.service'

@Global()
@Module({
  providers: [SttService],
  exports: [SttService],
})
export class SttModule {}

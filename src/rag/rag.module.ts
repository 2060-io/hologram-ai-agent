import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RagService } from './rag.service'
import { VectorStoreService } from './vector-store.service'
import { LangchainRagService } from './langchain-rag.service'
import { RagManifestEntity } from './entities/rag-manifest.entity'

@Module({
  imports: [TypeOrmModule.forFeature([RagManifestEntity])],
  providers: [RagService, VectorStoreService, LangchainRagService],
  exports: [RagService, LangchainRagService],
})
export class RagModule {}

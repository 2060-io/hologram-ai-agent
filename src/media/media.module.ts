import { Module } from '@nestjs/common'
import { MediaStoreService } from './media-store.service'
import { ImageConverterService } from './image-converter.service'
import { ImageRefStore } from './image-ref.store'
import { ImageGenerationService } from './image-generation.service'

@Module({
  providers: [MediaStoreService, ImageConverterService, ImageRefStore, ImageGenerationService],
  exports: [MediaStoreService, ImageConverterService, ImageRefStore, ImageGenerationService],
})
export class MediaModule {}

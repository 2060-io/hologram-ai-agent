import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { StateStep } from '../../core/common/enums/state-step.enum'

export class AskDto {
  @ApiProperty({
    description: 'The message/question from the user.',
    example: 'What is Hologram?',
  })
  userInput: string

  @ApiProperty({
    description: 'Unique identifier for the user connection/session.',
    example: 'abc123',
  })
  connectionId: string

  @ApiPropertyOptional({
    description: 'Language code for the conversation (ISO 639-1).',
    example: 'en',
  })
  lang?: string

  @ApiPropertyOptional({
    description: 'Indicates if the user is authenticated.',
    example: true,
  })
  isAuthenticated?: boolean

  @ApiPropertyOptional({
    description: 'Optional user name for personalization.',
    example: 'Alice',
  })
  userName?: string

  @ApiPropertyOptional({
    description: 'Current state of the user/session.',
    enum: StateStep,
    example: StateStep.CHAT,
  })
  state?: StateStep
}

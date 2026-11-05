import { Injectable } from '@nestjs/common'
import { EventEnvelope, EventHandler, UnknownEventEnvelope } from '@verana-labs/vs-agent-nestjs-client'
import { CoreService } from './core.service'

/**
 * The event handler registered with the VS Agent EventsModule.
 *
 * EventsModule instantiates its handler class itself and, in v2, takes no
 * `imports` to resolve that class's dependencies. CoreService depends on
 * non-global modules (chatbot, memory, media), so this thin handler delegates
 * to the single CoreService instance exported by the global CoreModule.
 */
@Injectable()
export class VsAgentEventHandler implements EventHandler {
  constructor(private readonly coreService: CoreService) {}

  newConnection(connectionId: string): Promise<void> {
    return this.coreService.newConnection(connectionId)
  }

  closeConnection(connectionId: string): Promise<void> {
    return this.coreService.closeConnection(connectionId)
  }

  onEvent(envelope: EventEnvelope | UnknownEventEnvelope): Promise<void> {
    return this.coreService.onEvent(envelope)
  }
}

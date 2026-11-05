# JMS integration Module

## Overview

Hologram Generic AI Agent implements includes a statistics (stats) module that communicates via JMS (Java Message Service) to send and receive agent metrics and events. This module is designed to work with brokers like Apache ActiveMQ Artemis.

## How It Works

When enabled, the stats module connects to a JMS broker (such as Artemis) and subscribes to a specific queue where VS Agent publishes real-time metrics. Your NestJS application listens to these metrics through the configured event handler, enabling features like live monitoring, analytics, or audit logging.

## Required Environment Variables

| Variable Name             | Description                                                                    | Example Value / Default |
| ------------------------- | ------------------------------------------------------------------------------ | ----------------------- |
| `VS_AGENT_STATS_ENABLED`  | Enables (`true`) or disables (`false`) the stats module and its JMS connection | `true`                  |
| `VS_AGENT_STATS_HOST`     | Hostname or IP address of your JMS broker (e.g., Artemis)                      | `localhost`             |
| `VS_AGENT_STATS_PORT`     | Port number where the JMS broker is listening                                  | `61616`                 |
| `VS_AGENT_STATS_QUEUE`    | The JMS queue name where stats are published                                   | `stats.queue`           |
| `VS_AGENT_STATS_USER`     | Username for authenticating with the JMS broker                                | `artemis`               |
| `VS_AGENT_STATS_PASSWORD` | Password for authenticating with the JMS broker                                | `artemis`               |

## Enabling JMS Stats Integration in `main.module.ts`

```typescript
import { EventsModule } from '@verana-labs/vs-agent-nestjs-client'

EventsModule.register({
  url: process.env.VS_AGENT_ADMIN_URL || 'http://localhost:3001',
  webhookApiKey: process.env.EVENTS_WEBHOOK_API_KEY || undefined,
  // a thin handler that delegates to the CoreService exported by the global CoreModule
  eventHandler: VsAgentEventHandler,
  modules: {
    connections: true,
    stats: process.env.VS_AGENT_STATS_ENABLED === 'true',
  },
  statOptions: {
    host: process.env.VS_AGENT_STATS_HOST,
    port: Number(process.env.VS_AGENT_STATS_PORT),
    queue: process.env.VS_AGENT_STATS_QUEUE,
    username: process.env.VS_AGENT_STATS_USER,
    password: process.env.VS_AGENT_STATS_PASSWORD,
    reconnectLimit: 10,
    threads: 2,
    delay: 1000,
  },
})
```

---

## Producing/Spooling Statistics Events in CoreService

Use the `sendStats()` method (already included in your CoreService) to produce events to JMS:

```typescript
import { STAT_KPI } from './common'
import { StatEnum } from '@verana-labs/vs-agent-model'

async sendStats(kpi: STAT_KPI, session: SessionEntity) {
  this.logger.debug(`***send stats***`)
  const stats = [STAT_KPI[kpi]]
  if (session !== null) await this.statProducer.spool(stats, session.connectionId, [new StatEnum(0, 'string')])
}
```

- `kpi`: Enum value (e.g. `STAT_KPI.USER_CONNECTED`) – identifies the stat type.
- `session`: Current session object (required for connection info).

The stats are spooled to the JMS queue and can be consumed downstream.

---

## STAT_KPI Enum Example

```typescript
export enum STAT_KPI {
  USER_CONNECTED,
}
```

You can extend `STAT_KPI` to cover additional statistics/events as needed.

---

## Tips & Best Practices

- Always check if stats are enabled: `process.env.VS_AGENT_STATS_ENABLED === 'true'`.
- Place `sendStats()` calls at the business logic points you want to monitor (connections, key actions, etc).
- The `StatEnum` payload can be extended with meaningful labels/values for your analytics pipeline.

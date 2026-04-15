import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common'
import { getLogLevels } from './config/logger.config'
import { ConfigService } from '@nestjs/config'
import * as fs from 'fs'
import { NestExpressApplication } from '@nestjs/platform-express'

async function bootstrap() {
  // Retrieve log levels based on environment configuration
  const logLevels = getLogLevels()

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logLevels,
  })

  const configService = app.get(ConfigService)
  const logger = new Logger(bootstrap.name)

  app.useBodyParser('json', { limit: '5mb' })

  // Enable URI versioning for API routes
  app.enableVersioning({
    type: VersioningType.URI,
  })

  // Enable Cross-Origin Resource Sharing (CORS)
  app.enableCors()

  app.useGlobalPipes(new ValidationPipe())

  const config = new DocumentBuilder()
    .setTitle('Chatbot IA API')
    .setDescription('API to interact with the AI ​​chatbot')
    .setVersion('1.0')
    .build()
  const document = SwaggerModule.createDocument(app, config)
  SwaggerModule.setup('api', app, document)

  // Get the application port from configuration
  const rawPort = configService.get<string>('appConfig.appPort')
  const PORT = rawPort ? parseInt(rawPort, 10) : 3000

  // Start the application and listen on the specified port
  await app.listen(PORT)

  // Retrieve application name and version from package.json
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { name: string; version: string }
  const appName = packageJson.name
  const appVersion = packageJson.version

  // Log agent-pack info
  const packMeta = configService.get('appConfig.agentPackMeta')
  if (packMeta?.manifestPath) {
    logger.log(`Agent pack loaded: ${packMeta.manifestPath}`)
  } else {
    logger.warn(`No agent pack loaded. Warnings: ${packMeta?.warnings?.join('; ') ?? 'none'}`)
  }
  if (packMeta?.warnings?.length) {
    packMeta.warnings.forEach((w: string) => logger.warn(`Agent pack warning: ${w}`))
  }

  // Log the URL where the application is running
  logger.log(`Application (${appName} v${appVersion}) running on: ${await app.getUrl()} `)
}
void bootstrap()

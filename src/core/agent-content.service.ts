import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DEFAULT_CHATBOT_PROMPT_TEMPLATES } from '../common/prompts/chatbot.prompts'
import { DEFAULT_CHATBOT_WELCOME_TEMPLATES } from '../common/prompts/chatbot.welcome'
import { DEFAULT_TRANSLATIONS } from './common/i18n/i18n'
import { Cmd } from './common'
import type { McpServerDef, AuthFlowConfig } from '../config/agent-pack.loader'

type LanguageBlock = {
  greetingMessage?: string
  systemPrompt?: string
  strings?: Record<string, string>
  [key: string]: unknown
}

@Injectable()
export class AgentContentService {
  constructor(private readonly configService: ConfigService) {}

  private get agentPack() {
    return this.configService.get<Record<string, any>>('appConfig.agentPack') ?? null
  }

  private resolveLanguage(lang?: string): string {
    const normalized = lang?.split('-')[0] ?? ''
    if (normalized && this.getLanguageBlock(normalized)) return normalized

    const packDefault = this.agentPack?.metadata?.defaultLanguage
    if (packDefault && this.getLanguageBlock(packDefault)) return packDefault

    return 'en'
  }

  private getLanguageBlock(lang?: string): LanguageBlock | undefined {
    const packLanguages = this.agentPack?.languages as Record<string, LanguageBlock> | undefined
    if (!packLanguages) return undefined
    if (lang && packLanguages[lang]) return packLanguages[lang]
    const defaultLang = this.agentPack?.metadata?.defaultLanguage
    if (defaultLang && packLanguages[defaultLang]) return packLanguages[defaultLang]
    return packLanguages['en']
  }

  getGreetingMessage(lang?: string, templateKey = 'greetingMessage'): string {
    const langKey = this.resolveLanguage(lang)
    const effectiveTemplateKey = templateKey === 'welcomeMessage' ? 'greetingMessage' : templateKey
    const block = this.getLanguageBlock(langKey)
    if (block) {
      const value = block[effectiveTemplateKey]
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
      if (effectiveTemplateKey !== 'greetingMessage') {
        const fallbackGreeting = block['greetingMessage']
        if (typeof fallbackGreeting === 'string' && fallbackGreeting.trim().length > 0) {
          return fallbackGreeting
        }
      }
      const legacyWelcome = block['welcomeMessage']
      if (typeof legacyWelcome === 'string' && legacyWelcome.trim().length > 0) {
        return legacyWelcome
      }
    }
    const fallback = DEFAULT_CHATBOT_WELCOME_TEMPLATES[langKey] ?? DEFAULT_CHATBOT_WELCOME_TEMPLATES['en']
    return fallback()
  }

  getSystemPrompt(lang?: string): string {
    const langKey = this.resolveLanguage(lang)
    const block = this.getLanguageBlock(langKey)
    if (block?.systemPrompt) return block.systemPrompt
    const packPrompt = this.agentPack?.llm?.agentPrompt
    if (typeof packPrompt === 'string' && packPrompt.trim().length > 0) return packPrompt
    return this.configService.get<string>('appConfig.agentPrompt') ?? ''
  }

  buildPrompt(options: { lang?: string; context: string; question: string; userName?: string }): string {
    const { lang, context, question, userName } = options
    const langKey = this.resolveLanguage(lang)
    const block = this.getLanguageBlock(langKey)
    const basePrompt = this.getSystemPrompt(langKey)
    const userLine = userName ? `Current user name: ${userName}` : ''

    if (!block?.systemPrompt) {
      const template = DEFAULT_CHATBOT_PROMPT_TEMPLATES[langKey] ?? DEFAULT_CHATBOT_PROMPT_TEMPLATES['en']
      return template(context, question, userName)
    }

    return [basePrompt, userLine, 'Context:', context, 'Question:', question].filter(Boolean).join('\n\n')
  }

  getStrings(lang?: string): Record<string, string> {
    const langKey = this.resolveLanguage(lang)
    const block = this.getLanguageBlock(langKey)
    if (block?.strings) return block.strings
    return DEFAULT_TRANSLATIONS[langKey] ?? DEFAULT_TRANSLATIONS['en']
  }

  getString(lang: string, key: string): string {
    const strings = this.getStrings(lang)
    return strings[key] ?? DEFAULT_TRANSLATIONS['en'][key] ?? key
  }

  getDefaultLanguage(): string {
    return this.agentPack?.metadata?.defaultLanguage ?? 'en'
  }

  getMenuItems(): { id: string; labelKey?: string; label?: string; action?: string; visibleWhen?: string; badge?: string }[] {
    const menuItems = this.agentPack?.flows?.menu?.items
    if (Array.isArray(menuItems) && menuItems.length > 0) return menuItems
    return [
      { id: Cmd.AUTHENTICATE, labelKey: 'CREDENTIAL', action: 'authenticate', visibleWhen: 'unauthenticated' },
      { id: Cmd.LOGOUT, labelKey: 'LOGOUT', action: 'logout', visibleWhen: 'authenticated' },
    ]
  }

  getWelcomeFlowConfig() {
    const welcomeConfig = this.agentPack?.flows?.welcome ?? {}
    const templateKey = typeof welcomeConfig.templateKey === 'string' ? welcomeConfig.templateKey : 'greetingMessage'
    return {
      enabled: this.toBoolean(welcomeConfig.enabled, true),
      sendOnProfile: this.toBoolean(welcomeConfig.sendOnProfile, true),
      templateKey: templateKey === 'welcomeMessage' ? 'greetingMessage' : templateKey,
    }
  }

  getAuthFlowConfig(): AuthFlowConfig {
    const authConfig = this.agentPack?.flows?.authentication ?? {}
    const credentialDefinitionId =
      authConfig.credentialDefinitionId ?? this.configService.get('appConfig.credentialDefinitionId')
    const adminAvatars: string[] = this.configService.get('appConfig.adminAvatars') ?? []
    return {
      enabled: this.toBoolean(authConfig.enabled, true),
      required: this.configService.get<boolean>('appConfig.authRequired') ?? false,
      credentialDefinitionId,
      issuerServiceDid: authConfig.issuerServiceDid,
      userIdentityAttribute: this.configService.get<string>('appConfig.userIdentityAttribute') ?? 'name',
      rolesAttribute: this.configService.get<string>('appConfig.rolesAttribute') || undefined,
      defaultRole: this.configService.get<string>('appConfig.defaultRole') ?? 'user',
      adminUsers: this.configService.get<string[]>('appConfig.adminUsers') ?? [],
      adminAvatars,
    }
  }

  getUserControlledServers(): McpServerDef[] {
    const servers = this.configService.get<McpServerDef[]>('appConfig.mcpServers') ?? []
    return servers.filter((s) => s.accessMode === 'user-controlled' && s.userConfig?.fields?.length)
  }

  getUserControlledServer(name: string): McpServerDef | undefined {
    return this.getUserControlledServers().find((s) => s.name === name)
  }

  private toBoolean(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes'].includes(normalized)) return true
      if (['false', '0', 'no'].includes(normalized)) return false
    }
    return fallback
  }
}

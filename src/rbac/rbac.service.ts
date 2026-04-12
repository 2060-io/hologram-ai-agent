import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { McpServerDef, McpToolAccess, McpApprovalPolicy } from '../config/agent-pack.loader'

export type AccessDecision = 'ALLOW' | 'DENY' | 'APPROVAL'

export interface UserContext {
  identity: string
  connectionId: string
  roles: string[]
  isAuthenticated: boolean
}

@Injectable()
export class RbacService {
  private readonly logger = new Logger(RbacService.name)
  private readonly mcpServers: McpServerDef[]
  private readonly adminUsers: string[]
  private readonly rolesAttribute: string
  private readonly defaultRole: string
  private readonly userIdentityAttribute: string
  private readonly authRequired: boolean

  constructor(private readonly config: ConfigService) {
    this.mcpServers = this.config.get<McpServerDef[]>('appConfig.mcpServers') ?? []
    this.adminUsers = this.config.get<string[]>('appConfig.adminUsers') ?? []
    this.rolesAttribute = this.config.get<string>('appConfig.rolesAttribute') ?? ''
    this.defaultRole = this.config.get<string>('appConfig.defaultRole') ?? 'user'
    this.userIdentityAttribute = this.config.get<string>('appConfig.userIdentityAttribute') ?? 'name'
    this.authRequired = this.config.get<boolean>('appConfig.authRequired') ?? false
  }

  /**
   * Whether authentication is required for guest access.
   */
  isAuthRequired(): boolean {
    return this.authRequired
  }

  /**
   * Check if the RBAC system is active (i.e., any server has toolAccess.roles configured).
   * When inactive, falls back to legacy admin/public model.
   */
  isRbacActive(): boolean {
    return this.mcpServers.some((s) => s.toolAccess?.roles && Object.keys(s.toolAccess.roles).length > 0)
  }

  /**
   * Check if a user identity is in the adminUsers bootstrap list.
   */
  isAdminUser(identity: string): boolean {
    if (!identity) return false
    const normalize = (s: string) => s.replace(/^@/, '').toLowerCase()
    return this.adminUsers.some((a) => normalize(a) === normalize(identity))
  }

  /**
   * Extract the user identity attribute name (e.g., 'name', 'email').
   */
  getUserIdentityAttribute(): string {
    return this.userIdentityAttribute
  }

  /**
   * Extract roles from credential attributes.
   * Parses rolesAttribute as single string, comma-separated list, or JSON array.
   * Falls back to defaultRole if rolesAttribute is absent or empty.
   */
  resolveRoles(credentialAttributes: Record<string, string>): string[] {
    if (!this.rolesAttribute) {
      return [this.defaultRole]
    }

    const rawValue = credentialAttributes[this.rolesAttribute]
    if (!rawValue || rawValue.trim().length === 0) {
      return [this.defaultRole]
    }

    const trimmed = rawValue.trim()

    // Try JSON array first
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          const roles = parsed.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
          return roles.length > 0 ? roles : [this.defaultRole]
        }
      } catch {
        // Not valid JSON, fall through to comma-separated
      }
    }

    // Comma-separated
    const roles = trimmed.split(',').map((r) => r.trim()).filter(Boolean)
    return roles.length > 0 ? roles : [this.defaultRole]
  }

  /**
   * Extract the user's unique identity from credential attributes.
   */
  resolveIdentity(credentialAttributes: Record<string, string>): string {
    return credentialAttributes[this.userIdentityAttribute] ?? ''
  }

  /**
   * Determine access for a user+tool combination.
   * Returns ALLOW, DENY, or APPROVAL.
   */
  checkAccess(userRoles: string[], userIdentity: string, serverName: string, toolName: string): AccessDecision {
    // adminUsers bypass all checks
    if (this.isAdminUser(userIdentity)) {
      return 'ALLOW'
    }

    const serverDef = this.mcpServers.find((s) => s.name === serverName)
    if (!serverDef) {
      this.logger.warn(`[RBAC] Server "${serverName}" not found in config`)
      return 'DENY'
    }

    const access = serverDef.toolAccess

    // No toolAccess configured at all → legacy behavior: allow everything
    if (!access) {
      return 'ALLOW'
    }

    // If RBAC roles are configured, use RBAC logic
    if (access.roles && Object.keys(access.roles).length > 0) {
      return this.checkRbacAccess(userRoles, serverDef, toolName)
    }

    // Legacy fallback: public/admin model
    return this.checkLegacyAccess(userRoles, access, toolName)
  }

  /**
   * Check RBAC access with roles and approval policies.
   */
  private checkRbacAccess(userRoles: string[], serverDef: McpServerDef, toolName: string): AccessDecision {
    const access = serverDef.toolAccess!
    const roles = access.roles!
    const defaultAccess = access.default ?? 'none'

    // Collect all tools accessible to the user based on their roles
    const accessibleTools = new Set<string>()
    for (const role of userRoles) {
      const tools = roles[role]
      if (tools) {
        for (const t of tools) accessibleTools.add(t)
      }
    }

    // Check if the tool is in the user's accessible set
    const hasRoleAccess = accessibleTools.has(toolName)

    // If the tool is not explicitly listed for any role, check the default
    if (!hasRoleAccess) {
      // Check if the tool is listed in ANY role (even one the user doesn't have)
      const allRoleTools = new Set<string>()
      for (const tools of Object.values(roles)) {
        for (const t of tools) allRoleTools.add(t)
      }

      if (!allRoleTools.has(toolName)) {
        // Tool is not mentioned in any role → apply default
        if (defaultAccess === 'all') {
          return 'ALLOW'
        }
        return 'DENY'
      }

      // Tool is assigned to other roles but not the user's
      return 'DENY'
    }

    // User has role access → check if approval is required
    const approvalPolicy = this.findApprovalPolicy(access, toolName)
    if (approvalPolicy) {
      return 'APPROVAL'
    }

    return 'ALLOW'
  }

  /**
   * Legacy access model: public/admin with explicit public tool lists.
   */
  private checkLegacyAccess(userRoles: string[], access: McpToolAccess, toolName: string): AccessDecision {
    const defaultMode = access.default ?? 'admin'

    if (defaultMode === 'public') {
      // All tools public unless in adminOnly list
      if (access.adminOnly?.includes(toolName)) {
        return 'DENY'
      }
      return 'ALLOW'
    }

    // default === 'admin': all tools admin-only unless in public list
    if (access.public?.includes(toolName)) {
      return 'ALLOW'
    }

    return 'DENY'
  }

  /**
   * Check if the user holds any approver role for a specific tool's approval policy.
   */
  isApprover(userRoles: string[], serverName: string, toolName: string): boolean {
    const serverDef = this.mcpServers.find((s) => s.name === serverName)
    if (!serverDef?.toolAccess?.approval) return false

    const policy = this.findApprovalPolicy(serverDef.toolAccess, toolName)
    if (!policy) return false

    return userRoles.some((role) => policy.approvers.includes(role))
  }

  /**
   * Get the approval policy for a specific tool on a server, if any.
   */
  getApprovalPolicy(serverName: string, toolName: string): McpApprovalPolicy | undefined {
    const serverDef = this.mcpServers.find((s) => s.name === serverName)
    if (!serverDef?.toolAccess) return undefined
    return this.findApprovalPolicy(serverDef.toolAccess, toolName)
  }

  /**
   * Get all approver roles for a given server+tool.
   */
  getApproverRoles(serverName: string, toolName: string): string[] {
    const policy = this.getApprovalPolicy(serverName, toolName)
    return policy?.approvers ?? []
  }

  /**
   * Get the list of tools accessible to the given roles on a specific server.
   * Used for LLM tool filtering.
   */
  getAccessibleTools(userRoles: string[], userIdentity: string, serverName: string, allToolNames: string[]): string[] {
    return allToolNames.filter((toolName) => {
      const decision = this.checkAccess(userRoles, userIdentity, serverName, toolName)
      return decision !== 'DENY'
    })
  }

  private findApprovalPolicy(access: McpToolAccess, toolName: string): McpApprovalPolicy | undefined {
    if (!access.approval) return undefined
    return access.approval.find((p) => p.tools.includes(toolName))
  }
}

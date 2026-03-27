export interface AgentCommandConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface AgentPreset extends AgentCommandConfig {
  label: string
  description?: string
}

export interface ResolvedAgentConfig extends AgentCommandConfig {
  id?: string
  label?: string
  source: 'preset' | 'raw'
}

export interface RawAcpProtocolConfig {
  type?: 'acp'
  agent?: {
    preset?: string
    command?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    showThoughts?: boolean
  }
  agents?: Record<string, AgentPreset>
}

export interface ResolvedAcpProtocolConfig {
  type: 'acp'
  agents: Record<string, AgentPreset>
  agent: ResolvedAgentConfig & {
    cwd: string
    showThoughts: boolean
  }
}

export type ResolveAcpProtocolConfigOptions = {
  raw?: RawAcpProtocolConfig
  agentSelection?: string
  cwd?: string
  showThoughts?: boolean
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  copilot: {
    label: 'GitHub Copilot',
    command: 'npx',
    args: ['-y', '@github/copilot', '--acp', '--yolo'],
    description: 'GitHub Copilot ACP-compatible mode'
  },
  claude: {
    label: 'Claude Code',
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    description: 'Claude Code ACP'
  },
  gemini: {
    label: 'Gemini CLI',
    command: 'npx',
    args: ['-y', '@google/gemini-cli', '--experimental-acp'],
    description: 'Gemini CLI ACP'
  },
  qwen: {
    label: 'Qwen Code',
    command: 'npx',
    args: ['-y', '@qwen-code/qwen-code', '--acp', '--experimental-skills'],
    description: 'Qwen Code ACP'
  },
  codex: {
    label: 'Codex CLI',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
    description: 'Codex ACP'
  },
  opencode: {
    label: 'OpenCode',
    command: 'npx',
    args: ['-y', 'opencode-ai', 'acp'],
    description: 'OpenCode ACP'
  }
}

export const DEFAULT_ACP_AGENT_PRESET = 'codex'

export function parseAgentCommand(agentSelection: string): AgentCommandConfig {
  const parts = agentSelection.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    throw new Error('Agent command cannot be empty')
  }

  return {
    command: parts[0]!,
    args: parts.slice(1)
  }
}

export function resolveAcpAgentSelection(
  agentSelection: string,
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS
): ResolvedAgentConfig {
  const preset = registry[agentSelection]
  if (preset) {
    return {
      id: agentSelection,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: 'preset'
    }
  }

  const parsed = parseAgentCommand(agentSelection)
  return {
    ...parsed,
    source: 'raw'
  }
}

export function listBuiltInAgents(
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS
): Array<{ id: string; preset: AgentPreset }> {
  return Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, preset]) => ({ id, preset }))
}

export function resolveAcpProtocolConfig(
  options: ResolveAcpProtocolConfigOptions = {}
): ResolvedAcpProtocolConfig {
  const raw = options.raw ?? {}
  const registry = {
    ...BUILT_IN_AGENTS,
    ...(raw.agents ?? {})
  }

  let resolvedAgent: ResolvedAgentConfig | null = null

  if (options.agentSelection) {
    resolvedAgent = resolveAcpAgentSelection(options.agentSelection, registry)
  } else if (raw.agent?.preset) {
    resolvedAgent = resolveAcpAgentSelection(raw.agent.preset, registry)
  } else if (raw.agent?.command) {
    resolvedAgent = {
      command: raw.agent.command,
      args: raw.agent.args ? [...raw.agent.args] : [],
      env: raw.agent.env ? { ...raw.agent.env } : undefined,
      source: 'raw'
    }
  }

  if (!resolvedAgent) {
    resolvedAgent = resolveAcpAgentSelection(DEFAULT_ACP_AGENT_PRESET, registry)
  }

  if (raw.agent?.env && resolvedAgent.source === 'preset') {
    resolvedAgent = {
      ...resolvedAgent,
      env: {
        ...(resolvedAgent.env ?? {}),
        ...raw.agent.env
      }
    }
  }

  return {
    type: 'acp',
    agents: registry,
    agent: {
      ...resolvedAgent,
      cwd: options.cwd ?? raw.agent?.cwd ?? process.cwd(),
      showThoughts: options.showThoughts ?? raw.agent?.showThoughts ?? false
    }
  }
}

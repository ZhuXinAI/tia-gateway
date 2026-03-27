import type { Logger } from '../logging.js'
import type { ResolvedAcpProtocolConfig } from './acp/config.js'
import type { AgentProtocolAdapter } from '../core/types.js'
import { AcpAgentProtocolAdapter } from './acp/adapter.js'

export function createProtocolAdapter(
  config: ResolvedAcpProtocolConfig,
  logger: Logger
): AgentProtocolAdapter {
  switch (config.type) {
    case 'acp':
      return new AcpAgentProtocolAdapter(config, logger.child('acp'))
  }
}

export {
  BUILT_IN_AGENTS,
  DEFAULT_ACP_AGENT_PRESET,
  listBuiltInAgents,
  parseAgentCommand,
  resolveAcpAgentSelection,
  resolveAcpProtocolConfig
} from './acp/config.js'
export type {
  AgentCommandConfig,
  AgentPreset,
  RawAcpProtocolConfig,
  ResolvedAcpProtocolConfig,
  ResolvedAgentConfig
} from './acp/config.js'

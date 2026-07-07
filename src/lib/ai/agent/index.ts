// ============================================================
// clinicOS — agente de Atención (tool-calling). Superficie pública.
// ============================================================

export { runClinicalAgent } from './loop'
export type {
  RunClinicalAgentArgs,
  RunClinicalAgentResult,
} from './loop'
export { buildClinicalSystemPrompt } from './prompt'
export type { ClinicalPromptArgs } from './prompt'
export { CLINICAL_TOOLS } from './tools'
export type { AgentToolContext, ToolDefinition, ToolExecutor, ToolExecResult } from './tools'
export { FUNNEL_PIPELINE_NAME } from './execute'
export {
  clinicTimezone,
  formatSlotLabel,
  instantFromLocalDateTime,
  wallPartsInTz,
} from './clinic-time'

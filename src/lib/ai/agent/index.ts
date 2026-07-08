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
export { buildPatientStateLines, buildReceptionFlowLines } from './state'
export {
  validateClinicalReply,
  buildClinicalFallbackReply,
  buildGuardrailRepairNote,
} from './guardrails'
export type {
  GuardrailVerdict,
  GuardrailBlockCategory,
  ClinicalReplyGuardArgs,
} from './guardrails'
export { analyzeReceiptImage, buildReceiptNote, buildRecentImageNotes } from './vision'
export type { ReceiptAnalysis } from './vision'
export { CLINICAL_TOOLS } from './tools'
export type {
  AgentToolContext,
  ToolDefinition,
  ToolExecutor,
  ToolExecResult,
  ToolTrace,
} from './tools'
export { FUNNEL_PIPELINE_NAME } from './execute'
export {
  clinicTimezone,
  formatSlotLabel,
  instantFromLocalDateTime,
  wallPartsInTz,
} from './clinic-time'

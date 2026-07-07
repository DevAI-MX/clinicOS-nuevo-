// ============================================================
// clinicOS — herramientas del asistente interno (doctor/equipo).
//
// Segundo agente del sistema, separado del recepcionista de WhatsApp:
// vive como chat dentro del dashboard (nunca WhatsApp) y responde
// preguntas del equipo sobre su propia operación. V1 es SOLO LECTURA
// — consulta agenda, anticipos y el embudo, pero nunca confirma pagos
// ni citas (eso lo sigue haciendo el equipo desde el panel ya
// existente). Reusa el mismo loop de tool-calling y el mismo
// `AgentToolContext` que el agente clínico (ver ../agent/tools.ts);
// `contactId`/`conversationId`/`embeddingsApiKey` van vacíos porque
// estas tools no operan sobre un contacto ni usan RAG.
// ============================================================

import type { ToolDefinition } from '../agent'

export const INTERNAL_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'consultar_agenda_dia',
    description:
      'Devuelve las citas agendadas para un día (paciente, hora, tipo, estado y anticipo). Úsala para "qué tengo hoy/mañana", "cuántas citas hay el viernes", etc.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: {
          type: 'string',
          description: 'Fecha en formato YYYY-MM-DD, hora local de la clínica. Omítela para hoy.',
        },
      },
    },
  },
  {
    name: 'consultar_anticipos_pendientes',
    description:
      'Devuelve los anticipos que el equipo aún no ha confirmado en el panel, con paciente, monto, método y fecha del comprobante. Úsala para "qué anticipos faltan por revisar".',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_embudo',
    description:
      'Devuelve un resumen del embudo de IA (Preguntón, Interesado, Seguimiento futuro, Cita apartada, Anticipo en revisión, Agendado, Paciente): cuántos leads y cuánto valor potencial hay en cada etapa.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'buscar_paciente',
    description:
      'Busca un paciente/contacto por nombre o teléfono y devuelve sus datos y sus citas más recientes. Úsala para "qué sabemos de [nombre]", "el paciente del teléfono X".',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre (parcial) o teléfono a buscar.',
        },
      },
      required: ['query'],
    },
  },
] as const

export type InternalToolName = (typeof INTERNAL_TOOLS)[number]['name']

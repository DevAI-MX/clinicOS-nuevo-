// ============================================================
// clinicOS — herramientas del agente de Atención (contact-scoped).
//
// Definiciones en el formato `tools` de la Messages API de Anthropic.
// Cada herramienta opera SIEMPRE dentro de la cuenta y el contacto de
// la conversación (ver `AgentToolContext`) — el ejecutor filtra por
// `account_id`/`contact_id`, así que aunque escribimos con el cliente
// service-role la multi-tenencia queda garantizada en código.
//
// Regla de oro (migración 031 + prompts legacy): la IA solo PREVALIDA.
// Agenda citas en 'pendiente' y registra anticipos en 'pendiente'; un
// humano confirma en el panel. Ninguna herramienta confirma nada.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from '../types'

/** Proveedores capaces de tool-calling para el agente clínico. */
export type AgentProvider = 'anthropic' | 'openai'

/** Contexto de ejecución compartido por todas las herramientas. */
export interface AgentToolContext {
  /** Cliente service-role (el ejecutor impone la tenencia por código). */
  db: SupabaseClient
  accountId: string
  contactId: string
  conversationId: string
  /** Dueño de la cuenta: destinatario de las notificaciones y de las tags. */
  userId: string
  contactName: string | null
  /** Zona IANA de la clínica (para interpretar fechas/horas locales). */
  timezone: string
  /** Reloj inyectado — nunca `new Date()` dentro de las herramientas. */
  now: Date
  /** API key (BYO) para generar embeddings de consulta — la usa
   *  consultar_conocimiento vía retrieveKnowledge. null si la cuenta no
   *  la configuró (la tool responde "sin resultados" en ese caso). */
  embeddingsApiKey: string | null
}

/** Resultado de ejecutar una herramienta. */
export interface ToolExecResult {
  /** Contenido del `tool_result` que vuelve al modelo (JSON serializado). */
  content: string
  /** El modelo debe corregir en vez de tratar el turno como exitoso. */
  isError?: boolean
  /** El agente pasó la conversación a un humano (apagará el auto-reply). */
  escalated?: boolean
}

/** Forma de una definición de tool en el formato Anthropic (el mismo
 *  JSON Schema sirve para OpenAI — loop-openai.ts solo cambia el
 *  envoltorio). */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: unknown
}

/** Despachador de tools: recibe el nombre + input crudo del modelo y el
 *  contexto de ejecución, devuelve el tool_result. */
export type ToolExecutor = (
  name: string,
  input: unknown,
  ctx: AgentToolContext,
) => Promise<ToolExecResult>

/** Entrada al loop del agente (independiente del proveedor). */
export interface RunClinicalAgentArgs {
  provider: AgentProvider
  apiKey: string
  model: string
  systemPrompt: string
  /** Turnos recientes de la conversación (de buildConversationContext). */
  messages: ChatMessage[]
  ctx: AgentToolContext
  /** Catálogo de tools para esta corrida. Default: CLINICAL_TOOLS (el
   *  agente de Atención por WhatsApp). El asistente interno pasa su
   *  propio catálogo (solo-lectura). */
  tools?: readonly ToolDefinition[]
  /** Despachador para `tools`. Default: executeClinicalTool. */
  executeTool?: ToolExecutor
}

/** Salida del loop: mismo contrato { text, handoff } que generateReply. */
export interface RunClinicalAgentResult {
  /** Texto para el paciente (centinela de handoff ya removido). */
  text: string
  /** El modelo pidió handoff por centinela (sin texto útil). */
  handoff: boolean
  /** Se ejecutó escalar_a_humano: el equipo fue notificado (el modo IA no cambia). */
  escalated: boolean
}

/** Estados del embudo (soft) que el modelo puede asignar a un lead. */
export const LEAD_STAGES = [
  'pregunton',
  'interesado',
  'seguimiento_futuro',
  'spam',
] as const

export const APPOINTMENT_TYPES = [
  'valoracion',
  'valoracion_virtual',
  'seguimiento',
  'procedimiento',
  'otro',
] as const

export const PAYMENT_METHODS = [
  'transferencia',
  'efectivo',
  'tarjeta',
  'link',
  'otro',
] as const

/** Categorías del expediente clínico ligero (migración 041). */
export const RECORD_CATEGORIES = [
  'motivo_consulta',
  'sintoma',
  'alergia',
  'medicamento',
  'antecedente',
  'tratamiento_previo',
  'nota',
] as const

/**
 * Catálogo de herramientas en el formato Anthropic. El orden importa
 * poco, pero mantenemos consultar_* antes de las mutaciones para que el
 * modelo lea el patrón "consulta antes de escribir".
 */
export const CLINICAL_TOOLS = [
  {
    name: 'consultar_catalogo',
    description:
      'Devuelve el catálogo VIVO de procedimientos/servicios de la clínica con sus precios (rango), anticipo requerido, duración y notas de venta. ÚSALA SIEMPRE antes de mencionar un precio o servicio — nunca los cites de memoria. Los precios son rangos; el costo exacto se define en la valoración con el doctor.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          description:
            'Filtro opcional por categoría (p. ej. "estetica", "dental", "valoracion"). Omítela para ver todo el catálogo.',
        },
      },
    },
  },
  {
    name: 'consultar_disponibilidad',
    description:
      'Devuelve los próximos huecos LIBRES de la agenda (ya descuenta horario, bloqueos y citas existentes). Úsala antes de proponer una fecha/hora. Ofrécele al paciente máximo dos opciones (una en la mañana y una en la tarde), no toda la lista.',
    input_schema: {
      type: 'object',
      properties: {
        desde: {
          type: 'string',
          description:
            'Fecha (YYYY-MM-DD, hora local de la clínica) desde la cual buscar. Omítela para empezar desde ahora.',
        },
        dias: {
          type: 'integer',
          description: 'Cuántos días hacia adelante explorar (default 7, máx 30).',
        },
        duracion_minutos: {
          type: 'integer',
          description:
            'Duración que necesita la cita. Omítela si pasas procedure_id (se toma la del procedimiento).',
        },
        procedure_id: {
          type: 'string',
          description:
            'ID del procedimiento (del catálogo) para tomar su duración.',
        },
      },
    },
  },
  {
    name: 'consultar_datos_pago',
    description:
      'Devuelve los datos bancarios OFICIALES de la clínica (banco, titular, CLABE/cuenta) para que el paciente pague su anticipo. Úsala DESPUÉS de apartar la cita con agendar_cita, nunca antes. NUNCA dictes datos bancarios de memoria: comparte únicamente lo que devuelva esta herramienta, y si no devuelve cuentas, avisa al equipo en vez de inventarlos.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_mis_citas',
    description:
      'Devuelve las citas del paciente de ESTA conversación (las más recientes primero) con su fecha, estado y estado del anticipo. Úsala cuando pregunte por su cita ("cuándo era mi cita", "sí quedó mi cita", "a qué hora paso") — nunca respondas de memoria. Recuerda: una cita "pendiente de confirmar" NO está confirmada.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'consultar_conocimiento',
    description:
      'Busca en la base de conocimiento de la clínica (políticas, procedimientos detallados, preguntas frecuentes) para dudas que NO cubren el catálogo, la agenda ni los anticipos. Úsala antes de escalar cuando la pregunta suene a algo que la clínica ya debería tener documentado. Si no devuelve nada relevante, no inventes la respuesta: dilo y evalúa escalar.',
    input_schema: {
      type: 'object',
      properties: {
        pregunta: {
          type: 'string',
          description: 'La pregunta o duda del paciente, en sus propias palabras.',
        },
      },
      required: ['pregunta'],
    },
  },
  {
    name: 'consultar_expediente',
    description:
      'Devuelve el expediente clínico ligero del paciente de ESTA conversación: síntomas, alergias, medicamentos, antecedentes y tratamientos que él mismo ha contado antes. Úsala cuando el paciente ya escribió en otras ocasiones, retome su caso ("como le decía", "sigo igual") o antes de orientarlo sobre una molestia. Úsalo como contexto para atender con continuidad — nunca se lo recites textual ni menciones que llevas un registro.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'agendar_cita',
    description:
      'APARTA una cita para el paciente. La cita queda PENDIENTE hasta que el equipo la confirme en el panel — nunca digas que quedó "confirmada" o "agendada en firme". Si el paciente ya tiene una cita pendiente, esta herramienta la REAGENDA (no crea una segunda). Si el procedimiento requiere anticipo, díselo y pídele el comprobante para prevalidarlo.',
    input_schema: {
      type: 'object',
      properties: {
        inicio: {
          type: 'string',
          description:
            'Inicio de la cita. Usa un hueco devuelto por consultar_disponibilidad (ISO 8601), o hora local "YYYY-MM-DDTHH:MM".',
        },
        tipo: {
          type: 'string',
          enum: [...APPOINTMENT_TYPES],
          description: 'Tipo de cita. Default "valoracion".',
        },
        procedure_id: {
          type: 'string',
          description:
            'ID del procedimiento del catálogo (define duración y anticipo).',
        },
        notas: {
          type: 'string',
          description: 'Notas internas para el equipo (motivo, contexto).',
        },
      },
      required: ['inicio'],
    },
  },
  {
    name: 'prevalidar_anticipo',
    description:
      'Registra el anticipo del paciente como PENDIENTE de revisión del equipo y le adjunta automáticamente la última imagen que envió (su comprobante) para que el equipo lo valide manualmente en el panel. NO confirma el pago ni la cita. Úsala EN EL MISMO turno en que el paciente mande la foto de su comprobante (la nota automática del sistema te da los datos extraídos). Tras usarla, dile al paciente exactamente que recibiste su comprobante y quedó EN REVISIÓN del equipo, y que le avisas por aquí en cuanto quede confirmado. Nunca digas "tu pago/cita quedó confirmado". Pide el comprobante (imagen) antes de usarla; una promesa verbal no basta.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'string',
          description:
            'ID de la cita asociada. Omítelo para usar la cita pendiente más próxima del paciente.',
        },
        monto: {
          type: 'number',
          description:
            'Monto del anticipo. Usa el monto detectado en el comprobante si lo hay; omítelo para usar el anticipo requerido por el procedimiento/cita.',
        },
        metodo: {
          type: 'string',
          enum: [...PAYMENT_METHODS],
          description: 'Método de pago declarado. Default "transferencia".',
        },
        concepto: {
          type: 'string',
          description:
            'Concepto, p. ej. "Anticipo valoración". Si el monto del comprobante NO coincide con el anticipo requerido, anota aquí la diferencia para el equipo.',
        },
        comprobante_url: {
          type: 'string',
          description:
            'Normalmente OMÍTELA: la herramienta adjunta sola la última imagen que envió el paciente. Pásala solo si tienes una URL exacta de otro comprobante.',
        },
        referencia: {
          type: 'string',
          description:
            'Folio, clave de rastreo o referencia del comprobante, si se detectó en la imagen.',
        },
      },
    },
  },
  {
    name: 'cancelar_cita',
    description:
      'Cancela la cita del paciente cuando ÉL lo pide de forma explícita. Antes de cancelar en definitiva, ofrécele reagendar (agendar_cita mueve su cita activa a otra fecha); cancela solo si insiste. Al confirmarle la cancelación, aplica la política de anticipos de la clínica tal como está en tu contexto.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'string',
          description:
            'ID de la cita a cancelar. Omítelo para cancelar la cita activa del paciente.',
        },
        motivo: {
          type: 'string',
          description: 'Motivo que dio el paciente (para el equipo).',
        },
      },
    },
  },
  {
    name: 'registrar_dato_clinico',
    description:
      'Guarda en el expediente del paciente UN hecho clínico que él mismo acaba de contar (síntoma, alergia, medicamento, antecedente, tratamiento previo o el motivo de su consulta). Úsala en segundo plano en cuanto lo mencione, sin anunciárselo. Registra SOLO lo que el paciente dijo, en sus palabras — NUNCA guardes diagnósticos, interpretaciones ni conclusiones tuyas: no eres médico. Una llamada por hecho.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
          enum: [...RECORD_CATEGORIES],
          description:
            'motivo_consulta (qué lo trae) · sintoma · alergia · medicamento (qué toma) · antecedente (padecimientos/cirugías previas) · tratamiento_previo (qué ya intentó) · nota (otro dato clínico relevante).',
        },
        dato: {
          type: 'string',
          description:
            'El hecho, corto y en las palabras del paciente. Ej: "le truena la mandíbula al masticar desde hace 2 meses", "alérgico a la penicilina".',
        },
      },
      required: ['categoria', 'dato'],
    },
  },
  {
    name: 'clasificar_lead',
    description:
      'Actualiza el CRM del contacto: su etapa en el embudo y, si los capturaste, su nombre y ciudad. Clasifica en la primera interacción y actualiza cuando avance. El embudo solo AVANZA: no bajes a un lead que ya mostró intención de pago.',
    input_schema: {
      type: 'object',
      properties: {
        etapa: {
          type: 'string',
          enum: [...LEAD_STAGES],
          description:
            'pregunton (solo pregunta precio) · interesado (pide fechas/proceso) · seguimiento_futuro (interesado pero no hoy) · spam.',
        },
        nombre: {
          type: 'string',
          description: 'Nombre completo del paciente, si lo capturaste.',
        },
        ciudad: {
          type: 'string',
          description: 'Ciudad de residencia, si la capturaste.',
        },
        notas: {
          type: 'string',
          description: 'Nota breve de contexto para el CRM.',
        },
      },
      required: ['etapa'],
    },
  },
  {
    name: 'avisar_equipo',
    description:
      'Deja un aviso interno para el equipo médico SIN dejar de atender al paciente. Úsala cuando un paciente (que ya vino o viene) hace una pregunta médica de su caso (dosis, dolor, postoperatorio) que el equipo debe ver, pero tú puedes seguir la conversación con lo general.',
    input_schema: {
      type: 'object',
      properties: {
        nota: {
          type: 'string',
          description: 'Qué debe saber el equipo.',
        },
      },
      required: ['nota'],
    },
  },
  {
    name: 'escalar_a_humano',
    description:
      'Avisa al equipo para que una persona tome la conversación. Úsala cuando un lead pide hablar con el doctor, el tema sale de tu alcance (facturación, legal, reembolsos), hay una queja, o ante cualquier duda que no puedas resolver con las herramientas. Regla: ante la duda, escala. Tras usarla, despídete con una línea breve diciendo que en un momento le contacta el equipo y NO sigas resolviendo ese tema tú.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Motivo de la escalación (para el equipo).',
        },
        urgente: {
          type: 'boolean',
          description:
            'true solo para casos sensibles que no pueden esperar (postoperatorio, problema con un pago, queja seria).',
        },
      },
      required: ['motivo'],
    },
  },
] as const

export type ClinicalToolName = (typeof CLINICAL_TOOLS)[number]['name']

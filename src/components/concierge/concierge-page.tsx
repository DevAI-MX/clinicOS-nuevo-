'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Plus, Sparkles, Volume2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import { SessionList, type SessionSummary } from './session-list';
import { ChatThread } from './chat-thread';
import { Composer, type StagedAttachment, type VoiceState } from './composer';
import { useConciergeChat } from './use-concierge-chat';
import { useRecorder } from './use-recorder';
import { useTts } from './use-tts';

// ============================================================
// Orquestador de /concierge: rail de sesiones (lg+) + chat. La sesión
// activa vive en la URL (?s=) para deep-links y refresh sin pérdida.
// El historial y las sesiones se leen con el cliente RLS del browser;
// los turnos y las confirmaciones van por las rutas API.
//
// Fase 2 — voz y adjuntos:
//   * Adjuntos: se suben a chat-media al elegirse (chips con estado) y
//     el turno manda solo las referencias {url, mime, name}.
//   * Voz: se activa SOLA en dos casos — (1) el turno se dictó con el
//     mic (arranca el MODO CONVERSACIÓN: envía, lee la respuesta y
//     vuelve a escuchar con VAD; Esc o ✕ rompen el ciclo), o (2) el
//     agente navegó de sección con abrir_seccion (la respuesta se lee
//     en voz alta aunque el turno fuera tecleado, para escucharla
//     mientras se ve la pantalla). Los turnos tecleados sin navegación
//     son solo texto.
//   * Switch "Voz" del header: con él encendido, TODAS las respuestas
//     se leen en voz alta (también las de turnos tecleados), sin
//     encadenar el modo conversación. Persiste en localStorage.
//   * Navegación autónoma: un bloque 'navegacion' en vivo hace
//     router.push — el agente puede llevar al usuario a la sección.
// ============================================================

const MAX_ATTACHMENTS = 3;
const ACCEPTED_ATTACHMENT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
/** Silencio sostenido que cierra un turno de voz en modo conversación. */
const VOICE_SILENCE_STOP_MS = 2000;
/** localStorage: switch "leer todas las respuestas en voz alta". */
const VOICE_REPLIES_KEY = 'concierge:voz-respuestas';

let attachmentSeq = 0;

export function ConciergePage() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile } = useAuth();

  const activeId = searchParams.get('s');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [input, setInput] = useState('');
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  // Switch "Voz": leer TODAS las respuestas en voz alta. Se hidrata en
  // un efecto (no en el initializer) para no divergir del SSR.
  const [voiceReplies, setVoiceReplies] = useState(false);
  useEffect(() => {
    try {
      setVoiceReplies(localStorage.getItem(VOICE_REPLIES_KEY) === '1');
    } catch {
      // sin localStorage (modo privado estricto) el switch arranca apagado
    }
  }, []);

  const recorder = useRecorder();
  const tts = useTts();
  const chat = useConciergeChat({
    onNavigate: (href) => router.push(href),
  });
  // Extraídas del hook para poder listarlas como deps sin arrastrar el
  // objeto entero (su identidad cambia en cada render).
  const { loadSession, reset, send } = chat;

  const toggleVoiceReplies = (on: boolean) => {
    setVoiceReplies(on);
    try {
      localStorage.setItem(VOICE_REPLIES_KEY, on ? '1' : '0');
    } catch {
      // sin persistencia el switch vive solo esta sesión
    }
    if (!on) tts.stop(); // apagarlo silencia lo que esté sonando
  };

  // Refs para los closures del ciclo de voz (TTS onEnd → re-escuchar):
  // siempre leen el valor vigente, no el del render que los creó.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /** true mientras la conversación por voz está encadenada. */
  const voiceLoopRef = useRef(false);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // setSessions vive dentro del callback de la promesa (no síncrono en
  // el cuerpo del efecto) — mismo criterio que /pipelines.
  const refreshSessions = useCallback(
    () =>
      supabase
        .from('assistant_sessions')
        .select('id, title, last_message_at')
        .order('last_message_at', { ascending: false })
        .limit(100)
        .then(({ data }) => setSessions((data as SessionSummary[]) ?? [])),
    [supabase],
  );

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (activeId) void loadSession(activeId);
    else reset();
  }, [activeId, loadSession, reset]);

  const selectSession = (id: string | null) => {
    router.replace(id ? `/concierge?s=${id}` : '/concierge');
  };

  // ------------------------------------------------------------
  // Adjuntos
  // ------------------------------------------------------------

  const addFiles = (files: File[]) => {
    const room = MAX_ATTACHMENTS - staged.length;
    if (files.length > room) {
      toast.error(`Máximo ${MAX_ATTACHMENTS} adjuntos por mensaje.`);
    }
    for (const file of files.slice(0, Math.max(0, room))) {
      if (!ACCEPTED_ATTACHMENT_MIMES.has(file.type)) {
        toast.error(`"${file.name}": solo imágenes (JPG, PNG, WebP) o PDF.`);
        continue;
      }
      const maxBytes = file.type.startsWith('image/')
        ? MEDIA_MAX_BYTES_BY_KIND.image
        : MEDIA_MAX_BYTES_BY_KIND.document;
      if (file.size > maxBytes) {
        toast.error(
          `"${file.name}" pesa demasiado (máx ${Math.round(maxBytes / 1024 / 1024)} MB).`,
        );
        continue;
      }
      const id = `staged-${++attachmentSeq}`;
      setStaged((prev) => [
        ...prev,
        { id, name: file.name, mime: file.type, uploading: true },
      ]);
      uploadAccountMedia('chat-media', file)
        .then(({ publicUrl, path }) => {
          setStaged((prev) =>
            prev.map((a) =>
              a.id === id ? { ...a, url: publicUrl, path, uploading: false } : a,
            ),
          );
        })
        .catch((err: Error) => {
          toast.error(`No pude subir "${file.name}": ${err.message}`);
          setStaged((prev) => prev.filter((a) => a.id !== id));
        });
    }
  };

  const removeAttachment = (id: string) => {
    const att = staged.find((a) => a.id === id);
    setStaged((prev) => prev.filter((a) => a.id !== id));
    // GC best-effort del objeto ya subido (quedó huérfano).
    if (att?.path) void deleteAccountMedia('chat-media', att.path).catch(() => {});
  };

  // ------------------------------------------------------------
  // Turnos
  // ------------------------------------------------------------

  const handleSend = async (textOverride?: string, opts: { via?: 'voz' } = {}) => {
    const text = (textOverride ?? input).trim();
    const ready = staged.filter((a) => a.url);
    if ((!text && ready.length === 0) || sendingRef.current) return;
    if (staged.some((a) => a.uploading)) {
      toast.error('Espera a que terminen de subir los adjuntos.');
      return;
    }
    // Un turno tecleado rompe el ciclo de conversación por voz.
    if (!opts.via) voiceLoopRef.current = false;

    const prevStaged = staged;
    setInput('');
    setStaged([]);
    sendingRef.current = true;

    const attachments = ready.map((a) => ({ url: a.url!, mime: a.mime, name: a.name }));
    let result;
    try {
      result = await send(activeIdRef.current, text, {
        attachments: attachments.length > 0 ? attachments : undefined,
        via: opts.via,
      });
    } finally {
      sendingRef.current = false;
    }
    const { sessionId, error, reply } = result;

    if (error === 'ai_not_configured') {
      toast.error('Configura tu agente primero (proveedor y API key).', {
        action: { label: 'Ir a Setup', onClick: () => router.push('/agents') },
      });
      setInput(text);
      setStaged(prevStaged);
      voiceLoopRef.current = false;
      return;
    }
    if (error) {
      toast.error(error);
      voiceLoopRef.current = false;
      return;
    }
    if (sessionId && sessionId !== activeIdRef.current) {
      router.replace(`/concierge?s=${sessionId}`);
    }
    void refreshSessions();

    // Voz de respuesta: turnos dictados por voz, navegación de sección
    // (se escucha mientras se ve la pantalla), o el switch "Voz" del
    // header encendido (todas las respuestas habladas).
    if (reply && (opts.via === 'voz' || result.navigated || voiceReplies)) {
      tts.speak(reply.id, reply.text, {
        onEnd: () => {
          // Modo conversación: al terminar de hablar, vuelve a escuchar.
          if (voiceLoopRef.current && mountedRef.current && !sendingRef.current) {
            void startListening();
          }
        },
      });
    }
  };

  // ------------------------------------------------------------
  // Voz (dictado + modo conversación)
  // ------------------------------------------------------------

  const startListening = async () => {
    if (sendingRef.current || voiceState === 'recording') return;
    tts.stop(); // barge-in: grabar silencia la voz
    const ok = await recorder.start({
      onAutoStop: () => void acceptRecording(),
      // VAD: silencio sostenido cierra el turno (también se puede con ✓).
      silenceStopMs: VOICE_SILENCE_STOP_MS,
    });
    if (!ok) {
      toast.error('No pude acceder al micrófono. Revisa el permiso del navegador.');
      voiceLoopRef.current = false;
      return;
    }
    setVoiceState('recording');
  };

  const handleMicStart = () => {
    // Dictar = activar el modo voz: el turno se envía solo y la
    // conversación se encadena (respuesta hablada → volver a escuchar).
    voiceLoopRef.current = true;
    void startListening();
  };

  const cancelRecording = () => {
    voiceLoopRef.current = false;
    recorder.cancel();
    setVoiceState('idle');
  };

  const acceptRecording = async () => {
    const blob = await recorder.stop();
    if (!mountedRef.current) return;
    if (!blob) {
      setVoiceState('idle');
      voiceLoopRef.current = false;
      return;
    }
    setVoiceState('transcribing');
    try {
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      const form = new FormData();
      form.append('audio', new File([blob], `dictado.${ext}`, { type: blob.type }));
      const res = await fetch('/api/ai/concierge/transcribe', {
        method: 'POST',
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      setVoiceState('idle');

      if (!res.ok) {
        voiceLoopRef.current = false;
        if (data.code === 'voice_unavailable') {
          toast.error(
            'El dictado necesita una key de OpenAI (la del agente o la de embeddings).',
          );
        } else if (data.code === 'voice_empty') {
          toast('No escuché nada. Intenta de nuevo.');
        } else {
          toast.error(data.error ?? 'No pude transcribir el audio.');
        }
        return;
      }

      const text = String(data.text ?? '').trim();
      if (!text) {
        voiceLoopRef.current = false;
        return;
      }
      if (voiceLoopRef.current) {
        await handleSend(text, { via: 'voz' });
      } else {
        // Dictado suelto: a revisión en el composer.
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      }
    } catch {
      if (!mountedRef.current) return;
      setVoiceState('idle');
      voiceLoopRef.current = false;
      toast.error('No pude transcribir el audio.');
    }
  };

  const handlePlayToggle = (id: string, text: string) => {
    if (tts.playingId === id) {
      tts.stop();
      return;
    }
    voiceLoopRef.current = false; // reproducción manual, sin ciclo
    tts.speak(id, text);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('¿Eliminar esta conversación? Se borra también su historial.')) {
      return;
    }
    const { error } = await supabase.from('assistant_sessions').delete().eq('id', id);
    if (error) {
      toast.error('No pude eliminar la conversación.');
      return;
    }
    if (activeId === id) selectSession(null);
    void refreshSessions();
  };

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] overflow-hidden sm:-m-6">
      {/* Rail de sesiones — solo lg+ (en móvil manda el chat). */}
      <div className="hidden lg:block">
        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => selectSession(id)}
          onNew={() => selectSession(null)}
          onDelete={handleDelete}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Header del chat (móvil: acceso a nueva conversación). */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-medium text-foreground">
              {activeId
                ? (sessions.find((s) => s.id === activeId)?.title ?? 'Concierge')
                : 'Nueva conversación'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <label
              className="mr-2 flex cursor-pointer items-center gap-1.5"
              title="Leer todas las respuestas en voz alta"
            >
              <Volume2
                className={`h-3.5 w-3.5 ${voiceReplies ? 'text-primary' : 'text-muted-foreground'}`}
              />
              <span className="hidden text-xs text-muted-foreground sm:inline">
                Voz
              </span>
              <Switch checked={voiceReplies} onCheckedChange={toggleVoiceReplies} />
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => selectSession(null)}
              className="lg:hidden"
            >
              <Plus className="mr-1 h-4 w-4" /> Nueva
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden text-muted-foreground sm:inline-flex"
              render={<Link href="/agents" />}
            >
              Configurar agente
            </Button>
          </div>
        </div>

        <ChatThread
          messages={chat.messages}
          actions={chat.actions}
          sending={chat.sending}
          statusLabel={chat.statusLabel}
          loadingHistory={chat.loadingHistory}
          userName={profile?.full_name ?? null}
          playingId={tts.playingId}
          onSuggestion={(s) => void handleSend(s)}
          onConfirmAction={chat.confirmAction}
          onCancelAction={chat.cancelAction}
          onPlayToggle={handlePlayToggle}
        />

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void handleSend()}
          sending={chat.sending}
          attachments={staged}
          onAddFiles={addFiles}
          onRemoveAttachment={removeAttachment}
          voiceState={voiceState}
          voiceSupported={recorder.supported}
          recordSeconds={recorder.seconds}
          recordLevel={recorder.level}
          onMicStart={handleMicStart}
          onMicCancel={cancelRecording}
          onMicAccept={() => void acceptRecording()}
        />
      </div>
    </div>
  );
}

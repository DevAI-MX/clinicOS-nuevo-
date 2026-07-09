# clinicOS — imagen de producción para el VPS (Dokploy la construye desde
# este repo). Multi-stage: deps → build → runtime standalone (~200MB).
#
# Los NEXT_PUBLIC_* se hornean en el bundle del navegador en build-time,
# por eso llegan como build args (Dokploy: Environment → Build-time).
# El resto de secretos (SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, etc.)
# son runtime-only y NO deben pasarse como build args.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    # lib/whatsapp/* lee estas en module-load durante `next build`
    # (recolección de datos de páginas). Placeholders solo de build;
    # en runtime las reemplazan las env vars reales del contenedor.
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    META_APP_SECRET=build-placeholder \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs

EXPOSE 3000
CMD ["node", "server.js"]

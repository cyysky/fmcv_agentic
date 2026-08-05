# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# NEXT_PUBLIC_* vars are inlined at build time — server-host-reachable API URL.
# Default to the deployment host's LAN IP so the SPA works from any client
# browser (localhost inside the container/build points at the wrong machine).
ARG NEXT_PUBLIC_API_URL=http://10.0.151.7:5555/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3333

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3333

CMD ["npm", "run", "start"]

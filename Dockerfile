# ── Stage 1: Install dependencies ───────────────────────────────────────────
FROM --platform=linux/amd64 node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# npm ci = clean, reproducible install (never uses cached node_modules)
RUN npm ci --only=production

# ── Stage 2: Production image ────────────────────────────────────────────────
FROM --platform=linux/amd64 node:20-alpine AS runner
WORKDIR /app

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy only what's needed
COPY --from=deps /app/node_modules ./node_modules
COPY server.js .

# Switch to non-root user
USER appuser

EXPOSE 8080

# Healthcheck — DigitalOcean / Docker can auto-restart if this fails
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["node", "server.js"]

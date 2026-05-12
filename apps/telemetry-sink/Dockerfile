# syntax=docker/dockerfile:1.6

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY sql ./sql

# Drop privileges. tsx loads from /app; node owns /app via the COPY layers.
USER node

EXPOSE 8787
ENV PORT=8787

# tsx so we can ship the TS sources without a build step. Swap for
# `node dist/server.js` after a `npm run build` pass if you'd rather
# ship compiled JS.
CMD ["npx", "tsx", "src/server.ts"]

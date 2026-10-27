# Build Stage
# Node 18/20 are end-of-life and will not receive the October 2026 security
# patches (eMudhra cert compromise + Brotli RCE CVE-2026-111497) - only the
# 22.x/24.x/26.x lines do. Pinned to 22-alpine (patched >=22.23.4) rather
# than a floating "node:18-alpine" tag so the image can't silently drift
# back onto an unpatched/EOL build.
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

# Production Stage
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY --from=builder /app/dist ./dist


EXPOSE 8100

CMD ["node", "dist/index.js"]

# Same reasoning as Guard's own Dockerfile (this project's sibling
# product): node:sqlite needs Node 22+, pinned to the 22.x line rather
# than a floating tag.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# data/ and logs/ are Compass's OWN database/logs - never the same volume
# as Guard's data/ (see server/guardDb.js). A Guard data volume gets
# mounted separately, read-only, at whatever path GUARD_DB_PATH points to.
RUN mkdir -p data logs && \
    addgroup --system compass && adduser --system --ingroup compass compass && \
    chown -R compass:compass /app

USER compass

ENV PORT=4100
ENV COMPASS_HOST=0.0.0.0
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4100/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]

# LifeLink 2 – Container-Image
# Baut Server und Weboberfläche, liefert nur Laufzeitdateien aus. Daten liegen in /data (Volume).

FROM node:26-trixie-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:26-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund

FROM node:26-trixie-slim
# pg_dump in passender Hauptversion (PostgreSQL 18) für die Sicherungen, tini als Init-Prozess
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LIFELINK_DATA_DIR=/data \
    HOME=/data/home \
    npm_config_cache=/data/npm-cache \
    npm_config_update_notifier=false \
    PORT=7310 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/package.json /src/package-lock.json /src/VERSION /src/MIN_IMAGE_VERSION ./
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/update-signing-key.pub ./server/update-signing-key.pub
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/migrations ./server/migrations
COPY --from=build /src/web/package.json ./web/package.json
COPY --from=build /src/web/dist ./web/dist
COPY --from=build /src/wordpress-plugin/lifelink ./wordpress-plugin/lifelink

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7310

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7310)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/main.js"]

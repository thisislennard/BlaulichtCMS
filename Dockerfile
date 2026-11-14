# LifeLink – ein Image, ein Container: Webanwendung, Bediener-PWA, Worker und PostgreSQL.
# Daten (Datenbank, Medien, Schlüssel) liegen ausschließlich im Volume /data.
#
# Der Build braucht nur Docker Hub und die npm-Registry: Laufzeitbasis ist das offizielle
# PostgreSQL-Image, Node.js kommt aus dem offiziellen Node-Image, ffmpeg/ffprobe als statische Programme.
#
# Hinter einem TLS-prüfenden Proxy die Proxy-CA als Build-Geheimnis übergeben (landet nicht im Image):
#   docker build --secret id=build_ca,src=/pfad/zur/proxy-ca.pem --build-arg HTTPS_PROXY=http://proxy:3128 .

ARG NODE_IMAGE=node:26-trixie-slim
ARG PG_IMAGE=postgres:18-trixie
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1.1

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --workspace server --no-audit --no-fund

FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM ${NODE_IMAGE} AS node
# Laufzeitbibliotheken von Node.js, die im PostgreSQL-Image fehlen
RUN mkdir -p /out && cp -a /usr/lib/*-linux-gnu/libatomic.so.1* /out/

FROM ${PG_IMAGE}
# Eigener, unprivilegierter Benutzer für alle Prozesse (auch PostgreSQL)
RUN groupadd --gid 1000 lifelink && useradd --uid 1000 --gid 1000 --home-dir /data/home --no-create-home --shell /usr/sbin/nologin lifelink
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /out/ /usr/local/lib/
RUN ldconfig && node --version
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

ENV NODE_ENV=production \
    LIFELINK_DATA_DIR=/data \
    LIFELINK_EMBEDDED_DB=true \
    LIFELINK_PG_BIN=/usr/lib/postgresql/18/bin \
    LIFELINK_PG_SOCKET_DIR=/tmp/lifelink-pg \
    HOME=/data/home \
    PORT=7310 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/package.json /src/package-lock.json /src/VERSION ./
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/migrations ./server/migrations
COPY --from=build /src/web/package.json ./web/package.json
COPY --from=build /src/web/dist ./web/dist
COPY --from=build /src/wordpress-plugin/lifelink-bridge ./wordpress-plugin/lifelink-bridge

RUN mkdir -p /data && chown -R lifelink:lifelink /data
USER lifelink
VOLUME ["/data"]
EXPOSE 7310

# Gesund = LifeLink kann Aufträge annehmen (Datenbank, Schema, Worker, Speicher)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7310)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
# Supervisor: PostgreSQL → API → Worker; Stopp in umgekehrter Reihenfolge
ENTRYPOINT ["node", "server/dist/main.js"]

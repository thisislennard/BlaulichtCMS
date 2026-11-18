# BlaulichtCMS – ein Image, ein Container: Webanwendung, Bediener-PWA, Worker und PostgreSQL.
# Daten (Datenbank, Medien, Schlüssel) liegen ausschließlich im Volume /data.
#
# Der Build braucht nur Docker Hub und die npm-Registry: Laufzeitbasis ist das offizielle
# PostgreSQL-Image, Node.js kommt aus dem offiziellen Node-Image, ffmpeg/ffprobe als statische Programme.
#
# Hinter einem TLS-prüfenden Proxy die Proxy-CA als Build-Geheimnis übergeben (landet nicht im Image):
#   docker build --secret id=build_ca,src=/pfad/zur/proxy-ca.pem --build-arg HTTPS_PROXY=http://proxy:3128 .
#
# Basis-Images sind per Digest fixiert (#104): Ein nachträglich neu belegter Tag ändert das Image nicht. Die wöchentliche
# Versionsprüfung (scripts/check-versions.mjs, .github/workflows/versions.yml) meldet neue Tags und Digests im Issue
# „Neue Versionen verfügbar“; übernommen werden sie von Hand (Tag und Digest). install.sh baut mit --pull.
# ffmpeg/ffprobe stammen aus mwader/static-ffmpeg (statisch gebaut aus den offiziellen Quellen, Build-Skript und
# Prüfsummen der Quellen öffentlich: https://github.com/wader/static-ffmpeg). Herkunft und Restrisiko: docs/betrieb.md.

FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /src
# Gesichtssuche (#214): onnxruntime-node soll keine GPU-Bibliotheken (CUDA/TensorRT) von NuGet nachladen –
# gebraucht wird nur die im npm-Paket enthaltene CPU-Fassung
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# npm-Zwischenspeicher als Build-Cache: das große onnxruntime-Paket wird je Build nur einmal geladen (Prüfsummen aus dem Lock)
RUN --mount=type=secret,id=build_ca,required=false --mount=type=cache,target=/root/.npm,sharing=locked \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
# Rechte unabhängig vom Host (#275): Ein mit umask 077 ausgecheckter Stand hat Dateien mit 0600 und Ordner mit 0700.
# COPY übernimmt diese Rechte, die Laufzeitstufe ebenso (COPY --from) – der unprivilegierte Benutzer könnte dann z. B.
# server/package.json nicht lesen. Hier einheitlich 0644/0755 (ausführbare Dateien behalten ihr x-Bit).
RUN find . -path ./node_modules -prune -o -path './*/node_modules' -prune -o -exec chmod u+rwX,go+rX,go-w {} +
RUN npm run build

FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS deps
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# onnxruntime-node bringt Bibliotheken für alle Plattformen mit (Windows mit DirectML, macOS, Linux x64/arm64: ~290 MB).
# Behalten wird nur die Linux-CPU-Bibliothek der eigenen Architektur (x64 ~48 MB, arm64 ~26 MB); fehlt sie, bricht
# der Build ab. Sie braucht nur glibc, libstdc++ und libgcc_s – beides ist im PostgreSQL-Image (auch Node.js nutzt sie).
RUN --mount=type=secret,id=build_ca,required=false --mount=type=cache,target=/root/.npm,sharing=locked \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --workspace server --no-audit --no-fund && \
    ort=node_modules/onnxruntime-node/bin/napi-v6 && arch="$(node -p process.arch)" && \
    test -f "$ort/linux/$arch/libonnxruntime.so.1" && test -f "$ort/linux/$arch/onnxruntime_binding.node" && \
    mv "$ort/linux/$arch" /tmp/ort-keep && rm -rf "$ort" && mkdir -p "$ort/linux" && mv /tmp/ort-keep "$ort/linux/$arch" && \
    du -sh node_modules/onnxruntime-node

FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

FROM node:26-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS node
# Laufzeitbibliotheken von Node.js, die im PostgreSQL-Image fehlen
RUN mkdir -p /out && cp -a /usr/lib/*-linux-gnu/libatomic.so.1* /out/

FROM postgres:18-trixie@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc
# Eigener, unprivilegierter Benutzer für alle Prozesse (auch PostgreSQL)
# gosu (für den Entrypoint des PostgreSQL-Images) wird nicht gebraucht und ist mit einer älteren Go-Version gebaut
# (kritischer Befund im Imagescan, #105) – entfernen statt mitliefern
RUN rm -f /usr/local/bin/gosu && groupadd --gid 1000 blaulichtcms && useradd --uid 1000 --gid 1000 --home-dir /data/home --no-create-home --shell /usr/sbin/nologin blaulichtcms
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /out/ /usr/local/lib/
RUN ldconfig && node --version
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

ENV NODE_ENV=production \
    BLAULICHTCMS_DATA_DIR=/data \
    BLAULICHTCMS_EMBEDDED_DB=true \
    BLAULICHTCMS_PG_BIN=/usr/lib/postgresql/18/bin \
    BLAULICHTCMS_PG_SOCKET_DIR=/tmp/blaulichtcms-pg \
    HOME=/data/home \
    PORT=7310 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/package.json /src/package-lock.json /src/VERSION ./
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/server/migrations ./server/migrations
# Angehefteter öffentlicher Schlüssel für In-App-Updates (Signaturprüfung, updates/signing.ts)
COPY --from=build /src/server/update-signing-key.pub ./server/update-signing-key.pub
COPY --from=build /src/web/package.json ./web/package.json
COPY --from=build /src/web/dist ./web/dist
COPY --from=build /src/wordpress-plugin/blaulichtcms-bridge ./wordpress-plugin/blaulichtcms-bridge

RUN mkdir -p /data && chown -R blaulichtcms:blaulichtcms /data
USER blaulichtcms
# Alles unter /app muss für den Laufzeitbenutzer lesbar sein (#275) – sonst bricht der Build hier ab statt erst der Start
RUN bad="$(find /app ! -type l \( ! -readable -o -type d ! -executable \) -print 2>&1 | head -n 20)"; \
    if [ -n "$bad" ]; then echo "Für $(id -un) nicht lesbar:" >&2; echo "$bad" >&2; exit 1; fi
VOLUME ["/data"]
EXPOSE 7310

# Gesund = BlaulichtCMS kann Aufträge annehmen (Datenbank, Schema, Worker, Speicher)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7310)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
# Supervisor: PostgreSQL → API → Worker; Stopp in umgekehrter Reihenfolge
ENTRYPOINT ["node", "server/dist/main.js"]

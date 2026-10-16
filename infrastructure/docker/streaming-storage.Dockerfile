# Build the OSS releases from source; no proprietary storage distribution is required.
FROM golang:1.25-alpine AS minio-build
RUN apk add --no-cache git
RUN git clone --depth 1 --branch RELEASE.2025-10-15T17-29-55Z https://github.com/minio/minio.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -o /minio .

FROM golang:1.25-alpine AS mc-build
RUN apk add --no-cache git
RUN git clone --depth 1 --branch RELEASE.2025-04-16T18-13-26Z https://github.com/minio/mc.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -o /mc .

FROM alpine:3.22 AS storage-init
RUN apk add --no-cache ca-certificates
COPY --from=mc-build /mc /usr/local/bin/mc
COPY --from=mc-build /src/LICENSE /usr/share/licenses/mc/LICENSE
COPY infrastructure/streaming/init-storage.sh /init-storage.sh
ENTRYPOINT ["/bin/sh", "/init-storage.sh"]

FROM alpine:3.22 AS runner
RUN apk add --no-cache ca-certificates && adduser -D -u 1000 storage && mkdir /data && chown storage /data
COPY --from=minio-build /minio /usr/local/bin/minio
COPY --from=minio-build /src/LICENSE /usr/share/licenses/minio/LICENSE
USER storage
EXPOSE 9000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s CMD wget -q --spider http://127.0.0.1:9000/minio/health/live
ENTRYPOINT ["minio"]
CMD ["server", "/data"]

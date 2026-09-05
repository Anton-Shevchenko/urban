# Build context is the repository root: hex-svc depends on the shared
# urban/gen and urban/pkg modules via replace directives.
FROM golang:1.25-alpine AS build
WORKDIR /src

# Manifests first so dependency download is cached across source edits.
COPY gen/go.mod gen/go.sum ./gen/
COPY pkg/go.mod pkg/go.sum ./pkg/
COPY microservices/hex/go.mod microservices/hex/go.sum ./microservices/hex/
WORKDIR /src/microservices/hex
RUN go mod download

WORKDIR /src
COPY gen ./gen
COPY pkg ./pkg
COPY microservices/hex ./microservices/hex
WORKDIR /src/microservices/hex
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/svc ./cmd/hex-svc

FROM alpine:3.21
ARG TARGETARCH
RUN apk add --no-cache ca-certificates wget \
    && ARCH="${TARGETARCH}" \
    && if [ -z "$ARCH" ]; then \
         case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac; \
       fi \
    && wget -qO /usr/local/bin/grpc_health_probe \
      "https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/v0.4.37/grpc_health_probe-linux-${ARCH}" \
    && chmod +x /usr/local/bin/grpc_health_probe
COPY --from=build /out/svc /usr/local/bin/svc
USER nobody
ENTRYPOINT ["/usr/local/bin/svc"]

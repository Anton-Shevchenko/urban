# Build context is the repository root: gateway depends on the shared
# urban/gen and urban/pkg modules via replace directives.
FROM golang:1.25-alpine AS build
WORKDIR /src

# Manifests first so dependency download is cached across source edits.
COPY gen/go.mod gen/go.sum ./gen/
COPY pkg/go.mod pkg/go.sum ./pkg/
COPY gateway/go.mod gateway/go.sum ./gateway/
WORKDIR /src/gateway
RUN go mod download

WORKDIR /src
COPY gen ./gen
COPY pkg ./pkg
COPY gateway ./gateway
WORKDIR /src/gateway
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/svc ./cmd/gateway

FROM alpine:3.21
RUN apk add --no-cache ca-certificates wget
COPY --from=build /out/svc /usr/local/bin/svc
USER nobody
ENTRYPOINT ["/usr/local/bin/svc"]

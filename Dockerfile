# syntax=docker/dockerfile:1
# Builds the nicon-relay binary and runs it. No CGO (all dependencies are
# pure Go), so the build is a static binary and the runtime image stays
# tiny. See README.md's "Running the relay in Docker" section.
#
# The two --mount=type=cache lines persist Go's module-download cache and
# build cache on the host across builds (BuildKit-only, hence the syntax
# directive above — needs Docker with BuildKit enabled, the default on any
# reasonably current Docker Engine). Without them, every RUN step starts
# from an empty filesystem outside its own layer, so `go build` recompiles
# every dependency (gorilla/websocket, the MySQL driver, x/crypto, ...)
# from scratch on every single rebuild — the actual reason a rebuild here
# has been taking ~2 minutes regardless of how little source changed.

# Base images are pinned by digest (Dependabot proposes updates); the tag is
# kept for readability.
FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /nicon-relay .

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
RUN apk add --no-cache ca-certificates \
    && addgroup -S nicon && adduser -S -G nicon -H -D nicon
COPY --from=build /nicon-relay /nicon-relay
USER nicon
EXPOSE 8765
ENTRYPOINT ["/nicon-relay"]
CMD ["-addr", "0.0.0.0:8765"]

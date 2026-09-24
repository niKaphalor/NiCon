# Builds the nicon-relay binary and runs it. No CGO (all dependencies are
# pure Go), so the build is a static binary and the runtime image stays
# tiny. See README.md's "Running the relay in Docker" section.

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /nicon-relay .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates \
    && addgroup -S nicon && adduser -S -G nicon -H -D nicon
COPY --from=build /nicon-relay /nicon-relay
USER nicon
EXPOSE 8765
ENTRYPOINT ["/nicon-relay"]
CMD ["-addr", "0.0.0.0:8765"]

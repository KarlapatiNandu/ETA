# k6 with Server-Sent Events (BUILD_PLAN Stage 8). Stock k6 cannot hold an SSE stream open;
# xk6-sse adds `k6/x/sse`. Built in a container so nobody needs Go installed:
#   docker build -t busmitra-k6 tests/load
FROM grafana/xk6:1.3.5 AS build
RUN xk6 build v1.5.0 --with github.com/phymbert/xk6-sse@v0.1.11 --output /tmp/k6

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /tmp/k6 /usr/bin/k6
ENTRYPOINT ["k6"]

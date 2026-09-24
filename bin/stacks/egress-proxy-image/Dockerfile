# Forward proxy that lets the backend uniswapx service send market-maker webhook calls out
# through this account's NAT gateway, so market makers keep seeing the Elastic IP they
# allowlist. See bin/stacks/egress-proxy.ts.
# Base image pinned by digest (alpine 3.20 index) and squid by package version, so rebuilds
# are reproducible; bump both deliberately.
FROM public.ecr.aws/docker/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache squid=6.9-r0
COPY squid.conf /etc/squid/squid.conf
# Run unprivileged. Squid needs no root here: port 3128 is unprivileged, there is no cache
# directory or pid file, and logs go to stdout/stderr.
USER squid
EXPOSE 3128
# -N: stay in the foreground so ECS supervises the process directly.
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]

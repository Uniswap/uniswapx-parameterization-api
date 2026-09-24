# Forward proxy that lets the backend uniswapx service send market-maker webhook calls out
# through this account's NAT gateway, so market makers keep seeing the Elastic IP they
# allowlist. See bin/stacks/egress-proxy.ts.
FROM public.ecr.aws/docker/library/alpine:3.20
RUN apk add --no-cache squid
COPY squid.conf /etc/squid/squid.conf
COPY --chmod=755 entrypoint.sh /entrypoint.sh
EXPOSE 3128
ENTRYPOINT ["/entrypoint.sh"]

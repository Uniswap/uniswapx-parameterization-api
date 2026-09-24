#!/bin/sh
set -e
# squid drops privileges to the `squid` user and then reopens /dev/stdout and /dev/stderr for
# its logs. Hand those pipes to that user first, or squid exits at startup.
chown squid /proc/self/fd/1 /proc/self/fd/2
# -N: stay in the foreground so ECS supervises the process directly.
exec squid -N -f /etc/squid/squid.conf

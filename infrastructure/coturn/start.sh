#!/bin/sh
set -eu
export TZ=UTC
if [ ! -e /etc/coturn/tls/tls.crt ] && [ ! -e /etc/coturn/tls/tls.key ]; then
  (
    umask 077
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
      -subj "/CN=relayrtc.local" \
      -addext "subjectAltName=DNS:relayrtc.local,DNS:localhost,IP:127.0.0.1" \
      -keyout /etc/coturn/tls/tls.key \
      -out /etc/coturn/tls/tls.crt
  )
fi
relay_address=
explicit_relay_address=false
for option in "$@"; do
  case "$option" in
    --external-ip=*/*) relay_address=${option##*/} ;;
    --relay-ip=*|--relay-ip|-E*) explicit_relay_address=true ;;
  esac
done
if [ -n "$relay_address" ] && [ "$explicit_relay_address" = false ]; then
  set -- "$@" "--relay-ip=$relay_address"
fi
source_id=$(cat /proc/sys/kernel/random/uuid)
printf '%s.log\n' "$source_id" > /var/log/relayrtc-turn/current.next
mv /var/log/relayrtc-turn/current.next /var/log/relayrtc-turn/current
exec turnserver "$@" --log-file="/var/log/relayrtc-turn/$source_id.log" --simple-log --verbose --new-log-timestamp --new-log-timestamp-format='%Y-%m-%dT%H:%M:%S.%fZ'

#!/bin/sh
set -e

# Defaults for docker-compose substitution
export SIP_TRUNK_DOMAIN="${SIP_TRUNK_DOMAIN:-teler}"
export SIP_TRUNK_IDENTIFY_MATCH="${SIP_TRUNK_IDENTIFY_MATCH:-3.7.75.192}"
export SIP_TRUNK_CALLER_ID="${SIP_TRUNK_CALLER_ID:-+10000000000}"
case "$SIP_TRUNK_CALLER_ID" in +*) ;; *) export SIP_TRUNK_CALLER_ID="+${SIP_TRUNK_CALLER_ID}" ;; esac
export SIP_TRUNK_FROM_USER="${SIP_TRUNK_FROM_USER:-$SIP_TRUNK_CALLER_ID}"
case "$SIP_TRUNK_FROM_USER" in +*) ;; *) export SIP_TRUNK_FROM_USER="+${SIP_TRUNK_FROM_USER}" ;; esac
export SIP_TRUNK_SECURE="${SIP_TRUNK_SECURE:-0}"
if [ "$SIP_TRUNK_SECURE" = "1" ]; then
  export SIP_ASTERISK_TRANSPORT=transport-tls
  export SIP_TRUNK_TRANSPORT=tls
else
  case "${SIP_ASTERISK_TRANSPORT:-}" in
    transport-tcp)
      export SIP_ASTERISK_TRANSPORT=transport-tcp
      export SIP_TRUNK_TRANSPORT=tcp
      ;;
    transport-udp)
      export SIP_ASTERISK_TRANSPORT=transport-udp
      export SIP_TRUNK_TRANSPORT=udp
      ;;
    *)
      export SIP_ASTERISK_TRANSPORT=transport-tcp
      export SIP_TRUNK_TRANSPORT=tcp
      ;;
  esac
fi
export SIP_AUDIOSOCKET_PEER="${SIP_AUDIOSOCKET_PEER:-sip-media-bridge}"
export SIP_AUDIOSOCKET_PORT="${SIP_AUDIOSOCKET_PORT:-9092}"
# RTP keepalive holds the UDP/NAT media mapping open during long one-way audio
# (e.g. a long AI monologue while the caller is silent). Without it the mapping
# expires (~30s) and Asterisk tears down the channel mid-message. rtp_timeout is
# a generous guard so only genuinely dead media hangs up, never a long prompt.
export SIP_RTP_KEEPALIVE="${SIP_RTP_KEEPALIVE:-5}"
export SIP_RTP_TIMEOUT="${SIP_RTP_TIMEOUT:-120}"
export VOICE_BACKEND_URL="${VOICE_BACKEND_URL:-http://voice-backend:8000}"
export ASTERISK_AMI_SECRET="${ASTERISK_AMI_SECRET:-changeme}"

# Optional NAT external addresses. Needed when Asterisk runs behind NAT/Docker
# and must advertise its public IP to the SIP trunk (otherwise SDP/Contact carry
# container-internal 172.x addresses). Applied only when SIP_EXTERNAL_IP is set.
if [ -n "${SIP_EXTERNAL_IP:-}" ]; then
  # Always mark ALL RFC1918 private ranges local so Asterisk rewrites Contact/SDP to
  # SIP_EXTERNAL_IP for outside traffic. Missing the host LAN range (e.g. 192.168.0.0/16)
  # makes Asterisk leak a private IP into Contact and the far-end ACK is lost
  # (BYE cause=408 "ACK Timeout" -> call dies ~32s). SIP_LOCAL_NET appends any extra range.
  export SIP_TRANSPORT_NAT_LINES="external_signaling_address=${SIP_EXTERNAL_IP}
external_media_address=${SIP_EXTERNAL_IP}
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=192.168.0.0/16"
  if [ -n "${SIP_LOCAL_NET:-}" ]; then
    case "$SIP_LOCAL_NET" in
      10.0.0.0/8|172.16.0.0/12|192.168.0.0/16) ;;
      *) export SIP_TRANSPORT_NAT_LINES="${SIP_TRANSPORT_NAT_LINES}
local_net=${SIP_LOCAL_NET}" ;;
    esac
  fi
else
  export SIP_TRANSPORT_NAT_LINES=""
fi

# Optional outbound digest auth. FreJun trunks default to IP authentication, so
# this is only needed if the trunk challenges the outbound INVITE (401/407).
# Applied only when both username and password are provided.
if [ -n "${SIP_TRUNK_USERNAME:-}" ] && [ -n "${SIP_TRUNK_PASSWORD:-}" ]; then
  export SIP_OUTBOUND_AUTH_LINE="outbound_auth=frejun-trunk-auth"
  export SIP_AUTH_SECTION="[frejun-trunk-auth]
type=auth
auth_type=userpass
username=${SIP_TRUNK_USERNAME}
password=${SIP_TRUNK_PASSWORD}"
else
  export SIP_OUTBOUND_AUTH_LINE=""
  export SIP_AUTH_SECTION=""
fi

CONF_DIR=/etc/asterisk

envsubst '${SIP_TRUNK_DOMAIN} ${SIP_TRUNK_CALLER_ID} ${SIP_TRUNK_FROM_USER} ${SIP_TRUNK_TRANSPORT} ${SIP_ASTERISK_TRANSPORT} ${SIP_TRUNK_IDENTIFY_MATCH} ${SIP_AUDIOSOCKET_PEER} ${SIP_AUDIOSOCKET_PORT} ${VOICE_BACKEND_URL} ${ASTERISK_AMI_SECRET} ${SIP_TRANSPORT_NAT_LINES} ${SIP_OUTBOUND_AUTH_LINE} ${SIP_AUTH_SECTION} ${SIP_RTP_KEEPALIVE} ${SIP_RTP_TIMEOUT}' \
  < /etc/asterisk-templates/pjsip.conf.template > "${CONF_DIR}/pjsip.conf"

envsubst '${SIP_AUDIOSOCKET_PEER} ${SIP_AUDIOSOCKET_PORT} ${VOICE_BACKEND_URL}' \
  < /etc/asterisk-templates/extensions.conf.template > "${CONF_DIR}/extensions.conf"

envsubst '${ASTERISK_AMI_SECRET}' \
  < /etc/asterisk-templates/manager.conf.template > "${CONF_DIR}/manager.conf"

cp /etc/asterisk-templates/rtp.conf "${CONF_DIR}/rtp.conf"
chmod +x /var/lib/asterisk/agi-bin/inbound_resolve.py

ASTERISK_BIN="$(command -v asterisk 2>/dev/null || true)"
if [ -z "$ASTERISK_BIN" ] && [ -x /usr/sbin/asterisk ]; then
  ASTERISK_BIN=/usr/sbin/asterisk
fi
if [ -z "$ASTERISK_BIN" ]; then
  echo "asterisk binary not found" >&2
  exit 1
fi

exec "$ASTERISK_BIN" -f -U asterisk -G asterisk

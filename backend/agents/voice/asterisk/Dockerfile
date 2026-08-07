FROM andrius/asterisk:20

USER root

RUN apt-get update && apt-get install -y --no-install-recommends gettext-base python3 curl && rm -rf /var/lib/apt/lists/*

COPY asterisk/pjsip.conf.template /etc/asterisk-templates/pjsip.conf.template
COPY asterisk/extensions.conf.template /etc/asterisk-templates/extensions.conf.template
COPY asterisk/manager.conf.template /etc/asterisk-templates/manager.conf.template
COPY asterisk/rtp.conf /etc/asterisk-templates/rtp.conf
COPY asterisk/entrypoint.sh /entrypoint.sh
COPY asterisk/agi/inbound_resolve.py /var/lib/asterisk/agi-bin/inbound_resolve.py

RUN sed -i 's/\r$//' /entrypoint.sh /var/lib/asterisk/agi-bin/inbound_resolve.py \
  && chmod +x /entrypoint.sh /var/lib/asterisk/agi-bin/inbound_resolve.py

EXPOSE 5060/udp 5060/tcp 5061/tcp 5038/tcp 10000-10100/udp

ENTRYPOINT ["/entrypoint.sh"]

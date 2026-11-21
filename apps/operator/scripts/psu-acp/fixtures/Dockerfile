FROM debian:stable-slim
ARG PROFILE=core
RUN install -d -m 0755 /etc/claude-code
COPY --chown=0:0 --chmod=0444 managed-${PROFILE}.json /etc/claude-code/managed-settings.json
COPY --chown=0:0 --chmod=0555 observe-hook.sh /usr/local/bin/observe-managed-hook
ENV HOME=/var/lib/psu-acp
ENV CLAUDE_CONFIG_DIR=$HOME/.claude AWS_EC2_METADATA_DISABLED=true
RUN install -d -m 0700 -o 65534 -g 65534 /work "$HOME" "$CLAUDE_CONFIG_DIR"
USER 65534:65534
RUN test -s /etc/claude-code/managed-settings.json \
    && test -r /etc/claude-code/managed-settings.json \
    && test ! -w /etc/claude-code/managed-settings.json \
    && test ! -w /etc/claude-code \
    && test -w "$CLAUDE_CONFIG_DIR"
WORKDIR /work

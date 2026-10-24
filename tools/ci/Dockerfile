FROM ghcr.io/renovatebot/renovate:44.181.1@sha256:823dc5036b911696c27faacf7664219b28e6e15826405720df29aad208d19f25

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

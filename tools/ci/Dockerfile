FROM ghcr.io/renovatebot/renovate:44.155.1@sha256:f5796f26088c0f5debb07c16fa9e801145e4d3ba9717d9cc22ca8cd265e2a0eb

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

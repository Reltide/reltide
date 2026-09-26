FROM ghcr.io/renovatebot/renovate:44.115.10@sha256:e262ed52b23dd8c545c80faf5b1ad5c95a07b3f198888de8d7b8928f45c307c7

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

FROM ghcr.io/renovatebot/renovate:44.133.0@sha256:05c512c35c764ef6a179e69c3b30567eca254d67f13a0143479fe3c84852c67a

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

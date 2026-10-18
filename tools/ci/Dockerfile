FROM ghcr.io/renovatebot/renovate:44.167.5@sha256:c33150ec6407624a9399a2d827fd125becafdbe4519d7584488cbdd17f99081e

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

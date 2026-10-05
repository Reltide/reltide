FROM ghcr.io/renovatebot/renovate:44.138.0@sha256:32027ed5e5e450f76ee372fcd6e72c8114db7fdb28c97c520515a03ea4a0d77b

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

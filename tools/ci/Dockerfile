FROM ghcr.io/renovatebot/renovate:44.115.13@sha256:0c04185c9e7ea5284da22ea0b2a2c88dcd3687badd8feb6c71691659b380df9b

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

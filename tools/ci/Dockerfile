FROM ghcr.io/renovatebot/renovate:44.123.0@sha256:4a6828844bb2685c407071b4fa48d59df6df1693a73b38055a82495a945d53a4

WORKDIR /workspace
ENTRYPOINT ["renovate-config-validator", "--strict", "--no-global", "renovate.json"]

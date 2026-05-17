release:
    docker buildx build \
    --platform linux/arm64,linux/amd64 \
    --file ./services/pds/Dockerfile \
    --tag fatfingers23/turso-pds:latest \
    --tag fatfingers23/turso-pds:0.4.222 \
    --builder desktop-linux \
    --push .

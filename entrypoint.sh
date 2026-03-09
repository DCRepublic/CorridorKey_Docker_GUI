#!/bin/bash

#Check if corridor model exists, if not download it. This is done in the entrypoint to allow for better caching of the model, as it may change more frequently than the rest of the code.
[ -f ./CorridorKeyModule/checkpoints/CorridorKey.pth ] || curl -L https://huggingface.co/nikopueringer/CorridorKey_v1.0/resolve/main/CorridorKey_v1.0.pth -o ./CorridorKeyModule/checkpoints/CorridorKey.pth
[ "$DOWNLOAD_GVM" = "true" ] && uv run hf download geyongtao/gvm --local-dir gvm_core/weights || true

exec /app/.venv/bin/uvicorn backend.api_server:app --host 0.0.0.0 --port 8000

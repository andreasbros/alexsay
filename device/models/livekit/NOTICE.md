`melspectrogram.onnx` and `embedding_model.onnx` are the frozen front end of
[livekit-wakeword](https://github.com/livekit/livekit-wakeword) (crate `livekit-wakeword` 0.1.3), Copyright 2026 LiveKit, Inc.,
Apache License 2.0. They turn 16 kHz audio into mel frames (32 bins) and 96-dimensional speech embeddings; the wake word
classifier (`../alexsay.onnx`) is trained on those embeddings with `just wake-train`.

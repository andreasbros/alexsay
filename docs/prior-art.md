# Prior art

What exists, and what we take from it. Prices and stock change; check before quoting.

| Project | What it is | Take | Leave |
|---|---|---|---|
| Echo Dot 2nd-gen root exploits | Community jailbreaks of old Echo hardware | Proof the form factor works for voice | Old SoC, closed audio stack; nothing for newer generations |
| Home Assistant Voice Preview Edition | ESP32-S3 + XMOS XU316 satellite, Wyoming/ESPHome, mute switch, LED ring | Mic and AEC approach, mute switch idea, microWakeWord | Small speaker, voice pipeline is STT → LLM → TTS (not full-duplex) |
| FutureProofHomes Satellite1 | Pi-HAT-sized ESP32 + XMOS voice board with amp | Same XMOS + amp + Pi combination | Not a USB audio device for our daemon |
| Mycroft Mark II | Pi-based open smart speaker with display | Enclosure layout lessons (mics away from the driver) | Company folded; software stack abandoned |
| Seeed ReSpeaker Lite / XVF3800 4-mic array | XMOS boards with USB firmware | Firmware tooling (`xvf_host.py`, DFU) shared with the Flex | Fixed form factor |
| Waveshare ESP32-S3 1.85" round LCD board | All-in-one round dev board with mics and speaker | Round-UI ideas | No hardware AEC, tiny speaker |
| openWakeWord | Open wake-word models, synthetic training pipeline | Training "alexsay" with Piper TTS positives | Python runtime (we use the ONNX models from Rust) |
| microWakeWord | Small TFLite wake-word models used by ESPHome | Fallback if openWakeWord confuses "Alexa" | |
| Wyoming protocol | HA's voice satellite protocol | `wyoming-openwakeword` as a Phase 1 shortcut | Full Wyoming pipeline (we talk to OpenAI directly) |
| OpenAI realtime / GPT-Live | Speech-to-speech models over WebSocket | The whole conversation layer | |

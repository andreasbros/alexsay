# alexsay docs

Read in this order if you are new:

1. [architecture.md](architecture.md): what the system is and how audio and data flow
2. [device-design.md](device-design.md): the hardware, enclosure and acoustics
3. [software.md](software.md): the `alexsay` daemon
4. [build-manual.md](build-manual.md): how to bring up the Phase 1 bench build
5. [procurement.md](procurement.md): what's been bought, what's missing
6. [measurements.md](measurements.md): test plan and results
7. [decisions.md](decisions.md): decision log

Reference: [prior-art.md](prior-art.md).

## Phases

| Phase | Goal | Hardware |
|---|---|---|
| **1: Bench** | Answer four questions on the desk: does the Flex reflash and capture cleanly, how much echo survives the AEC at speaking volume, does "Alex" wake without "Alexa" false accepts, what is the wake-to-first-audio latency | Pi 5, Flex boards on standoffs, R 10 S in a temporary box, SD card |
| **2: Cylinder** | The finished speaker: printed enclosure, tuned acoustics, NVMe, runs unattended | PETG cylinder, gaskets, wadding, M.2 HAT+ and SSD |

Phase 2 waits for Phase 1 because the enclosure layout depends on the answers: how far the driver must sit from the mics, how much the fan matters, which firmware (16 or 48 kHz) and therefore how much the box tuning matters.

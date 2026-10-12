import { GITHUB_URL } from "../content/site";

export function OpenStack() {
  return (
    <>
      <p className="lead">
        A smart speaker is a microphone in your home that answers to someone else. Alexsay is an attempt at one that
        answers to you.
      </p>

      <h2>The closed box</h2>
      <p>
        The speakers most homes have are sealed products. The hardware is glued shut, the wake word and the audio
        processing are proprietary, the assistant is whatever the vendor ships, and the conversation goes to the
        vendor&apos;s cloud. You cannot bring your own model, read the code that listens to your kitchen, or keep the
        speaker useful once the company loses interest.
      </p>
      <p>
        Open voice projects exist, and they are good. Home Assistant&apos;s Voice Preview Edition and Assist, Rhasspy
        and OpenVoiceOS all put the pipeline in your hands. Most of them are built as a chain, though: speech to text,
        then a model, then text to speech. That is a turn-taking walkie-talkie, not a conversation. Mycroft, the
        best-known open smart speaker, folded, and its stack went with it.
      </p>
      <p>
        What was missing was the whole stack, open from the board to the server, around a model that actually converses:
        full duplex, interruptible, and running on your own key.
      </p>

      <h2>Open hardware, off the shelf</h2>
      <ul>
        <li>
          <a href="https://www.raspberrypi.com/products/raspberry-pi-5/">Raspberry Pi 5</a> runs the speaker and, if you
          like, Home Assistant next to it.
        </li>
        <li>
          <a href="https://wiki.seeedstudio.com/respeaker/">Seeed ReSpeaker Flex XVF3800</a>, the circular
          four-microphone array (
          <a href="https://thepihut.com/products/respeaker-flex-xvf3800-circular-with-xiao-esp32s3">at The Pi Hut</a>
          ), does beamforming and hardware echo cancellation, and drives the speaker from its own amplifier.
        </li>
        <li>
          <a href="https://www.visaton.de/en/products/drivers/fullrange-systems/r-10-s-4-ohm">Visaton R 10 S</a> is the
          4 inch full-range driver, tuned in software with a high-pass and a peaking cut.
        </li>
        <li>
          A printed PETG cylinder, about 150 by 210 mm, holds it all. The parts list, wiring and acoustics are in{" "}
          <a href={`${GITHUB_URL}/tree/main/docs`}>the docs</a>.
        </li>
      </ul>
      <p>
        Every part can be bought, replaced or swapped. No hardware yet? Any laptop, or a USB microphone and speaker,
        runs the same software today.
      </p>

      <h2>Open software, all of it</h2>
      <p>
        The <a href={GITHUB_URL}>repository</a> holds everything under the MIT licence: the speaker binary, the server,
        the web app, this website, the install scripts and the release pipeline. Your provider keys are sealed on the
        server and handed to your speaker in memory only. Point the server at another OpenAI-compatible endpoint and the
        speakers follow, so &quot;your own AI&quot; can mean your own machine.
      </p>

      <h2>Why Rust</h2>
      <p>A speaker is a real-time audio program that should run for months without attention. Rust fits that job:</p>
      <ul>
        <li>
          <strong>No garbage collector</strong>, so no pauses in the middle of a 10 millisecond audio block.
        </li>
        <li>
          <strong>Memory safety</strong> in code that parses network events and moves audio between threads.
        </li>
        <li>
          <strong>One static binary</strong>, under 13 MB, with the audio stack compiled in. There is nothing to install
          and nothing to drift.
        </li>
        <li>
          <strong>Cross-compilation</strong> to every target from one codebase, with the logic in a core crate that is
          tested on the host.
        </li>
      </ul>

      <h2>Echo cancellation in software</h2>
      <p>
        A speaker that can be interrupted has to hear you over itself. Dedicated chips like the XVF3800 do that in
        hardware. Alexsay also does it in software, with WebRTC&apos;s AEC3 through the pure-Rust{" "}
        <a href="https://crates.io/crates/sonora">sonora</a> crate. Every block the speaker plays goes to the canceller
        as its reference. The canceller runs on the microphone path at 16 kHz in 10 ms blocks, before the wake word or
        the model hear anything. On an ordinary laptop, the assistant&apos;s own voice dropped from about 80% of the
        microphone level to about 1%. That is what lets you talk over it.
      </p>

      <h2>Runs on what you have</h2>
      <p>
        Because the echo cancelling and the wake word live in software, the speaker does not need special hardware.
        Every release builds for the popular architectures and runs each binary on its own architecture before it ships:
      </p>
      <ul>
        <li>Linux x86_64 and aarch64, static, any distribution, including the Raspberry Pi</li>
        <li>macOS on Apple Silicon and Intel</li>
        <li>Windows on x86_64 and Arm</li>
      </ul>
      <p>
        The server follows the same rule: one file for Linux, macOS and Windows, with the same code as the cloud
        version.
      </p>
      <p>
        If that sounds like the speaker you wanted, <a href={GITHUB_URL}>build one</a>.
      </p>
    </>
  );
}

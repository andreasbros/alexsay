import { APP_URL, GITHUB_URL } from "../content/site";

export function FirstRelease() {
  return (
    <>
      <p className="lead">
        Alexsay has its first release. It is a voice assistant you install with one line, talk to by name, and own from
        the microphone to the server.
      </p>

      <pre>
        <code>curl -fsSL https://alexsay.com/install.sh | sh</code>
      </pre>

      <p>
        That line downloads one file: the <code>alexsay</code> binary for your machine, checked against a signed list of
        checksums. Then <code>alexsay setup</code> prints the speaker&apos;s id, you add it in{" "}
        <a href={APP_URL}>the app</a> with your OpenAI key, and <code>alexsay run</code> starts listening. Say
        &quot;Alexsay&quot; and talk.
      </p>

      <h2>What is in 0.1</h2>
      <ul>
        <li>
          <strong>One Rust binary for every platform.</strong> Static on Linux x86_64 and aarch64, including the
          Raspberry Pi 5, plus macOS on Apple Silicon and Intel and Windows on x86_64 and Arm. It is under 13 MB, with
          no Python, no Node.js and no runtime to install.
        </li>
        <li>
          <strong>A wake word that runs on the device.</strong> A small neural network listens for &quot;Alexsay&quot;
          locally, so nothing leaves the room until you say it. <code>alexsay wake record</code> and{" "}
          <code>alexsay wake train</code> teach it your own voice in a few minutes.
        </li>
        <li>
          <strong>Full-duplex conversation.</strong> GPT-Live answers in about a second, and you can talk over it.
        </li>
        <li>
          <strong>Echo cancellation in software.</strong> WebRTC&apos;s AEC3, in pure Rust, removes the speaker&apos;s
          own voice from the microphone, so a laptop or any USB microphone works as well as dedicated hardware.
        </li>
        <li>
          <strong>Memory.</strong> After each conversation, the assistant keeps the facts that matter: your people,
          home, routines and reminders. You can read and edit all of it in the app.
        </li>
        <li>
          <strong>Phone calls.</strong> With Twilio connected, it calls, texts and WhatsApps your contacts. It joins the
          call with you, presses menu keys, and hands you a report when the call ends.
        </li>
        <li>
          <strong>Lights.</strong> Lightwave lights and dimmers by room, by voice.
        </li>
        <li>
          <strong>Your locale and time zone.</strong> Every session knows your language, currency and clock.
        </li>
        <li>
          <strong>Signed updates.</strong> The speaker checks for releases, verifies the signature, installs, restarts
          and tells you out loud.
        </li>
      </ul>

      <h2>Your own server, too</h2>
      <p>
        The app at app.alexsay.com runs on Cloudflare. If you would rather keep everything at home,{" "}
        <code>alexsay-server</code> is the same server in one file: the API, the app, an HTTP server and an embedded
        SQLite database. It runs the exact code that serves app.alexsay.com, and every release has to pass the same
        end-to-end tests against both. It is meant for your own machine or home network, and it never updates itself
        behind your back.
      </p>

      <h2>What comes next</h2>
      <p>
        The hardware is on the bench: a Raspberry Pi 5, a ReSpeaker four-microphone array and a 4 inch driver, heading
        for a printed cylinder. Next up are the speaker&apos;s own phone line over SIP, a wake word trained on real room
        recordings, and more providers for the assistant and the home.
      </p>
      <p>
        The code, the parts list and the build notes are on <a href={GITHUB_URL}>GitHub</a>, under the MIT licence.
        Issues and pull requests are welcome.
      </p>
    </>
  );
}

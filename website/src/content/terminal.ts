// The Development section's terminal: what installing, training and running the speaker prints, in
// the speaker's own formats (install.sh, `alexsay wake train`, the tracing log of `alexsay run`),
// from a real session on a laptop, shortened. Each act tilts the terminal to a new pose.

const ESC = "\u001b[";
const reset = `${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${reset}`;
const bold = (s: string) => `${ESC}1m${s}${reset}`;
const green = (s: string) => `${ESC}32m${s}${reset}`;
const blue = (s: string) => `${ESC}34m${s}${reset}`;
const cyan = (s: string) => `${ESC}36m${s}${reset}`;
const magenta = (s: string) => `${ESC}35m${s}${reset}`;
const yellow = (s: string) => `${ESC}33m${s}${reset}`;
const italic = (s: string) => `${ESC}3m${s}${reset}`;

export const PROMPT = `${green("andreas@kitchen")}${dim(":")}${blue("~")}${dim("$")} `;

/** One line of output and how long the terminal waits before printing it, in milliseconds. */
export interface Line {
  text: string;
  delay: number;
}

export interface Act {
  /** The terminal's 3D pose while this act plays, in degrees. */
  pose: { x: number; y: number; z: number };
  command: string;
  lines: Line[];
}

const field = (name: string, value: string) => `${italic(name)}${dim("=")}${value}`;

/** A line as tracing-subscriber prints it: time, level, message, fields. */
function log(time: string, level: "INFO" | "DEBUG", message: string, ...fields: string[]): string {
  const tag = level === "INFO" ? green(" INFO") : blue("DEBUG");
  return [dim(`2026-10-12T${time}Z`), tag, message, ...fields].join(" ");
}

const say = (who: "user" | "assistant", text: string) =>
  who === "user" ? `${bold(yellow("user:"))} ${text}` : `${bold(magenta("assistant:"))} ${text}`;

const at = (delay: number, text: string): Line => ({ delay, text });

export const ACTS: Act[] = [
  {
    pose: { x: 8, y: -14, z: 1 },
    command: "curl -fsSL https://alexsay.com/install.sh | sh",
    lines: [
      at(500, "Downloading alexsay-x86_64-linux-musl..."),
      at(1300, `Installed ~/.local/bin/alexsay (${bold("alexsay 0.1.3")})`),
      at(200, ""),
      at(150, `Next:  ${cyan("alexsay setup")}            (shows the id to add in the app, checks the audio)`),
      at(120, `       ${cyan("alexsay run")}              (start listening; Ctrl-C stops)`),
      at(120, `       ${cyan("alexsay service install")}  (run at boot)`),
    ],
  },
  {
    pose: { x: 4, y: 10, z: -1 },
    command: "alexsay wake train",
    lines: [
      at(400, "Training the existing model further on 20 takes of alexsay and 20 others, 60 epochs..."),
      at(250, dim("Model type: small.")),
      at(120, dim('Labels: ["none", "alexsay"].')),
      at(120, dim("Training with 32 records. Testing with 8 records.")),
      at(350, `   0 train loss:  0.00000 test acc: ${yellow("62.50%")}`),
      at(300, `  12 train loss:  0.04605 test acc: ${green("87.50%")}`),
      at(300, `  30 train loss:  0.03382 test acc: ${green("87.50%")}`),
      at(300, `  60 train loss:  0.03015 test acc: ${green("87.50%")}`),
      at(250, `Saved ~/.local/alexsay/data/models/alexsay.rpw.`),
      at(150, `The config now uses it (${cyan("wake.model = data/models/alexsay.rpw")}); restart \`alexsay run\`.`),
    ],
  },
  {
    pose: { x: 10, y: -6, z: 0.5 },
    command: "alexsay run",
    lines: [
      at(
        400,
        log(
          "18:09:33.386582",
          "INFO",
          "alexsay starting",
          field("version", '"0.1.3"'),
          field("target", '"x86_64-unknown-linux-musl"'),
        ),
      ),
      at(150, log("18:09:33.512007", "INFO", "echo cancellation: software (AEC3)")),
      at(
        200,
        log(
          "18:09:33.540731",
          "INFO",
          "audio open",
          field("input", "HDA Intel PCH"),
          field("rate", "48000"),
          field("output", "HDA Intel PCH"),
        ),
      ),
      at(220, log("18:09:33.765902", "INFO", "phone line up")),
      at(180, log("18:09:33.838388", "INFO", "claimed: the assistant is ready", field("name", '"kitchen"'))),
      at(1600, log("18:09:40.192902", "INFO", bold(cyan("wake word")), field("score", "0.977"))),
      at(450, log("18:09:41.530863", "DEBUG", "session live_u0_EYEk... open")),
      at(700, log("18:09:42.356234", "INFO", say("user", "Alexsay"))),
      at(900, log("18:09:43.562107", "INFO", say("assistant", "Hi, Andreas."))),
      at(
        300,
        log(
          "18:09:43.792570",
          "INFO",
          dim("reply played: the microphone heard it at 83.3% over a room level of 13.5%"),
        ),
      ),
      at(1300, log("18:09:45.827742", "INFO", say("user", "What time is it?"))),
      at(1400, log("18:09:49.812195", "INFO", say("assistant", "It's 19:09, or 9 minutes past 7pm."))),
      at(1500, log("18:09:52.104311", "INFO", say("user", "Dim the living room to thirty percent, it's movie night."))),
      at(
        900,
        log(
          "18:09:53.020894",
          "INFO",
          "tool",
          field("tool", "dim_light"),
          field("result", '{"ok":true,"room":"Living room","level":30}'),
        ),
      ),
      at(700, log("18:09:53.871205", "INFO", say("assistant", "Done. Thirty percent, popcorn lighting."))),
      at(1600, log("18:09:56.240173", "INFO", say("user", "You're the best thing I've ever built."))),
      at(
        1300,
        log(
          "18:09:57.918650",
          "INFO",
          say("assistant", "Careful, I'm saving that to memory. Forever. How else can I help?"),
        ),
      ),
    ],
  },
];

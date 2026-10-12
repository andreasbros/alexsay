export const APP_URL = "https://app.alexsay.com";
export const GITHUB_URL = "https://github.com/andreasbros/alexsay";
export const DOCS_URL = "https://github.com/andreasbros/alexsay/tree/main/docs";

export interface Feature {
  title: string;
  text: string;
  icon: "wake" | "duplex" | "echo" | "key" | "home" | "open";
}

export const FEATURES: Feature[] = [
  {
    icon: "wake",
    title: "Say Alexsay",
    text: "Say the name and it is listening. The wake word runs on the speaker itself, so nothing leaves the room until you talk to it.",
  },
  {
    icon: "duplex",
    title: "Talk, do not take turns",
    text: "Full-duplex voice. Interrupt the assistant mid-sentence and it stops and listens.",
  },
  {
    icon: "echo",
    title: "Hears you over itself",
    text: "A four-microphone array with hardware echo cancellation keeps its own voice out of your words.",
  },
  {
    icon: "key",
    title: "Your keys, your bill",
    text: "Bring your own OpenAI key today, Claude and Gemini next. Nothing is resold and your keys stay encrypted.",
  },
  {
    icon: "home",
    title: "Runs your home",
    text: "Lights and more through the services you connect: Lightwave today, Apple Home and Google Home next.",
  },
  {
    icon: "open",
    title: "Open hardware, open source",
    text: "A printed enclosure, off-the-shelf parts and a Rust daemon you can read, build and change.",
  },
];

export interface Integration {
  name: string;
  initials: string;
  note: string;
  hue: string;
}

export const INTEGRATIONS: Integration[] = [
  { name: "OpenAI", initials: "OA", note: "GPT-Live voice", hue: "#10a37f" },
  { name: "Claude", initials: "CL", note: "Anthropic", hue: "#d97757" },
  { name: "Gemini", initials: "GE", note: "Google", hue: "#4285f4" },
  { name: "Apple Home", initials: "AH", note: "HomeKit", hue: "#ff9f0a" },
  { name: "Google Home", initials: "GH", note: "Matter", hue: "#34a853" },
  { name: "Lightwave", initials: "LW", note: "Lights and sockets", hue: "#6366f1" },
  { name: "Home Assistant", initials: "HA", note: "Local hub", hue: "#18bcf2" },
];

export interface DevPoint {
  title: string;
  text: string;
}

export const DEV_POINTS: DevPoint[] = [
  {
    title: "Blazing-fast Rust",
    text: "One static binary under 13 MB for Linux, the Raspberry Pi, macOS and Windows. It starts in a fraction of a second.",
  },
  {
    title: "Nothing to install",
    text: "Static musl on Linux with the audio stack compiled in. No Python, no runtime, no packages: drop it in and run it.",
  },
  {
    title: "Wake word on the device",
    text: "A small neural network listens for its name locally. Record a few takes and train it on your own voice in minutes.",
  },
  {
    title: "Echo cancellation in software",
    text: "WebRTC's AEC3 in pure Rust keeps the speaker's own voice out of the microphone, so you can talk over it.",
  },
  {
    title: "Your own server in one file",
    text: "alexsay-server carries the API, the app, an HTTP server and an embedded SQLite database. Same code as the cloud.",
  },
  {
    title: "Signed updates",
    text: "Every release is built and run on its own architecture, signed, verified by the speaker and announced by voice.",
  },
];

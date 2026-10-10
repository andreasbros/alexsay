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
    text: "A wake word trained on the device itself. It ignores Alexa, the TV and people saying Alex.",
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
    text: "Bring your own OpenAI, Claude or Gemini key. Nothing is resold and nothing is logged on our side.",
  },
  {
    icon: "home",
    title: "Home automation stays local",
    text: "Home Assistant runs on the same Raspberry Pi. Your automations keep working when the internet does not.",
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

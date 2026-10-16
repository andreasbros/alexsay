import { Button, Dialog, Flex, Link, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";

export interface HelpStep {
  text: ReactNode;
}

/** A grey Help button that opens the numbered steps for getting a provider's credentials. */
export function HelpDialog({
  title,
  steps,
  note,
  label = "Help",
  size,
}: {
  title: string;
  steps: HelpStep[];
  note?: ReactNode;
  label?: string;
  size?: "1" | "2";
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button type="button" variant="soft" color="gray" size={size}>
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="520px">
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Steps as of October 2026.
        </Dialog.Description>
        <ol style={{ paddingLeft: "1.4em", margin: "var(--space-4) 0 0" }}>
          {steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are a fixed ordered list
            <li key={index} style={{ marginBottom: "var(--space-2)" }}>
              <Text size="2">{step.text}</Text>
            </li>
          ))}
        </ol>
        {note && (
          <Text as="p" size="2" color="gray" mt="4">
            {note}
          </Text>
        )}
        <Flex justify="end" mt="4">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

const external = (href: string, label: string) => (
  <Link href={href} target="_blank" rel="noreferrer">
    {label}
  </Link>
);

export const OPENAI_HELP = {
  title: "Get an OpenAI API key",
  steps: [
    {
      text: (
        <>
          Sign in at {external("https://platform.openai.com/", "platform.openai.com")}. This is the API platform, billed
          separately from a ChatGPT subscription.
        </>
      ),
    },
    {
      text: (
        <>
          Add billing under {external("https://platform.openai.com/settings/organization/billing", "Settings, Billing")}
          : a payment method or prepaid credit. GPT-Live voice (gpt-live-1) is not available on the free tier.
        </>
      ),
    },
    {
      text: (
        <>
          Open {external("https://platform.openai.com/api-keys", "API keys")} and pick a project (or create one, for
          example &quot;alexsay&quot;).
        </>
      ),
    },
    {
      text: 'Choose "Create new secret key", give it a name, keep the default permissions ("All") and create it.',
    },
    { text: "Copy the key straight away: it starts with sk- and is shown only once." },
    { text: "Paste it above, press Save, then Test. The test lists the models the key can see." },
    {
      text: (
        <>
          For the assistant to join phone calls (needs Twilio below): open{" "}
          {external("https://platform.openai.com/settings/organization/general", "Settings, General")} and copy the
          project ID (proj_...). Then under Settings, Project, Webhooks create a webhook with URL
          https://app.alexsay.com/v1/openai/webhook and the event realtime.call.incoming; copy its signing secret
          (whsec_...). Paste both under Phone calls above.
        </>
      ),
    },
  ],
  note:
    "Only this app and your claimed speakers ever use the key. Delete it on the API keys page to revoke it. " +
    "Calls the assistant joins are billed by OpenAI per minute of realtime audio on top of Twilio's rates.",
};

export const LIGHTWAVE_HELP = {
  title: "Get your Lightwave API tokens",
  steps: [
    {
      text: (
        <>
          Sign in at {external("https://my.lightwaverf.com/", "my.lightwaverf.com")} with the account you use in the
          Lightwave app. Your Link Plus hub must already be set up there.
        </>
      ),
    },
    { text: 'Open Settings, then "API Integration" and choose "Get Token". Lightwave asks for your password again.' },
    {
      text: 'Copy both values shown: the long string labelled "Basic" is the basic token, the other is the refresh token.',
    },
    {
      text: "Paste them above and press Save. Saving exchanges the tokens with Lightwave at once, so a mistake shows immediately.",
    },
    { text: "Press Test to count your homes; the lights list appears below the card." },
  ],
  note:
    'A refresh token works once. If Lightwave answers "Unknown refresh token", the pasted one was already used (by an ' +
    "earlier save or another integration): press Get Token again and paste the new pair.",
};

export const SPOTIFY_HELP = {
  title: "Connect Spotify",
  steps: [
    {
      text: (
        <>
          You need Spotify Premium: Spotify only lets apps control playback on Premium accounts. Sign in at{" "}
          {external("https://developer.spotify.com/dashboard", "developer.spotify.com/dashboard")} with that account.
        </>
      ),
    },
    {
      text: 'Press "Create app". Give it any name and description, tick "Web API", and under Redirect URIs paste the address shown on the card, exactly as written. Save.',
    },
    {
      text: 'Open the app\'s Settings: copy the Client ID, then "View client secret" and copy that too. Paste both on the card and press Save.',
    },
    {
      text: 'Press "Sign in with Spotify" and allow the access it asks for. You come back here signed in; the card shows the account.',
    },
    {
      text: "Spotify keeps new apps in Development Mode: only accounts you add under the app's User Management (up to five) can sign in. Add everyone in the home who should.",
    },
    {
      text: "Then ask the assistant: play a playlist, a song or an artist, pause, skip, or ask what is playing. It plays on the speaker you are talking to unless you name another device.",
    },
  ],
};

export const TWILIO_HELP = {
  title: "Connect Twilio",
  steps: [
    {
      text: (
        <>
          Sign in at {external("https://console.twilio.com/", "console.twilio.com")}. A trial account can only call and
          text numbers you have verified there; upgrade (add funds) to reach everyone.
        </>
      ),
    },
    {
      text: 'On the console home page, under "Account Info", copy the Account SID (starts with AC) and the Auth Token (press the eye icon to reveal it). Paste both above and press Save.',
    },
    {
      text: (
        <>
          Buy a number with Voice and SMS under{" "}
          {external(
            "https://console.twilio.com/us1/develop/phone-numbers/manage/search",
            "Phone Numbers, Buy a number",
          )}
          . UK numbers need an address, some a regulatory bundle. Then press Change here and pick it: saving points the
          number&apos;s call and message webhooks at this app.
        </>
      ),
    },
    {
      text: "Enter your own mobile number. A call from the assistant rings it first and then connects the other person.",
    },
    {
      text: (
        <>
          WhatsApp: to try it, open{" "}
          {external("https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn", "Messaging, Try it out")}{" "}
          and enter the sandbox sender (whatsapp:+14155238886); every phone first texts the sandbox its join code. For
          real use, register a WhatsApp sender under Messaging, Senders and enter its number.
        </>
      ),
    },
    {
      text: (
        <>
          For a speaker to take calls, create a SIP domain under{" "}
          {external("https://console.twilio.com/us1/develop/voice/manage/sip-domains", "Voice, SIP Domains")} with SIP
          registration on and a credential list, set its voice webhook to
          https://app.alexsay.com/v1/twilio/voice/outbound, and enter the domain here (for example
          alexsay.sip.twilio.com). Each speaker registers with its UUID as the username.
        </>
      ),
    },
  ],
  note:
    "Calls are billed by Twilio for both legs: your phone and the person called. Plain WhatsApp text only reaches " +
    "people who wrote to the sender in the last 24 hours; anything else needs an approved template, which the " +
    "assistant does not send yet.",
};

export const CONTACTS_HELP = {
  title: "Import contacts from your phone",
  steps: [
    {
      text: '"Import from phone" opens the phone\'s own contact picker: you tick the people to share and only their names and numbers reach this app. The button appears only in browsers that offer the picker.',
    },
    {
      text: 'iPhone: Safari hides the picker behind a flag. Open Settings, Apps, Safari, Advanced, Feature Flags (on older iOS: Advanced, Experimental Features) and turn on "Contact Picker API". Reload this page and the button appears.',
    },
    { text: "Android: Chrome has the picker switched on. Open this page in Chrome and press Import from phone." },
    {
      text: 'Laptop, or everyone at once: export a vCard. iPhone: Contacts app, Lists, press and hold "All Contacts", Export, then AirDrop or mail the .vcf to yourself. Google Contacts: contacts.google.com, Export, vCard. Then press "Import vCard" here and pick the file.',
    },
    {
      text: "Local numbers such as 07700 900123 are stored with the country code from the Twilio card (+44 unless you changed it). Importing again later updates names without duplicating anyone.",
    },
  ],
  note: "Contacts stay in your account only; the assistant reads them to call and message people you name.",
};

export const OPENAI_SIP_HELP = {
  title: "Let the assistant join phone calls (OpenAI SIP)",
  steps: [
    {
      text: "What it is: OpenAI's Realtime API has a SIP endpoint, sip.api.openai.com. When you place a call from the Assistant page, Twilio dials that endpoint into the call as a third participant, so the assistant hears everyone and can speak. Twilio must already be connected below.",
    },
    {
      text: (
        <>
          Copy the project ID: open{" "}
          {external("https://platform.openai.com/settings/organization/general", "platform.openai.com, Settings")}, pick
          the project your API key belongs to (its name is in the top left) and under General copy the ID that starts
          with proj_.
        </>
      ),
    },
    {
      text: (
        <>
          Create the webhook: in the same project open{" "}
          {external("https://platform.openai.com/settings/project/webhooks", "Settings, Project, Webhooks")} and press
          Create. URL: https://app.alexsay.com/v1/openai/webhook. Events: tick realtime.call.incoming. Save.
        </>
      ),
    },
    {
      text: "Copy the webhook's signing secret (starts with whsec_). It is shown once, after saving; use Rotate secret if you lost it.",
    },
    {
      text: 'Back here press Change on the OpenAI card and paste both under "Phone calls": the project ID and the webhook secret. Leave the call model as gpt-realtime unless OpenAI names a newer realtime model. Save.',
    },
    {
      text: 'Check: the card summary now says "joins phone calls". Start a conversation on the Assistant page and say, for example, "call Mum and ask if Sunday lunch is still on". Your page answers at once, Mum\'s phone rings, and the assistant joins and speaks when the task calls for it or when you say Alexsay.',
    },
    {
      text: 'The API key must be allowed to use the Realtime API in that project (the default "All" permissions are fine). Make sure billing has credit: a SIP call is charged per minute of realtime audio on top of Twilio\'s call rates.',
    },
  ],
  note:
    "Without this setup calls still open in the Assistant page; you simply talk to the other person yourself. " +
    "If the assistant never joins, look under Settings, Project, Webhooks for failed deliveries: a 403 there means " +
    "the secret pasted here does not match, a 404 means the call did not come through Twilio's conference.",
};

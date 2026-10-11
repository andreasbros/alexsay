import { Button, Dialog, Flex, Link, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";

export interface HelpStep {
  text: ReactNode;
}

/** A grey Help button that opens the numbered steps for getting a provider's credentials. */
export function HelpDialog({ title, steps, note }: { title: string; steps: HelpStep[]; note?: ReactNode }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button type="button" variant="soft" color="gray">
          Help
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
  ],
  note: "Only this app and your claimed speakers ever use the key. Delete it on the API keys page to revoke it.",
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

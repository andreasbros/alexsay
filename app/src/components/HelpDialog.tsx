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
    { text: "Paste them above and press Save, then Test. The test counts your homes; the lights list appears below." },
  ],
  note:
    "The refresh token is single use: every exchange returns a new one, which this app stores for you. If another " +
    "integration used the same token, generate a fresh pair here.",
};

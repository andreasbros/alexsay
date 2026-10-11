import { Button, Card, Flex, Heading, Select, Switch, Text } from "@radix-ui/themes";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type User } from "../api";
import { BUILD } from "../build";
import { isDebug, setDebug, subscribeDebug } from "../lib/debug";
import { deviceLocale, LOCALES, TIMEZONES } from "../lib/locale";
import { setSoundsEnabled, soundsEnabled } from "../lib/sounds";

/** Per-browser preferences, plus the one the server must enforce: whether the assistant may read the log. */
export function Settings({ user }: { user: User }) {
  const [debug, setDebugOn] = useState(isDebug);
  const [sounds, setSounds] = useState(soundsEnabled);
  const client = useQueryClient();
  const logAccess = useMutation({
    mutationFn: (ai_log_access: boolean) => api.updateSettings({ ai_log_access }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
  const callTest = useMutation({
    mutationFn: (ai_call_test: boolean) => api.updateSettings({ ai_call_test }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
  const where = useMutation({
    mutationFn: (changes: { locale?: string; timezone?: string }) => api.updateSettings(changes),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
  const locale = where.isPending ? (where.variables?.locale ?? user.locale) : user.locale;
  const timezone = where.isPending ? (where.variables?.timezone ?? user.timezone) : user.timezone;
  const localeOptions =
    locale && !LOCALES.some((l) => l.code === locale) ? [{ code: locale, name: locale }, ...LOCALES] : LOCALES;
  const timezoneOptions = timezone && !TIMEZONES.includes(timezone) ? [timezone, ...TIMEZONES] : TIMEZONES;
  const here = deviceLocale();
  useEffect(() => subscribeDebug(() => setDebugOn(isDebug())), []);
  return (
    <Flex direction="column" gap="5">
      <Heading size="7">Settings</Heading>
      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Where you are</Heading>
          <Text size="2" color="gray">
            Told to the assistant at the start of every conversation and call: the language it speaks, the currency and
            date style it uses, and the clock it answers the time from.
          </Text>
          <Flex gap="3" wrap="wrap" align="end">
            <Flex direction="column" gap="1">
              <Text size="1" color="gray">
                Language and region
              </Text>
              <Select.Root value={locale ?? "en-GB"} onValueChange={(code) => where.mutate({ locale: code })}>
                <Select.Trigger aria-label="Locale" />
                <Select.Content>
                  {localeOptions.map((l) => (
                    <Select.Item key={l.code} value={l.code}>
                      {l.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>
            <Flex direction="column" gap="1">
              <Text size="1" color="gray">
                Time zone
              </Text>
              <Select.Root value={timezone ?? "Europe/London"} onValueChange={(tz) => where.mutate({ timezone: tz })}>
                <Select.Trigger aria-label="Time zone" />
                <Select.Content>
                  {timezoneOptions.map((tz) => (
                    <Select.Item key={tz} value={tz}>
                      {tz}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>
            {here && (here.locale !== locale || here.timezone !== timezone) && (
              <Button variant="soft" onClick={() => where.mutate(here)}>
                Use this device&apos;s: {here.locale}, {here.timezone}
              </Button>
            )}
          </Flex>
          {where.isError && (
            <Text size="2" color="red">
              Could not save: {where.error instanceof Error ? where.error.message : "unknown error"}
            </Text>
          )}
        </Flex>
      </Card>
      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Assistant</Heading>
          <Text as="label" size="2">
            <Flex gap="3" align="center">
              <Switch
                checked={sounds}
                onCheckedChange={(on) => {
                  setSounds(on);
                  setSoundsEnabled(on);
                }}
              />
              Conversation sounds
            </Flex>
          </Text>
          <Text size="2" color="gray">
            A rising chime when the assistant starts listening, a falling tone and a short blip when the conversation
            ends.
          </Text>
        </Flex>
      </Card>
      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Diagnostics</Heading>
          <Text as="label" size="2">
            <Flex gap="3" align="center">
              <Switch
                checked={logAccess.isPending ? (logAccess.variables ?? false) : (user.ai_log_access ?? false)}
                onCheckedChange={(on) => logAccess.mutate(on)}
                aria-label="AI log access"
              />
              AI log access
            </Flex>
          </Text>
          <Text size="2" color="gray">
            Lets the assistant read the server&apos;s log of what it did for you (calls placed and answered, tools,
            failures), so you can ask it what happened. Up to 100 lines at a time, newest or oldest first.
          </Text>
          <Text as="label" size="2">
            <Flex gap="3" align="center">
              <Switch
                checked={callTest.isPending ? (callTest.variables ?? false) : (user.ai_call_test ?? false)}
                onCheckedChange={(on) => callTest.mutate(on)}
                aria-label="AI call test"
              />
              AI call test
            </Flex>
          </Text>
          <Text size="2" color="gray">
            Lets the assistant place rehearsal calls: ask for a test call and another AI answers over the phone network,
            playing the part and scenario you describe (a GP receptionist, a restaurant), with you and the assistant on
            the line. You can direct either side or have more people and agents added. Needs Twilio and OpenAI phone
            calls set up.
          </Text>
          <Text as="label" size="2">
            <Flex gap="3" align="center">
              <Switch checked={debug} onCheckedChange={(on) => setDebug(on)} />
              Enable debug log
            </Flex>
          </Text>
          <Text size="2" color="gray">
            Shows a log strip at the bottom of the Assistant screen with every event, level reading and bar movement,
            with Copy and Clear. Stays on in this browser until switched off.
          </Text>
        </Flex>
      </Card>
      <Card size="3">
        <Flex direction="column" gap="2">
          <Heading size="4">About</Heading>
          <Text size="2" color="gray">
            Build <span className="mono">{BUILD}</span>
          </Text>
        </Flex>
      </Card>
    </Flex>
  );
}

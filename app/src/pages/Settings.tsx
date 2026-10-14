import { Button, Card, Flex, Heading, Select, Switch, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api, type User } from "../api";
import { BUILD } from "../build";
import { isDebug, setDebug, subscribeDebug } from "../lib/debug";
import { deviceLocale, LOCALES, TIMEZONES } from "../lib/locale";
import { setSoundsEnabled, soundsEnabled } from "../lib/sounds";
import { useAuthConfig } from "../session";

/**
 * The account's email, the home's settings (changed by its admins, enforced by the server) and
 * per-browser preferences.
 */
export function Settings({ user }: { user: User }) {
  const homeAdmin = user.homeRole === "admin";
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
      <EmailCard user={user} />
      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Where you are</Heading>
          <Text size="2" color="gray">
            Told to the assistant at the start of every conversation and call: the language it speaks, the currency and
            date style it uses, and the clock it answers the time from.
            {!homeAdmin && " Set for the whole home by its admins."}
          </Text>
          <Flex gap="3" wrap="wrap" align="end">
            <Flex direction="column" gap="1">
              <Text size="1" color="gray">
                Language and region
              </Text>
              <Select.Root
                value={locale ?? "en-GB"}
                onValueChange={(code) => where.mutate({ locale: code })}
                disabled={!homeAdmin}
              >
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
              <Select.Root
                value={timezone ?? "Europe/London"}
                onValueChange={(tz) => where.mutate({ timezone: tz })}
                disabled={!homeAdmin}
              >
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
            {homeAdmin && here && (here.locale !== locale || here.timezone !== timezone) && (
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
                disabled={!homeAdmin}
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
                disabled={!homeAdmin}
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

const EMAIL_ERRORS: Record<string, string> = {
  email_in_use: "Another account already signs in with that address.",
  wrong: "That code is not right. Check the latest email.",
  expired: "That code has expired. Send a new one.",
  too_many_attempts: "Too many wrong codes. Send a new one.",
  too_many: "Too many emails to this address. Try again in an hour.",
  bad_request: "Check the address and the six-digit code.",
};

/** Adds or changes the address you can sign in with: it is kept only once the code sent to it comes back. */
function EmailCard({ user }: { user: User }) {
  const config = useAuthConfig();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["session"] });
  const send = useMutation({
    mutationFn: (address: string) => api.addEmail(address).then(() => address),
    onSuccess: setSentTo,
  });
  const confirm = useMutation({
    mutationFn: api.confirmEmail,
    onSuccess: () => {
      setSentTo(null);
      setEmail("");
      setCode("");
      void refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.removeEmail, onSuccess: refresh });
  const failure = send.error ?? confirm.error ?? remove.error;
  const error = failure instanceof ApiError ? (EMAIL_ERRORS[failure.code] ?? failure.message) : failure?.message;

  if (!config.data?.email_login && !user.email) {
    return null;
  }
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Heading size="4">Email</Heading>
        <Text size="2" color="gray">
          {user.email ? (
            <>
              You can sign in as <strong>{user.email}</strong> with a code sent there.
            </>
          ) : (
            "Add an address to sign in with a code sent to it, and to receive invitations."
          )}
        </Text>
        {config.data?.email_login &&
          (sentTo ? (
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                confirm.mutate(code.trim());
              }}
            >
              <Flex gap="3" align="end" wrap="wrap">
                <TextField.Root
                  aria-label={`Code sent to ${sentTo}`}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  required
                />
                <Button type="submit" loading={confirm.isPending}>
                  Confirm
                </Button>
                <Button type="button" variant="ghost" color="gray" onClick={() => setSentTo(null)}>
                  Cancel
                </Button>
              </Flex>
            </form>
          ) : (
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                send.mutate(email.trim());
              }}
            >
              <Flex gap="3" align="end" wrap="wrap">
                <TextField.Root
                  type="email"
                  aria-label="Email address"
                  placeholder={user.email ? "New address" : "name@example.com"}
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={{ minWidth: 240 }}
                />
                <Button type="submit" variant="soft" loading={send.isPending}>
                  {user.email ? "Change" : "Add"}
                </Button>
                {user.email && (
                  <Button type="button" variant="ghost" color="red" onClick={() => remove.mutate()}>
                    Remove
                  </Button>
                )}
              </Flex>
            </form>
          ))}
        {sentTo && (
          <Text size="2" color="gray">
            A code is on its way to {sentTo}.
          </Text>
        )}
        {error && (
          <Text size="2" color="red">
            {error}
          </Text>
        )}
      </Flex>
    </Card>
  );
}

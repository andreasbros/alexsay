import { Card, Flex, Heading, Switch, Text } from "@radix-ui/themes";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type User } from "../api";
import { BUILD } from "../build";
import { isDebug, setDebug, subscribeDebug } from "../lib/debug";
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
  useEffect(() => subscribeDebug(() => setDebugOn(isDebug())), []);
  return (
    <Flex direction="column" gap="5">
      <Heading size="7">Settings</Heading>
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

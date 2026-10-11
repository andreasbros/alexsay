import { Card, Flex, Heading, Switch, Text } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { BUILD } from "../build";
import { isDebug, setDebug, subscribeDebug } from "../lib/debug";
import { setSoundsEnabled, soundsEnabled } from "../lib/sounds";

/** Per-browser preferences; nothing here touches the account on the server. */
export function Settings() {
  const [debug, setDebugOn] = useState(isDebug);
  const [sounds, setSounds] = useState(soundsEnabled);
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

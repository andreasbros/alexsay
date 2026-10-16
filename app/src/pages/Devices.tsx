import { EnterIcon, PlusIcon, SpeakerLoudIcon } from "@radix-ui/react-icons";
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  Flex,
  IconButton,
  Slider,
  Switch,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, api, type Device, type User } from "../api";
import { Section, useSection } from "../components/Section";
import { useDropIn } from "../drop_in";
import { atLeastVersion, DROP_IN_SINCE, isUuid } from "../format";
import { dropInSupported } from "../lib/drop_in";

/** A speaker the browser can drop in on: online, running software that takes drop-ins, from a browser that can carry one. */
export const canDropIn = (device: Pick<Device, "online" | "firmware">, browser = dropInSupported()): boolean =>
  browser && device.online && atLeastVersion(device.firmware, DROP_IN_SINCE);

const ERRORS: Record<string, string> = {
  claimed: "Another account already owns this speaker.",
  exists: "This speaker is already in your list.",
  bad_request: "That is not a UUID. It is printed by `alexsay id` on the speaker.",
};

/** The home's speakers, a section of the Home page: name, status and sound; everything else is on the speaker's page. */
export function DevicesSection({ user }: { user: User }) {
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 30_000 });
  const canChange = user.role === "admin" || user.homeRole === "admin";

  return (
    <Section id="devices" title="Devices" actions={canChange && <AddDevice />}>
      {devices.data?.length === 0 && (
        <Text size="2" color="gray">
          No speakers yet. Add one with the UUID it prints on its console, then it will show up here as soon as it calls
          home.
        </Text>
      )}
      {devices.data && devices.data.length > 0 && (
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {devices.data.map((device) => (
              <Table.Row key={device.id} align="center">
                <Table.RowHeaderCell>
                  <Link to={`/devices/${device.id}`} style={{ color: "inherit" }}>
                    {device.name || <span className="mono">{device.id}</span>}
                  </Link>
                </Table.RowHeaderCell>
                <Table.Cell>
                  <StatusBadge device={device} />
                </Table.Cell>
                <Table.Cell justify="end">{device.sound && <SoundButton device={device} />}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Section>
  );
}

export function StatusBadge({ device }: { device: Pick<Device, "online"> }) {
  return <Badge color={device.online ? "grass" : "gray"}>{device.online ? "online" : "offline"}</Badge>;
}

/** Volume and microphone mute of one speaker: shown as last reported, sent when the slider is let go. */
export function SoundControls({ device }: { device: Device }) {
  const client = useQueryClient();
  const reported = device.sound ?? { volume: 100, mic_muted: false };
  const [volume, setVolume] = useState(reported.volume);
  useEffect(() => setVolume(reported.volume), [reported.volume]);
  const set = useMutation({
    mutationFn: (sound: { volume?: number; mic_muted?: boolean }) => api.setDeviceSound(device.id, sound),
    onSuccess: () => client.invalidateQueries({ queryKey: ["devices"] }),
  });
  const offline = !device.online;
  return (
    <Flex direction="column" gap="4">
      <Text size="2" color="gray">
        {offline ? "The speaker is offline; its last known settings are shown." : "Changes reach the speaker at once."}
      </Text>
      <Flex direction="column" gap="2">
        <Flex justify="between">
          <Text size="2" weight="medium">
            Volume
          </Text>
          <Text size="2" color="gray">
            {volume}%
          </Text>
        </Flex>
        <Slider
          aria-label="Volume"
          value={[volume]}
          min={0}
          max={100}
          step={5}
          disabled={offline || set.isPending}
          onValueChange={([v]) => setVolume(v ?? volume)}
          onValueCommit={([v]) => v !== undefined && set.mutate({ volume: v })}
        />
      </Flex>
      <Flex justify="between" align="center">
        <Text size="2" weight="medium">
          Microphone muted
        </Text>
        <Switch
          aria-label="Microphone muted"
          checked={reported.mic_muted}
          disabled={offline || set.isPending}
          onCheckedChange={(mic_muted) => set.mutate({ mic_muted })}
        />
      </Flex>
      {set.error && (
        <Text size="2" color="red">
          {set.error instanceof ApiError && set.error.code === "offline"
            ? "The speaker is not connected right now."
            : "The speaker did not take the change."}
        </Text>
      )}
    </Flex>
  );
}

/** The list's shortcut to the sound controls. */
function SoundButton({ device }: { device: Device }) {
  const name = device.name || "this speaker";
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <IconButton size="1" variant="ghost" aria-label={`Sound of ${name}`} title="Sound">
          <SpeakerLoudIcon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>{name}</Dialog.Title>
        <SoundControls device={device} />
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

/** Asks before dropping in: the speaker will announce the caller to whoever is in the room. */
export function DropInButton({ device }: { device: Device }) {
  const dropIn = useDropIn();
  const name = device.name || "this speaker";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button variant="soft" aria-label={`Drop in on ${name}`}>
          <EnterIcon /> Drop in
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content maxWidth="420px">
        <AlertDialog.Title>Drop in on {name}?</AlertDialog.Title>
        <AlertDialog.Description size="2">
          The speaker announces you and asks whoever is there whether to accept. Once accepted you hear the room and the
          room hears you, until either side hangs up or 40 seconds pass in silence.
        </AlertDialog.Description>
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button onClick={() => dropIn.start({ id: device.id, name })}>
              <EnterIcon /> Drop in
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function AddDevice() {
  const client = useQueryClient();
  const section = useSection();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addDevice(id.trim().toLowerCase(), name.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["devices"] });
      // The new speaker is inside the section: show it
      section.open();
      setOpen(false);
      setId("");
      setName("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };
  const error = add.error instanceof ApiError ? (ERRORS[add.error.code] ?? add.error.code) : add.error?.message;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button>
          <PlusIcon /> Add device
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Add device</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Enter the UUID the speaker prints with <span className="mono">alexsay id</span>.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3" mt="4">
            <TextField.Root
              placeholder="UUID"
              aria-label="UUID"
              value={id}
              onChange={(e) => setId(e.target.value)}
              className="mono"
              autoFocus
              required
            />
            <TextField.Root
              placeholder="Name, such as Kitchen"
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            {error && (
              <Text color="red" size="2">
                {error}
              </Text>
            )}
            <Flex justify="end" gap="2" mt="2">
              <Dialog.Close>
                <Button variant="soft" color="gray" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={add.isPending} disabled={!isUuid(id) || !name.trim()}>
                Add
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

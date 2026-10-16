import {
  ArrowLeftIcon,
  PauseIcon,
  Pencil1Icon,
  PlayIcon,
  TrackNextIcon,
  TrackPreviousIcon,
} from "@radix-ui/react-icons";
import { AlertDialog, Badge, Button, Card, Flex, Heading, IconButton, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Device, type MusicAction, type User } from "../api";
import { ago } from "../format";
import { canDropIn, DropInButton, SoundControls, StatusBadge } from "./Devices";

/** One speaker: its name, state, music, sound, details and removal. Reached from the Devices list. */
export function DevicePage({ user }: { user: User }) {
  const { id = "" } = useParams();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 15_000 });
  const device = devices.data?.find((d) => d.id === id);
  const admin = user.role === "admin";
  const canChange = admin || user.homeRole === "admin";

  if (devices.data && !device) {
    return (
      <Flex direction="column" gap="4" align="start">
        <BackLink />
        <Heading size="6">Speaker not found</Heading>
        <Text color="gray">It may have been removed from the home.</Text>
      </Flex>
    );
  }
  if (!device) {
    return null;
  }
  return (
    <Flex direction="column" gap="5">
      <Flex direction="column" gap="2" align="start">
        <BackLink />
        <Flex align="center" gap="3" wrap="wrap" width="100%">
          <NameHeading device={device} canChange={canChange} />
          <StatusBadge device={device} />
          <Flex ml="auto" gap="2">
            {canDropIn(device) && <DropInButton device={device} />}
          </Flex>
        </Flex>
        <Text size="2" color="gray">
          {device.online ? "Online now" : `Last seen ${ago(device.last_seen_at)}`}
          {device.firmware && `, version ${device.firmware}`}
        </Text>
      </Flex>

      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Music</Heading>
          <MusicCard device={device} />
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Sound</Heading>
          {device.sound ? (
            <SoundControls device={device} />
          ) : (
            <Text size="2" color="gray">
              The speaker has not reported its volume yet; it does once it comes online.
            </Text>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Details</Heading>
          <Detail label="UUID">
            <span className="mono">{device.id}</span>
          </Detail>
          <Detail label="Version">{device.firmware ?? "unknown"}</Detail>
          <Detail label="Last seen">{ago(device.last_seen_at)}</Detail>
          <Detail label="Added">{ago(device.created_at)}</Detail>
          {admin && <Detail label="Home">{device.owner ?? <Text color="gray">unclaimed</Text>}</Detail>}
        </Flex>
      </Card>

      {canChange && <RemoveCard device={device} admin={admin} />}
    </Flex>
  );
}

function BackLink() {
  return (
    <Link to="/#devices" style={{ color: "inherit", textDecoration: "none" }}>
      <Flex align="center" gap="1">
        <ArrowLeftIcon />
        <Text size="2">Devices</Text>
      </Flex>
    </Link>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex justify="between" gap="4" wrap="wrap">
      <Text size="2" color="gray">
        {label}
      </Text>
      <Text size="2">{children}</Text>
    </Flex>
  );
}

/** The name as a heading; home admins edit it in place. Everything else keys on the UUID, so renaming is safe. */
function NameHeading({ device, canChange }: { device: Device; canChange: boolean }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const rename = useMutation({
    mutationFn: (next: string) => api.updateDevice(device.id, { name: next }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["devices"] });
      setEditing(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      rename.mutate(name.trim());
    }
  };
  if (editing) {
    return (
      <form onSubmit={submit}>
        <Flex gap="2" align="center" wrap="wrap">
          <TextField.Root
            aria-label="Name"
            size="3"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            style={{ minWidth: 220 }}
          />
          <Button type="submit" loading={rename.isPending} disabled={!name.trim()}>
            Save
          </Button>
          <Button type="button" variant="soft" color="gray" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {rename.error && (
            <Text size="2" color="red">
              The name was not saved.
            </Text>
          )}
        </Flex>
      </form>
    );
  }
  return (
    <Flex align="center" gap="2">
      <Heading size="7">{device.name || <span className="mono">{device.id}</span>}</Heading>
      {canChange && (
        <IconButton
          variant="ghost"
          aria-label={`Edit the name of ${device.name || "this speaker"}`}
          title="Edit name"
          onClick={() => {
            setName(device.name);
            setEditing(true);
          }}
        >
          <Pencil1Icon />
        </IconButton>
      )}
    </Flex>
  );
}

/** What the music service plays on this speaker, with play, pause and skip. Polled while the page is open. */
function MusicCard({ device }: { device: Device }) {
  const client = useQueryClient();
  const music = useQuery({ queryKey: ["music"], queryFn: api.music, refetchInterval: 10_000 });
  const control = useMutation({
    mutationFn: (action: MusicAction) => api.controlMusic(action),
    onSuccess: () => client.invalidateQueries({ queryKey: ["music"] }),
  });
  if (!music.data) {
    return music.error ? (
      <Text size="2" color="red">
        The music service did not answer.
      </Text>
    ) : null;
  }
  if (!music.data.connected) {
    return (
      <Text size="2" color="gray">
        No music service is connected. Sign in to Spotify under{" "}
        <Link to="/#connections" style={{ color: "inherit" }}>
          Connections
        </Link>{" "}
        and the assistant plays on this speaker; what is playing shows here.
      </Text>
    );
  }
  const playing = music.data.playing;
  const here = playing !== null && playing.device === device.name;
  if (!playing || !here) {
    return (
      <Text size="2" color="gray">
        Nothing is playing on this speaker.
        {playing?.device && ` Spotify is playing ${playing.track} on ${playing.device}.`} Ask the assistant to play
        something, or pick the speaker in Spotify's device list.
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="3">
      <Flex direction="column" gap="1">
        <Flex align="center" gap="2">
          <Text size="4" weight="medium">
            {playing.track}
          </Text>
          <Badge color={playing.is_playing ? "grass" : "gray"}>{playing.is_playing ? "playing" : "paused"}</Badge>
        </Flex>
        <Text size="2" color="gray">
          {playing.by}
          {playing.album && ` · ${playing.album}`}
        </Text>
      </Flex>
      <Flex gap="2">
        <IconButton
          variant="soft"
          aria-label="Previous track"
          disabled={control.isPending}
          onClick={() => control.mutate("previous")}
        >
          <TrackPreviousIcon />
        </IconButton>
        <IconButton
          variant="solid"
          aria-label={playing.is_playing ? "Pause" : "Play"}
          disabled={control.isPending}
          onClick={() => control.mutate(playing.is_playing ? "pause" : "play")}
        >
          {playing.is_playing ? <PauseIcon /> : <PlayIcon />}
        </IconButton>
        <IconButton
          variant="soft"
          aria-label="Next track"
          disabled={control.isPending}
          onClick={() => control.mutate("next")}
        >
          <TrackNextIcon />
        </IconButton>
      </Flex>
      {control.error && (
        <Text size="2" color="red">
          Spotify did not take that.
        </Text>
      )}
    </Flex>
  );
}

function RemoveCard({ device, admin }: { device: Device; admin: boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api.removeDevice(device.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["devices"] });
      navigate("/#devices");
    },
  });
  return (
    <Card size="3">
      <Flex justify="between" align="center" gap="4" wrap="wrap">
        <Flex direction="column" gap="1">
          <Heading size="4">Remove</Heading>
          <Text size="2" color="gray">
            {admin
              ? "The speaker is deleted; it reappears unclaimed the next time it calls home."
              : "The speaker leaves the home and can be added again with its UUID."}
          </Text>
        </Flex>
        <AlertDialog.Root>
          <AlertDialog.Trigger>
            <Button variant="soft" color="red">
              Remove
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Content maxWidth="420px">
            <AlertDialog.Title>Remove {device.name || "this speaker"}?</AlertDialog.Title>
            <AlertDialog.Description size="2">
              This cannot be undone from here; the speaker keeps running.
            </AlertDialog.Description>
            <Flex gap="3" mt="4" justify="end">
              <AlertDialog.Cancel>
                <Button variant="soft" color="gray">
                  Keep
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" onClick={() => remove.mutate()}>
                  Remove
                </Button>
              </AlertDialog.Action>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>
      </Flex>
    </Card>
  );
}

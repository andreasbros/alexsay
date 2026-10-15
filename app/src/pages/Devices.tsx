import { EnterIcon, PlusIcon } from "@radix-ui/react-icons";
import { AlertDialog, Badge, Button, Dialog, Flex, IconButton, Table, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, api, type Device, type User } from "../api";
import { Section, useSection } from "../components/Section";
import { useDropIn } from "../drop_in";
import { ago, atLeastVersion, DROP_IN_SINCE, isUuid } from "../format";
import { dropInSupported } from "../lib/drop_in";

/** A speaker the browser can drop in on: online, running software that takes drop-ins, from a browser that can carry one. */
export const canDropIn = (device: Pick<Device, "online" | "firmware">, browser = dropInSupported()): boolean =>
  browser && device.online && atLeastVersion(device.firmware, DROP_IN_SINCE);

const ERRORS: Record<string, string> = {
  claimed: "Another account already owns this speaker.",
  exists: "This speaker is already in your list.",
  bad_request: "That is not a UUID. It is printed by `alexsay id` on the speaker.",
};

/** The home's speakers, a section of the Home page. */
export function DevicesSection({ user }: { user: User }) {
  const client = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 30_000 });
  const remove = useMutation({
    mutationFn: api.removeDevice,
    onSuccess: () => client.invalidateQueries({ queryKey: ["devices"] }),
  });
  const admin = user.role === "admin";
  const canChange = admin || user.homeRole === "admin";

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
              <Table.ColumnHeaderCell>UUID</Table.ColumnHeaderCell>
              {admin && <Table.ColumnHeaderCell>Home</Table.ColumnHeaderCell>}
              <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Last seen</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {devices.data.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                admin={admin}
                canChange={canChange}
                onRemove={() => remove.mutate(d.id)}
              />
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Section>
  );
}

function DeviceRow({
  device,
  admin,
  canChange,
  onRemove,
}: {
  device: Device;
  admin: boolean;
  canChange: boolean;
  onRemove: () => void;
}) {
  return (
    <Table.Row align="center">
      <Table.RowHeaderCell>
        <Flex align="center" gap="2">
          {canDropIn(device) && <DropInButton device={device} />}
          {device.name || <Text color="gray">unnamed</Text>}
        </Flex>
      </Table.RowHeaderCell>
      <Table.Cell>
        <span className="mono">{device.id}</span>
      </Table.Cell>
      {admin && <Table.Cell>{device.owner ?? <Text color="gray">unclaimed</Text>}</Table.Cell>}
      <Table.Cell>
        <Badge color={device.online ? "grass" : "gray"}>{device.online ? "online" : "offline"}</Badge>
      </Table.Cell>
      <Table.Cell>{ago(device.last_seen_at)}</Table.Cell>
      <Table.Cell justify="end">
        {canChange && (
          <AlertDialog.Root>
            <AlertDialog.Trigger>
              <Button size="1" variant="ghost" color="red">
                Remove
              </Button>
            </AlertDialog.Trigger>
            <AlertDialog.Content maxWidth="420px">
              <AlertDialog.Title>Remove {device.name || "this speaker"}?</AlertDialog.Title>
              <AlertDialog.Description size="2">
                {admin
                  ? "The speaker is deleted; it reappears unclaimed the next time it calls home."
                  : "The speaker leaves your account and can be added again with its UUID."}
              </AlertDialog.Description>
              <Flex gap="3" mt="4" justify="end">
                <AlertDialog.Cancel>
                  <Button variant="soft" color="gray">
                    Keep
                  </Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button color="red" onClick={onRemove}>
                    Remove
                  </Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        )}
      </Table.Cell>
    </Table.Row>
  );
}

/** Asks before dropping in: the speaker will announce the caller to whoever is in the room. */
function DropInButton({ device }: { device: Device }) {
  const dropIn = useDropIn();
  const name = device.name || "this speaker";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <IconButton size="1" variant="soft" aria-label={`Drop in on ${name}`} title="Drop in">
          <EnterIcon />
        </IconButton>
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

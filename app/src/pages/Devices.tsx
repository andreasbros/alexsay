import { PlusIcon } from "@radix-ui/react-icons";
import { AlertDialog, Badge, Button, Card, Dialog, Flex, Heading, Table, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, api, type Device, type User } from "../api";
import { ago, isUuid } from "../format";

const ERRORS: Record<string, string> = {
  claimed: "Another account already owns this speaker.",
  exists: "This speaker is already in your list.",
  bad_request: "That is not a UUID. It is printed by `alexsay id` on the speaker.",
};

export function Devices({ user }: { user: User }) {
  const client = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 30_000 });
  const remove = useMutation({
    mutationFn: api.removeDevice,
    onSuccess: () => client.invalidateQueries({ queryKey: ["devices"] }),
  });
  const admin = user.role === "admin";

  return (
    <Flex direction="column" gap="5">
      <Flex align="center" justify="between">
        <Heading size="7">Devices</Heading>
        <AddDevice />
      </Flex>
      {devices.data?.length === 0 && (
        <Card size="3">
          <Text color="gray">
            No speakers yet. Add one with the UUID it prints on its console, then it will show up here as soon as it
            calls home.
          </Text>
        </Card>
      )}
      {devices.data && devices.data.length > 0 && (
        <Card size="1">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>UUID</Table.ColumnHeaderCell>
                {admin && <Table.ColumnHeaderCell>Owner</Table.ColumnHeaderCell>}
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Last seen</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {devices.data.map((d) => (
                <DeviceRow key={d.id} device={d} admin={admin} onRemove={() => remove.mutate(d.id)} />
              ))}
            </Table.Body>
          </Table.Root>
        </Card>
      )}
    </Flex>
  );
}

function DeviceRow({ device, admin, onRemove }: { device: Device; admin: boolean; onRemove: () => void }) {
  return (
    <Table.Row align="center">
      <Table.RowHeaderCell>{device.name || <Text color="gray">unnamed</Text>}</Table.RowHeaderCell>
      <Table.Cell>
        <span className="mono">{device.id}</span>
      </Table.Cell>
      {admin && <Table.Cell>{device.owner ?? <Text color="gray">unclaimed</Text>}</Table.Cell>}
      <Table.Cell>
        <Badge color={device.online ? "grass" : "gray"}>{device.online ? "online" : "offline"}</Badge>
      </Table.Cell>
      <Table.Cell>{ago(device.last_seen_at)}</Table.Cell>
      <Table.Cell justify="end">
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
      </Table.Cell>
    </Table.Row>
  );
}

function AddDevice() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addDevice(id.trim().toLowerCase(), name.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["devices"] });
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
              placeholder="Name (optional)"
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
              <Button type="submit" loading={add.isPending} disabled={!isUuid(id)}>
                Add
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

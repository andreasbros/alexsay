import { AlertDialog, Badge, Button, Card, Flex, Heading, Select, Switch, Table, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type Role, type User } from "../api";

/** Server admins only: the server's switches, then every account, its role and its home's speakers. */
export function Users({ user: me }: { user: User }) {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const refresh = () => client.invalidateQueries({ queryKey: ["users"] });
  const setRole = useMutation({
    mutationFn: ({ username, role }: { username: string; role: Role }) => api.setRole(username, role),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeUser, onSuccess: refresh });
  const error =
    setRole.error instanceof ApiError && setRole.error.code === "last_admin" ? "Keep at least one admin." : null;

  return (
    <Flex direction="column" gap="5">
      <Heading size="7">Users</Heading>
      <ServerCard />
      {error && (
        <Text color="red" size="2">
          {error}
        </Text>
      )}
      <Card size="1">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Username</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Devices</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {users.data?.map((u) => (
              <Table.Row key={u.username} align="center">
                <Table.RowHeaderCell>{u.username}</Table.RowHeaderCell>
                <Table.Cell>
                  <Text color="gray">{u.email ?? ""}</Text>
                </Table.Cell>
                <Table.Cell>
                  {u.username === me.username ? (
                    <Badge color="indigo">{u.role}</Badge>
                  ) : (
                    <Select.Root
                      value={u.role}
                      onValueChange={(role) =>
                        setRole.mutate({ username: u.username, role: role === "admin" ? "admin" : "user" })
                      }
                    >
                      <Select.Trigger variant="soft" aria-label={`Role of ${u.username}`} />
                      <Select.Content>
                        <Select.Item value="user">user</Select.Item>
                        <Select.Item value="admin">admin</Select.Item>
                      </Select.Content>
                    </Select.Root>
                  )}
                </Table.Cell>
                <Table.Cell>{u.devices ?? 0}</Table.Cell>
                <Table.Cell justify="end">
                  {u.username !== me.username && (
                    <AlertDialog.Root>
                      <AlertDialog.Trigger>
                        <Button size="1" variant="ghost" color="red">
                          Remove
                        </Button>
                      </AlertDialog.Trigger>
                      <AlertDialog.Content maxWidth="420px">
                        <AlertDialog.Title>Remove {u.username}?</AlertDialog.Title>
                        <AlertDialog.Description size="2">
                          Their account is deleted. If they made a home, it goes too, with everything in it; its other
                          people go back to their own homes.
                        </AlertDialog.Description>
                        <Flex gap="3" mt="4" justify="end">
                          <AlertDialog.Cancel>
                            <Button variant="soft" color="gray">
                              Keep
                            </Button>
                          </AlertDialog.Cancel>
                          <AlertDialog.Action>
                            <Button color="red" onClick={() => remove.mutate(u.username)}>
                              Remove
                            </Button>
                          </AlertDialog.Action>
                        </Flex>
                      </AlertDialog.Content>
                    </AlertDialog.Root>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>
    </Flex>
  );
}

function ServerCard() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["server"], queryFn: api.serverSettings });
  const update = useMutation({
    mutationFn: api.updateServerSettings,
    onSuccess: (data) => {
      client.setQueryData(["server"], data);
      void client.invalidateQueries({ queryKey: ["auth-config"] });
    },
  });
  const mail = settings.data?.mail ?? null;
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Heading size="4">Server</Heading>
        <Text as="label" size="2">
          <Flex gap="3" align="center">
            <Switch
              checked={
                update.isPending ? (update.variables?.email_login ?? false) : (settings.data?.email_login ?? false)
              }
              onCheckedChange={(on) => update.mutate({ email_login: on })}
              disabled={!mail}
              aria-label="Email sign-in"
            />
            Email sign-in and invitations
          </Flex>
        </Text>
        <Text size="2" color="gray">
          {mail
            ? `Sign-in codes and home invitations go out as ${mail.from} through ${mail.through}.`
            : "This server has no way to send email configured (SMTP relay or Cloudflare Email Service)."}
        </Text>
      </Flex>
    </Card>
  );
}

import { AlertDialog, Badge, Button, Card, Flex, Heading, Select, Table, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, api, type HomeRole, type Invite, type InviteStatus, type User } from "../api";

const STATUS_COLORS: Record<InviteStatus, "amber" | "green" | "gray" | "red"> = {
  pending: "amber",
  accepted: "green",
  revoked: "gray",
  expired: "red",
};

const ERRORS: Record<string, string> = {
  already_member: "That person is already in this home.",
  email_login_off: "Email is switched off on this server, so invitations cannot be sent.",
  creator: "The person who made the home always stays its admin.",
  bad_request: "Check the address.",
};

function errorText(error: Error | null): string | null {
  if (!error) {
    return null;
  }
  return error instanceof ApiError ? (ERRORS[error.code] ?? error.message) : error.message;
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The home everything belongs to: its name, who is in it, and (for admins) who has been invited. */
export function HomePage({ user }: { user: User }) {
  const client = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: api.home });
  const refresh = () => client.invalidateQueries({ queryKey: ["home"] });
  const [name, setName] = useState("");
  useEffect(() => setName(home.data?.name ?? ""), [home.data?.name]);
  const rename = useMutation({ mutationFn: api.renameHome, onSuccess: refresh });
  const setRole = useMutation({
    mutationFn: ({ username, role }: { username: string; role: HomeRole }) => api.setMemberRole(username, role),
    onSuccess: refresh,
  });
  const removeMember = useMutation({ mutationFn: api.removeMember, onSuccess: refresh });
  const leave = useMutation({
    mutationFn: api.leaveHome,
    onSuccess: () => {
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      void client.invalidateQueries({ queryKey: ["session"] });
    },
  });

  const data = home.data;
  if (!data) {
    return <Heading size="7">Home</Heading>;
  }
  const admin = data.role === "admin";
  const memberError = errorText(setRole.error ?? removeMember.error);

  return (
    <Flex direction="column" gap="5">
      <Heading size="7">{data.name}</Heading>
      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">Name</Heading>
          <Text size="2" color="gray">
            Everything here belongs to the home: its speakers, connections, memories, contacts, alarms and
            conversations. Everyone in it shares them.
          </Text>
          {admin ? (
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                rename.mutate(name.trim());
              }}
            >
              <Flex gap="3" align="end" wrap="wrap">
                <TextField.Root
                  aria-label="Home name"
                  value={name}
                  maxLength={64}
                  onChange={(e) => setName(e.target.value)}
                  style={{ minWidth: 220 }}
                />
                <Button type="submit" variant="soft" loading={rename.isPending} disabled={!name.trim()}>
                  Rename
                </Button>
              </Flex>
            </form>
          ) : (
            <Text size="2">
              You are {data.role === "admin" ? "an admin" : "a member"} of {data.name}.
            </Text>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading size="4">People</Heading>
          {memberError && (
            <Text color="red" size="2">
              {memberError}
            </Text>
          )}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.members.map((m) => (
                <Table.Row key={m.username} align="center">
                  <Table.RowHeaderCell>
                    <Flex direction="column">
                      <Text>{m.username}</Text>
                      {m.email && (
                        <Text size="1" color="gray">
                          {m.email}
                        </Text>
                      )}
                    </Flex>
                  </Table.RowHeaderCell>
                  <Table.Cell>
                    {admin && !m.creator && m.username !== user.username ? (
                      <Select.Root
                        value={m.role}
                        onValueChange={(role) =>
                          setRole.mutate({ username: m.username, role: role === "admin" ? "admin" : "user" })
                        }
                      >
                        <Select.Trigger variant="soft" aria-label={`Role of ${m.username}`} />
                        <Select.Content>
                          <Select.Item value="user">user</Select.Item>
                          <Select.Item value="admin">admin</Select.Item>
                        </Select.Content>
                      </Select.Root>
                    ) : (
                      <Badge color={m.role === "admin" ? "indigo" : "gray"}>{m.creator ? "owner" : m.role}</Badge>
                    )}
                  </Table.Cell>
                  <Table.Cell justify="end">
                    {admin && !m.creator && m.username !== user.username && (
                      <Confirm
                        label="Remove"
                        title={`Remove ${m.username}?`}
                        detail="They go back to their own home and lose access to this one."
                        onConfirm={() => removeMember.mutate(m.username)}
                      />
                    )}
                    {!data.creator && m.username === user.username && (
                      <Confirm
                        label="Leave"
                        title={`Leave ${data.name}?`}
                        detail="You go back to your own home. Someone has to invite you again to come back."
                        onConfirm={() => leave.mutate()}
                      />
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Flex>
      </Card>

      {admin && <Invitations canInvite={data.can_invite} invites={data.invites} onChange={refresh} />}
    </Flex>
  );
}

function Invitations({
  canInvite,
  invites,
  onChange,
}: {
  canInvite: boolean;
  invites: Invite[];
  onChange: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<HomeRole>("user");
  const invite = useMutation({
    mutationFn: () => api.invite(email.trim(), role),
    onSuccess: () => {
      setEmail("");
      onChange();
    },
  });
  const resend = useMutation({ mutationFn: api.resendInvite, onSuccess: onChange });
  const remove = useMutation({ mutationFn: api.removeInvite, onSuccess: onChange });
  const error = errorText(invite.error ?? resend.error ?? remove.error);

  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Heading size="4">Invitations</Heading>
        {canInvite ? (
          <>
            <Text size="2" color="gray">
              The link in the email signs them in (making an account if they have none) and puts them in this home. It
              works for 3 days.
            </Text>
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                invite.mutate();
              }}
            >
              <Flex gap="3" align="end" wrap="wrap">
                <TextField.Root
                  type="email"
                  aria-label="Email to invite"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={{ minWidth: 240 }}
                />
                <Select.Root value={role} onValueChange={(r) => setRole(r === "admin" ? "admin" : "user")}>
                  <Select.Trigger aria-label="Role" />
                  <Select.Content>
                    <Select.Item value="user">user</Select.Item>
                    <Select.Item value="admin">admin</Select.Item>
                  </Select.Content>
                </Select.Root>
                <Button type="submit" loading={invite.isPending}>
                  Invite
                </Button>
              </Flex>
            </form>
          </>
        ) : (
          <Text size="2" color="gray">
            Invitations go by email, which this server has switched off. A server admin can switch it on under Users.
          </Text>
        )}
        {error && (
          <Text color="red" size="2">
            {error}
          </Text>
        )}
        {invites.length > 0 && (
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {invites.map((i) => (
                <Table.Row key={i.id} align="center">
                  <Table.RowHeaderCell>
                    <Flex direction="column">
                      <Text>{i.email}</Text>
                      <Text size="1" color="gray">
                        by {i.invited_by}, {when(i.created_at)}
                      </Text>
                    </Flex>
                  </Table.RowHeaderCell>
                  <Table.Cell>{i.role}</Table.Cell>
                  <Table.Cell>
                    <Flex direction="column" gap="1">
                      <Badge color={STATUS_COLORS[i.status]} style={{ width: "fit-content" }}>
                        {i.status}
                      </Badge>
                      <Text size="1" color="gray">
                        {i.status === "accepted" && i.accepted_at
                          ? `${i.accepted_by ?? ""}, ${when(i.accepted_at)}`
                          : i.status === "pending"
                            ? `until ${when(i.expires_at)}`
                            : ""}
                      </Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell justify="end">
                    <Flex gap="3" justify="end">
                      {(i.status === "pending" || i.status === "expired") && canInvite && (
                        <Button size="1" variant="ghost" loading={resend.isPending} onClick={() => resend.mutate(i.id)}>
                          Resend
                        </Button>
                      )}
                      <Button size="1" variant="ghost" color="red" onClick={() => remove.mutate(i.id)}>
                        Delete
                      </Button>
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </Flex>
    </Card>
  );
}

function Confirm({
  label,
  title,
  detail,
  onConfirm,
}: {
  label: string;
  title: string;
  detail: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button size="1" variant="ghost" color="red">
          {label}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content maxWidth="420px">
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description size="2">{detail}</AlertDialog.Description>
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button color="red" onClick={onConfirm}>
              {label}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

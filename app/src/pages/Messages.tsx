import { ChatBubbleIcon, CheckIcon, MobileIcon } from "@radix-ui/react-icons";
import { Badge, Button, Card, Dialog, Flex, Heading, Tabs, Text, TextArea } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, api, type MessageItem, type Notification, type RecentCall } from "../api";
import { ago } from "../format";

const REFRESH_MS = 15_000;

const KIND_LABEL: Record<Notification["kind"], string> = {
  call: "Missed call",
  message: "Text",
  note: "Message taken",
};

/** What came in: notifications to deal with, the texts either way, the calls either way. */
export function MessagesPage() {
  const client = useQueryClient();
  const notifications = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.notifications(),
    refetchInterval: REFRESH_MS,
  });
  const messages = useQuery({ queryKey: ["messages"], queryFn: () => api.messages(), refetchInterval: REFRESH_MS });
  const calls = useQuery({ queryKey: ["calls"], queryFn: () => api.recentCalls(50), refetchInterval: REFRESH_MS });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(ids),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const [reply, setReply] = useState<{ phone: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const callBack = useMutation({
    mutationFn: (phone: string) => api.callNumber(phone),
    onSuccess: (placed) => setNotice(`Calling ${placed.contact ?? placed.phone}: your mobile rings first.`),
    onError: (err) => setNotice(describe(err)),
  });
  const unread = notifications.data?.unread ?? 0;

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" justify="between" wrap="wrap" gap="3">
        <Heading size="6">Messages</Heading>
        {notice && (
          <Text size="2" color="gray">
            {notice}
          </Text>
        )}
      </Flex>
      <Tabs.Root defaultValue="notifications">
        <Tabs.List>
          <Tabs.Trigger value="notifications">Notifications{unread > 0 && <Badge ml="2">{unread}</Badge>}</Tabs.Trigger>
          <Tabs.Trigger value="sms">SMS</Tabs.Trigger>
          <Tabs.Trigger value="calls">Calls</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="notifications">
          <Flex direction="column" gap="3" mt="3">
            {unread > 0 && (
              <Flex justify="end">
                <Button size="1" variant="soft" onClick={() => markRead.mutate(undefined)} loading={markRead.isPending}>
                  <CheckIcon /> Mark all read
                </Button>
              </Flex>
            )}
            {notifications.data?.notifications.length === 0 && (
              <Text size="2" color="gray">
                Nothing yet. Texts received, calls missed and messages the assistant takes on calls show up here, and
                the speakers read them out.
              </Text>
            )}
            {notifications.data?.notifications.map((n) => (
              <Card key={n.id} size="2" style={{ opacity: n.read_at ? 0.7 : 1 }}>
                <Flex direction="column" gap="2">
                  <Flex align="center" justify="between" gap="3" wrap="wrap">
                    <Flex align="center" gap="2">
                      <Badge color={n.kind === "call" ? "amber" : n.kind === "note" ? "indigo" : "grass"}>
                        {KIND_LABEL[n.kind]}
                      </Badge>
                      <Text weight="medium">{n.title}</Text>
                    </Flex>
                    <Text size="1" color="gray">
                      {ago(n.at)}
                    </Text>
                  </Flex>
                  {n.body && <Text size="2">{n.body}</Text>}
                  <Flex gap="2" wrap="wrap">
                    {n.phone && (
                      <>
                        <Button
                          size="1"
                          variant="soft"
                          onClick={() => setReply({ phone: n.phone, name: n.contact ?? n.phone })}
                        >
                          <ChatBubbleIcon /> Reply
                        </Button>
                        <Button
                          size="1"
                          variant="soft"
                          onClick={() => callBack.mutate(n.phone)}
                          loading={callBack.isPending}
                        >
                          <MobileIcon /> Call back
                        </Button>
                      </>
                    )}
                    {!n.read_at && (
                      <Button size="1" variant="ghost" onClick={() => markRead.mutate([n.id])}>
                        <CheckIcon /> Mark read
                      </Button>
                    )}
                  </Flex>
                </Flex>
              </Card>
            ))}
          </Flex>
        </Tabs.Content>
        <Tabs.Content value="sms">
          <Flex direction="column" gap="3" mt="3">
            {messages.data?.length === 0 && (
              <Text size="2" color="gray">
                No texts yet.
              </Text>
            )}
            {messages.data?.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                onReply={() => setReply({ phone: m.phone, name: m.contact ?? m.phone })}
              />
            ))}
          </Flex>
        </Tabs.Content>
        <Tabs.Content value="calls">
          <Flex direction="column" gap="3" mt="3">
            {calls.data?.length === 0 && (
              <Text size="2" color="gray">
                No calls yet.
              </Text>
            )}
            {calls.data?.filter(isPerson).map((c) => (
              <CallRow key={c.id} call={c} onCallBack={() => callBack.mutate(c.phone)} />
            ))}
          </Flex>
        </Tabs.Content>
      </Tabs.Root>
      {reply && (
        <ReplyDialog
          to={reply}
          onClose={() => setReply(null)}
          onSent={() => {
            setReply(null);
            setNotice(`Sent to ${reply.name}.`);
            void client.invalidateQueries({ queryKey: ["messages"] });
          }}
        />
      )}
    </Flex>
  );
}

/** The people side of a call: the user's own legs and the assistant's say nothing new. */
const isPerson = (c: RecentCall) =>
  c.role === "" || (c.role === "guest" && !["browser", "speaker", "assistant"].includes(c.phone));

function MessageRow({ message, onReply }: { message: MessageItem; onReply: () => void }) {
  return (
    <Card size="2">
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <Badge color={message.direction === "in" ? "grass" : "gray"}>
              {message.direction === "in" ? "Received" : "Sent"}
              {message.channel === "whatsapp" ? " on WhatsApp" : ""}
            </Badge>
            <Text weight="medium">{message.contact ?? message.phone}</Text>
          </Flex>
          <Text size="1" color="gray">
            {ago(message.at)}
          </Text>
        </Flex>
        <Text size="2">{message.body}</Text>
        <Flex>
          <Button size="1" variant="soft" onClick={onReply}>
            <ChatBubbleIcon /> Reply
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

function CallRow({ call, onCallBack }: { call: RecentCall; onCallBack: () => void }) {
  const missed = call.direction === "in" && ["no-answer", "rejected", "busy", "canceled"].includes(call.status);
  return (
    <Card size="2">
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex align="center" gap="2">
          <Badge color={missed ? "amber" : call.direction === "in" ? "grass" : "gray"}>
            {missed ? "Missed" : call.direction === "in" ? "Incoming" : "Outgoing"}
          </Badge>
          <Text weight="medium">{call.contact ?? call.phone}</Text>
          <Text size="1" color="gray">
            {call.status}
          </Text>
        </Flex>
        <Flex align="center" gap="3">
          <Text size="1" color="gray">
            {ago(call.at)}
          </Text>
          <Button size="1" variant="soft" onClick={onCallBack}>
            <MobileIcon /> Call back
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

function ReplyDialog({
  to,
  onClose,
  onSent,
}: {
  to: { phone: string; name: string };
  onClose: () => void;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const send = useMutation({ mutationFn: () => api.sendMessageTo(to.phone, body.trim()), onSuccess: onSent });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate();
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Reply to {to.name}</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          A text from your number to {to.phone}.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3" mt="4">
            <TextArea
              aria-label="Message"
              placeholder="Your message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              autoFocus
              required
            />
            {send.error && (
              <Text color="red" size="2">
                {describe(send.error)}
              </Text>
            )}
            <Flex justify="end" gap="2">
              <Button type="button" variant="soft" color="gray" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
                Send
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    return err.detail ?? err.code;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

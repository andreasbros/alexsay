import { ChevronDownIcon, PlusIcon } from "@radix-ui/react-icons";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Flex,
  Heading,
  IconButton,
  SegmentedControl,
  Select,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type Conversation, MEMORY_CATEGORIES, type Memory, type MemoryCategory } from "../api";
import { ago } from "../format";
import { Contacts } from "./Contacts";

const CATEGORY_COLOURS: Record<MemoryCategory, "red" | "indigo" | "grass" | "amber" | "cyan" | "pink" | "gray"> = {
  important: "red",
  preferences: "indigo",
  people: "grass",
  home: "amber",
  routines: "cyan",
  notes: "pink",
  facts: "gray",
};

type Section = "memories" | "conversations" | "contacts";

/** What the assistant knows about the user: memories, every conversation, and the phone book. */
export function MemoryPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab");
  const section: Section = tab === "contacts" || tab === "conversations" ? tab : "memories";
  return (
    <Flex direction="column" gap="5">
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Heading size="7">Memory</Heading>
        <SegmentedControl.Root value={section} onValueChange={(v) => setParams(v === "memories" ? {} : { tab: v })}>
          <SegmentedControl.Item value="memories">Memories</SegmentedControl.Item>
          <SegmentedControl.Item value="conversations">Conversations</SegmentedControl.Item>
          <SegmentedControl.Item value="contacts">Contacts</SegmentedControl.Item>
        </SegmentedControl.Root>
      </Flex>
      {section === "memories" && <Memories />}
      {section === "conversations" && <Conversations />}
      {section === "contacts" && <Contacts />}
    </Flex>
  );
}

function Memories() {
  const client = useQueryClient();
  const memories = useQuery({ queryKey: ["memories"], queryFn: api.memories });
  const refresh = () => client.invalidateQueries({ queryKey: ["memories"] });
  const remove = useMutation({ mutationFn: api.removeMemory, onSuccess: refresh });
  const recategorise = useMutation({
    mutationFn: ({ id, category }: { id: string; category: MemoryCategory }) => api.updateMemory(id, { category }),
    onSuccess: refresh,
  });
  return (
    <Flex direction="column" gap="4">
      <Flex align="center" justify="between" gap="3">
        <Text size="2" color="gray">
          Written by the assistant after each conversation and by you here. It reads all of this when a conversation
          starts.
        </Text>
        <AddMemory onAdded={refresh} />
      </Flex>
      {memories.data?.length === 0 && (
        <Card size="3">
          <Text color="gray">Nothing remembered yet. Talk to the assistant, or add a note.</Text>
        </Card>
      )}
      {MEMORY_CATEGORIES.map((category) => {
        const items = memories.data?.filter((m) => m.category === category) ?? [];
        if (items.length === 0) {
          return null;
        }
        return (
          <Card key={category} size="2">
            <Flex direction="column" gap="2">
              <Badge color={CATEGORY_COLOURS[category]} style={{ alignSelf: "flex-start" }}>
                {category}
              </Badge>
              {items.map((m) => (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  onRemove={() => remove.mutate(m.id)}
                  onMove={(next) => recategorise.mutate({ id: m.id, category: next })}
                />
              ))}
            </Flex>
          </Card>
        );
      })}
    </Flex>
  );
}

function MemoryRow({
  memory,
  onRemove,
  onMove,
}: {
  memory: Memory;
  onRemove: () => void;
  onMove: (category: MemoryCategory) => void;
}) {
  return (
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Text size="2" style={{ flex: 1, minWidth: 200 }}>
        {memory.content}
      </Text>
      <Flex align="center" gap="2">
        <Text size="1" color="gray">
          {ago(memory.updated_at)}
        </Text>
        <Select.Root size="1" value={memory.category} onValueChange={(v) => onMove(v as MemoryCategory)}>
          <Select.Trigger variant="ghost" aria-label={`Category of ${memory.content}`} />
          <Select.Content>
            {MEMORY_CATEGORIES.map((c) => (
              <Select.Item key={c} value={c}>
                {c}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Button size="1" variant="ghost" color="red" onClick={onRemove}>
          Forget
        </Button>
      </Flex>
    </Flex>
  );
}

function AddMemory({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<MemoryCategory>("preferences");
  const [content, setContent] = useState("");
  const add = useMutation({
    mutationFn: () => api.addMemory(category, content.trim()),
    onSuccess: () => {
      onAdded();
      setOpen(false);
      setContent("");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button>
          <PlusIcon /> Add memory
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Add memory</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          One short sentence the assistant should keep in mind.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3" mt="4">
            <Select.Root value={category} onValueChange={(v) => setCategory(v as MemoryCategory)}>
              <Select.Trigger aria-label="Category" />
              <Select.Content>
                {MEMORY_CATEGORIES.map((c) => (
                  <Select.Item key={c} value={c}>
                    {c}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <TextArea
              aria-label="Memory"
              placeholder="e.g. The hall light stays on at night"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
            <Flex justify="end" gap="2">
              <Dialog.Close>
                <Button variant="soft" color="gray" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={add.isPending} disabled={!content.trim()}>
                Save
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Conversations() {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const conversations = useQuery({ queryKey: ["conversations", query], queryFn: () => api.conversations(query) });
  const remove = useMutation({
    mutationFn: api.removeConversation,
    onSuccess: () => client.invalidateQueries({ queryKey: ["conversations"] }),
  });
  return (
    <Flex direction="column" gap="4">
      <Flex align="center" justify="end" gap="3" wrap="wrap">
        <TextField.Root
          placeholder="Search"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 200 }}
        />
      </Flex>
      {conversations.data?.length === 0 && (
        <Text size="2" color="gray">
          No conversations {query ? "match" : "yet"}.
        </Text>
      )}
      {conversations.data?.map((c) => (
        <ConversationCard key={c.id} conversation={c} onRemove={() => remove.mutate(c.id)} />
      ))}
    </Flex>
  );
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function ConversationCard({ conversation, onRemove }: { conversation: Conversation; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["conversation", conversation.id],
    queryFn: () => api.conversation(conversation.id),
    enabled: open,
  });
  const minutes = conversation.ended_at
    ? Math.max(1, Math.round((conversation.ended_at - conversation.started_at) / 60_000))
    : null;
  return (
    <Card size="2">
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3">
          <Flex align="center" gap="2" wrap="wrap">
            <Text size="2" weight="medium">
              {when(conversation.started_at)}
            </Text>
            <Badge color={conversation.source === "device" ? "amber" : "gray"}>{conversation.source}</Badge>
            <Text size="1" color="gray">
              {conversation.turn_count} turns{minutes !== null ? `, ${minutes} min` : ""}
            </Text>
          </Flex>
          <Flex align="center" gap="2">
            <Button size="1" variant="ghost" color="red" onClick={onRemove}>
              Delete
            </Button>
            <IconButton
              variant="ghost"
              color="gray"
              size="1"
              aria-label={open ? "Hide transcript" : "Show transcript"}
              onClick={() => setOpen((o) => !o)}
            >
              <ChevronDownIcon style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
            </IconButton>
          </Flex>
        </Flex>
        <Text size="2" color={conversation.summary ? undefined : "gray"}>
          {conversation.summary ?? (conversation.ended_at ? "No summary." : "In progress.")}
        </Text>
        {open && detail.data && (
          <Flex direction="column" gap="1" mt="2" className="activity-list">
            {detail.data.turns.map((t) => (
              <Text
                key={`${t.at}-${t.role}-${t.text.slice(0, 40)}`}
                size="1"
                className={t.role === "tool" ? "mono" : undefined}
                color={t.role === "user" ? undefined : "gray"}
              >
                <b>{t.role}</b> {t.text}
              </Text>
            ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

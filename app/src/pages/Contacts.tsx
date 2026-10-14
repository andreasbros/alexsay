import {
  ChatBubbleIcon,
  ChevronDownIcon,
  MobileIcon,
  Pencil1Icon,
  PlusIcon,
  StarFilledIcon,
  StarIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  IconButton,
  Select,
  Switch,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import { ApiError, api, type Channel, type Contact, type ContactChanges, type NewContact } from "../api";
import { CONTACTS_HELP, HelpDialog } from "../components/HelpDialog";
import { ago } from "../format";
import { canPickContacts, parseVcf, pickContacts } from "../lib/contacts";

interface Notice {
  tone: "red" | "grass";
  text: string;
}

/** The phone book the assistant dials from: imported from the phone or a vCard, searchable, starred. */
export function Contacts() {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useState(false);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<Notice | null>(null);
  const contacts = useQuery({
    queryKey: ["contacts", query, favourites, page],
    queryFn: () => api.contacts(query, page, favourites),
    placeholderData: keepPreviousData,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["contacts"] });
  const imported = useMutation({
    mutationFn: api.importContacts,
    onSuccess: (result) => {
      refresh();
      setNotice({
        tone: "grass",
        text: `Imported ${result.imported}, updated ${result.updated}${
          result.skipped ? `, skipped ${result.skipped} without a usable number` : ""
        }.`,
      });
    },
    onError: (err) => setNotice({ tone: "red", text: explain(err) }),
  });
  const star = useMutation({
    mutationFn: ({ id, favourite }: { id: string; favourite: boolean }) => api.updateContact(id, { favourite }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeContact, onSuccess: refresh });
  const fileInput = useRef<HTMLInputElement>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    const parsed = parseVcf(await readText(file));
    if (parsed.length === 0) {
      setNotice({ tone: "red", text: "No contacts with phone numbers were found in that file." });
      return;
    }
    imported.mutate(parsed);
  };
  const pick = async () => {
    try {
      const picked = await pickContacts();
      if (picked.length > 0) {
        imported.mutate(picked);
      }
    } catch (err) {
      setNotice({ tone: "red", text: explain(err) });
    }
  };
  const search = (value: string) => {
    setQuery(value);
    setPage(1);
  };
  const total = contacts.data?.total ?? 0;
  const pageSize = contacts.data?.page_size ?? 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex align="center" gap="3" wrap="wrap">
          <TextField.Root
            placeholder="Search name or number"
            aria-label="Search contacts"
            value={query}
            onChange={(e) => search(e.target.value)}
            style={{ minWidth: 220 }}
          />
          <Text as="label" size="2">
            <Flex align="center" gap="2">
              <Switch
                checked={favourites}
                onCheckedChange={(on) => {
                  setFavourites(on);
                  setPage(1);
                }}
                aria-label="Favourites only"
              />
              Favourites
            </Flex>
          </Text>
        </Flex>
        <Flex align="center" gap="2" wrap="wrap">
          <HelpDialog {...CONTACTS_HELP} />
          {canPickContacts() && (
            <Button variant="soft" onClick={pick} loading={imported.isPending}>
              <MobileIcon /> Import from phone
            </Button>
          )}
          <Button variant="soft" onClick={() => fileInput.current?.click()} loading={imported.isPending}>
            <UploadIcon /> Import vCard
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            aria-label="vCard file"
            onChange={onFile}
            style={{ display: "none" }}
          />
          <AddContact onAdded={refresh} />
        </Flex>
      </Flex>
      <Text size="2" color="gray">
        Names and numbers only, kept for the assistant to call and message people. Export a .vcf from Contacts on an
        iPhone or from Google Contacts to import on a computer.
      </Text>
      {notice && (
        <Callout.Root color={notice.tone} size="1" role="status">
          <Callout.Text>{notice.text}</Callout.Text>
        </Callout.Root>
      )}
      {contacts.data?.contacts.length === 0 && (
        <Card size="3">
          <Text color="gray">
            {query || favourites ? "No contacts match." : "No contacts yet. Import them from your phone or add one."}
          </Text>
        </Card>
      )}
      {contacts.data && contacts.data.contacts.length > 0 && (
        <Card size="2">
          <Flex direction="column">
            {contacts.data.contacts.map((contact, index) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                first={index === 0}
                onStar={(favourite) => star.mutate({ id: contact.id, favourite })}
                onRemove={() => remove.mutate(contact.id)}
                onNotice={setNotice}
                onSaved={refresh}
              />
            ))}
          </Flex>
        </Card>
      )}
      {total > pageSize && (
        <Flex align="center" justify="between" gap="3">
          <Text size="2" color="gray">
            Page {page} of {pages} · {total} contacts
          </Text>
          <Flex gap="2">
            <Button size="1" variant="soft" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button size="1" variant="soft" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </Flex>
        </Flex>
      )}
    </Flex>
  );
}

function ContactRow({
  contact,
  first,
  onStar,
  onRemove,
  onNotice,
  onSaved,
}: {
  contact: Contact;
  first: boolean;
  onStar: (favourite: boolean) => void;
  onRemove: () => void;
  onNotice: (notice: Notice) => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["contact", contact.id],
    queryFn: () => api.contact(contact.id),
    enabled: open,
  });
  const callMutation = useMutation({
    mutationFn: () => api.placeCall(contact.id),
    onSuccess: () =>
      onNotice({ tone: "grass", text: `Calling ${contact.name}: your phone rings first, then connects.` }),
    onError: (err) => onNotice({ tone: "red", text: `${contact.name} could not be called. ${explain(err)}` }),
  });
  return (
    <Flex
      direction="column"
      gap="2"
      py="2"
      style={first ? undefined : { borderTop: "1px solid var(--gray-a4)" }}
      data-testid="contact"
    >
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex align="center" gap="2" style={{ flex: 1, minWidth: 220 }}>
          <IconButton
            variant="ghost"
            color={contact.favourite ? "amber" : "gray"}
            aria-label={contact.favourite ? `Unfavourite ${contact.name}` : `Favourite ${contact.name}`}
            aria-pressed={contact.favourite}
            onClick={() => onStar(!contact.favourite)}
          >
            {contact.favourite ? <StarFilledIcon /> : <StarIcon />}
          </IconButton>
          <Flex direction="column">
            <Flex align="center" gap="2">
              <Text size="2" weight="medium">
                {contact.name}
              </Text>
              {contact.label && (
                <Badge color="gray" size="1">
                  {contact.label}
                </Badge>
              )}
            </Flex>
            <Text size="1" color="gray" className="mono">
              {contact.phone}
            </Text>
            {contact.note && (
              <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                {contact.note}
              </Text>
            )}
          </Flex>
        </Flex>
        <Text size="1" color="gray">
          {contact.last_called_at ? `Called ${ago(contact.last_called_at)}` : "Never called"}
          {" · "}
          {contact.last_messaged_at ? `Messaged ${ago(contact.last_messaged_at)}` : "No messages"}
        </Text>
        <Flex align="center" gap="1">
          <IconButton
            variant="ghost"
            color="gray"
            aria-label={`Call ${contact.name}`}
            loading={callMutation.isPending}
            onClick={() => callMutation.mutate()}
          >
            <MobileIcon />
          </IconButton>
          <MessageDialog contact={contact} onNotice={onNotice} />
          <EditContact contact={contact} onSaved={onSaved} />
          <IconButton
            variant="ghost"
            color="gray"
            aria-label={open ? `Hide history of ${contact.name}` : `Show history of ${contact.name}`}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDownIcon style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </IconButton>
        </Flex>
      </Flex>
      {open && (
        <Flex direction="column" gap="2" pl="6">
          {detail.data?.messages.length === 0 && detail.data.calls.length === 0 && (
            <Text size="1" color="gray">
              No calls or messages yet.
            </Text>
          )}
          {detail.data?.calls.slice(0, 3).map((call) => (
            <Text key={call.id} size="1" color="gray">
              {call.direction === "in" ? "Received call" : call.kind === "announcement" ? "Spoken message" : "Called"}{" "}
              {ago(call.at)}
              {call.status ? `, ${call.status}` : ""}
            </Text>
          ))}
          {detail.data?.messages.map((m) => (
            <Flex key={m.id} gap="2" align="baseline">
              <Badge size="1" color={m.direction === "in" ? "indigo" : "gray"}>
                {m.direction === "in" ? "in" : "out"} {m.channel}
              </Badge>
              <Text size="1" style={{ flex: 1 }}>
                {m.body}
              </Text>
              <Text size="1" color="gray">
                {ago(m.at)}
              </Text>
            </Flex>
          ))}
          <Button size="1" variant="ghost" color="red" onClick={onRemove} style={{ alignSelf: "flex-start" }}>
            Delete contact
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

function MessageDialog({ contact, onNotice }: { contact: Contact; onNotice: (notice: Notice) => void }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>("sms");
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () => api.sendMessage(contact.id, body.trim(), channel),
    onSuccess: () => {
      setOpen(false);
      setBody("");
      onNotice({ tone: "grass", text: `${channel === "sms" ? "Text" : "WhatsApp message"} to ${contact.name} sent.` });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <IconButton variant="ghost" color="gray" aria-label={`Message ${contact.name}`}>
          <ChatBubbleIcon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Message {contact.name}</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Sent from your Twilio number to {contact.phone}.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3" mt="4">
            <Select.Root value={channel} onValueChange={(v) => setChannel(v as Channel)}>
              <Select.Trigger aria-label="Channel" />
              <Select.Content>
                <Select.Item value="sms">Text message</Select.Item>
                <Select.Item value="whatsapp">WhatsApp</Select.Item>
              </Select.Content>
            </Select.Root>
            <TextArea
              aria-label="Message"
              placeholder="Your message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
            {send.error && (
              <Text size="2" color="red">
                {explain(send.error)}
              </Text>
            )}
            <Flex justify="end" gap="2">
              <Dialog.Close>
                <Button variant="soft" color="gray" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
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

function AddContact({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [contact, setContact] = useState<NewContact>({ name: "", phone: "", label: "", note: "" });
  const add = useMutation({
    mutationFn: () => api.addContact({ ...contact, name: contact.name.trim(), phone: contact.phone.trim() }),
    onSuccess: () => {
      onAdded();
      setOpen(false);
      setContact({ name: "", phone: "", label: "", note: "" });
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
          <PlusIcon /> Add contact
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Add contact</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Local numbers get your country code; international ones start with +.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3" mt="4">
            <TextField.Root
              aria-label="Contact name"
              placeholder="Name"
              value={contact.name}
              onChange={(e) => setContact({ ...contact, name: e.target.value })}
              required
            />
            <TextField.Root
              aria-label="Contact phone"
              placeholder="Phone number"
              type="tel"
              value={contact.phone}
              onChange={(e) => setContact({ ...contact, phone: e.target.value })}
              required
            />
            <TextField.Root
              aria-label="Contact label"
              placeholder="Label, e.g. mobile (optional)"
              value={contact.label}
              onChange={(e) => setContact({ ...contact, label: e.target.value })}
            />
            <TextArea
              aria-label="Contact note"
              placeholder="Note for the assistant, e.g. my sister, call after 6pm (optional)"
              value={contact.note ?? ""}
              onChange={(e) => setContact({ ...contact, note: e.target.value })}
            />
            {add.error && (
              <Text size="2" color="red">
                {add.error instanceof ApiError && add.error.code === "bad_phone"
                  ? "That does not look like a phone number."
                  : explain(add.error)}
              </Text>
            )}
            <Flex justify="end" gap="2">
              <Dialog.Close>
                <Button variant="soft" color="gray" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={add.isPending}>
                Save
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** FileReader rather than Blob.text(), which Safari 13 and jsdom lack. */
const readText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsText(file);
  });

function EditContact({ contact, onSaved }: { contact: Contact; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ContactChanges>({});
  const current = {
    name: draft.name ?? contact.name,
    phone: draft.phone ?? contact.phone,
    label: draft.label ?? contact.label,
    note: draft.note ?? contact.note,
  };
  const save = useMutation({
    mutationFn: () => api.updateContact(contact.id, draft),
    onSuccess: () => {
      onSaved();
      setOpen(false);
      setDraft({});
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setDraft({});
      }}
    >
      <Dialog.Trigger>
        <IconButton variant="ghost" color="gray" aria-label={`Edit ${contact.name}`}>
          <Pencil1Icon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Edit contact</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          The assistant reads the note when it looks this person up.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3" mt="4">
            <TextField.Root
              aria-label="Contact name"
              value={current.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
            <TextField.Root
              aria-label="Contact phone"
              type="tel"
              value={current.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              required
            />
            <TextField.Root
              aria-label="Contact label"
              placeholder="Label, e.g. mobile"
              value={current.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <TextArea
              aria-label="Contact note"
              placeholder="Note for the assistant"
              value={current.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            {save.error && (
              <Text size="2" color="red">
                {editError(save.error)}
              </Text>
            )}
            <Flex justify="end" gap="2">
              <Dialog.Close>
                <Button variant="soft" color="gray" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={save.isPending} disabled={Object.keys(draft).length === 0}>
                Save
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function editError(err: unknown): string {
  if (err instanceof ApiError && err.code === "bad_phone") {
    return "That does not look like a phone number.";
  }
  if (err instanceof ApiError && err.code === "phone_taken") {
    return "Another contact already has that number.";
  }
  return explain(err);
}

const PRECONDITIONS: Record<string, string> = {
  no_twilio_connection: "Connect Twilio under Connections on the Home page first.",
  no_from_number: "Choose a Twilio phone number under Connections.",
  no_my_number: "Add your own mobile number under Connections: calls ring it first.",
  no_whatsapp_sender: "Set a WhatsApp sender under Connections.",
  no_open_conference: "There is no group call in progress.",
};

/** What went wrong in the user's words: a setting to fix, Twilio's own message, or a plain sentence. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    const known = PRECONDITIONS[err.code];
    if (known) {
      return known;
    }
    if (err.code === "provider") {
      return err.detail ? `Twilio said: ${err.detail}` : "Twilio did not respond.";
    }
    return err.detail ?? `The request was refused (${err.code}).`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

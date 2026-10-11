import {
  Badge,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Select,
  Switch,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import {
  ApiError,
  api,
  type Connection,
  type Light,
  type OpenAiSettings,
  type PhoneNumber,
  type Provider,
  type ProviderTest,
  type TwilioSettings,
} from "../api";
import { HelpDialog, LIGHTWAVE_HELP, OPENAI_HELP, OPENAI_SIP_HELP, TWILIO_HELP } from "../components/HelpDialog";
import { ago } from "../format";
import { toE164 } from "../lib/phone";
import { DEFAULT_OPENAI as DEFAULTS, VOICES, voiceTypeOf } from "../voices";

export function Connections() {
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const byProvider = new Map(connections.data?.map((c) => [c.provider, c]));
  return (
    <Flex direction="column" gap="5">
      <Heading size="7">Connections</Heading>
      <Text color="gray" size="2">
        Keys are stored encrypted and only ever used by your speakers and the assistant in this app.
      </Text>
      <OpenAiCard connection={byProvider.get("openai")} />
      <LightwaveCard connection={byProvider.get("lightwave")} />
      <TwilioCard connection={byProvider.get("twilio")} />
      <Card size="3" style={{ opacity: 0.7 }}>
        <Flex justify="between" align="center">
          <Heading size="4">Apple Home, Google Home, Claude, Gemini</Heading>
          <Badge color="gray">coming soon</Badge>
        </Flex>
      </Card>
    </Flex>
  );
}

function useSave<T>(mutationFn: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => client.invalidateQueries({ queryKey: ["connections"] }) });
}

function Status({ connection, provider }: { connection: Connection | undefined; provider: Provider }) {
  const client = useQueryClient();
  const test = useMutation({ mutationFn: () => api.testConnection(provider) });
  const remove = useSave(() => api.removeConnection(provider));
  if (!connection) {
    return <Badge color="gray">not connected</Badge>;
  }
  return (
    <Flex align="center" gap="3" wrap="wrap">
      <Badge color="grass">connected</Badge>
      <Button size="1" variant="soft" onClick={() => test.mutate()} loading={test.isPending}>
        Test
      </Button>
      <Button
        size="1"
        variant="ghost"
        color="red"
        onClick={() => remove.mutate(undefined, { onSuccess: () => client.removeQueries({ queryKey: ["lights"] }) })}
      >
        Remove
      </Button>
      {test.data && <TestResult result={test.data} provider={provider} />}
      {test.error && (
        <Text size="2" color="red">
          {errorText(test.error)}
        </Text>
      )}
    </Flex>
  );
}

function TestResult({ result, provider }: { result: ProviderTest; provider: Provider }) {
  if (provider === "openai") {
    return (
      <Text size="2" color="grass">
        Key works: {result.models} models visible
        {result.live_model ? ", gpt-live-1 available" : ", gpt-live-1 not listed"}.
      </Text>
    );
  }
  if (provider === "twilio") {
    return (
      <Text size="2" color="grass">
        Account {result.account} works: {result.numbers} {result.numbers === 1 ? "number" : "numbers"}.
      </Text>
    );
  }
  return (
    <Text size="2" color="grass">
      Token works: {result.structures} {result.structures === 1 ? "home" : "homes"}.
    </Text>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.detail ?? err.code;
  }
  return err instanceof Error ? err.message : "failed";
}

function OpenAiCard({ connection }: { connection: Connection | undefined }) {
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [settings, setSettings] = useState<OpenAiSettings>({ ...DEFAULTS, ...connection?.settings });
  const [editing, setEditing] = useState(false);
  const voiceType = voiceTypeOf(settings.voice);
  const chooseVoiceType = (type: string) => {
    const next = type === "female" ? "female" : "male";
    setSettings({ ...settings, voice: VOICES[next][0] ?? DEFAULTS.voice });
  };
  const save = useSave(() => api.connectOpenai(apiKey.trim(), settings, webhookSecret.trim()));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: () => {
        setApiKey("");
        setWebhookSecret("");
        setEditing(false);
      },
    });
  };
  const open = editing || !connection;
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center" wrap="wrap" gap="2">
          <Heading size="4">OpenAI</Heading>
          <Status connection={connection} provider="openai" />
        </Flex>
        <Text size="2" color="gray">
          GPT-Live voice sessions for the Assistant tab and your speakers. Needs a paid OpenAI tier.
        </Text>
        {connection && !open && (
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2">
              {connection.settings.model} via {connection.settings.backend_model}, voice {connection.settings.voice}
              {connection.settings.web_search === false ? ", no web search" : ", web search on"}
              {connection.settings.project_id ? ", joins phone calls" : ", not on phone calls"}
            </Text>
            <Button size="1" variant="soft" onClick={() => setEditing(true)}>
              Change
            </Button>
          </Flex>
        )}
        {open && (
          <form onSubmit={submit}>
            <Flex direction="column" gap="3">
              <TextField.Root
                placeholder={connection ? "Leave empty to keep the current key" : "sk-..."}
                aria-label="OpenAI API key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required={!connection}
              />
              <Flex gap="3" wrap="wrap">
                <TextField.Root
                  aria-label="Live model"
                  value={settings.model}
                  onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                  style={{ flex: 1, minWidth: 140 }}
                />
                <TextField.Root
                  aria-label="Backend model"
                  value={settings.backend_model}
                  onChange={(e) => setSettings({ ...settings, backend_model: e.target.value })}
                  style={{ flex: 1, minWidth: 140 }}
                />
                <Select.Root value={voiceType} onValueChange={chooseVoiceType}>
                  <Select.Trigger aria-label="Voice type" />
                  <Select.Content>
                    <Select.Item value="male">Male</Select.Item>
                    <Select.Item value="female">Female</Select.Item>
                  </Select.Content>
                </Select.Root>
                <Select.Root value={settings.voice} onValueChange={(voice) => setSettings({ ...settings, voice })}>
                  <Select.Trigger aria-label="Voice" />
                  <Select.Content>
                    {VOICES[voiceType].map((v) => (
                      <Select.Item key={v} value={v}>
                        {v}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Flex>
              <Text as="label" size="2">
                <Flex gap="2" align="center">
                  <Switch
                    checked={settings.web_search}
                    onCheckedChange={(web_search) => setSettings({ ...settings, web_search })}
                  />
                  Web search (the assistant may look things up online; OpenAI bills each search)
                </Flex>
              </Text>
              <Text as="label" size="2">
                <Flex gap="2" align="center">
                  <Switch
                    checked={settings.respond_when_addressed}
                    onCheckedChange={(respond_when_addressed) => setSettings({ ...settings, respond_when_addressed })}
                  />
                  Only answer when addressed as Alexsay (ignores the TV and other people in the room)
                </Flex>
              </Text>
              <TextArea
                aria-label="Extra instructions"
                placeholder="Extra instructions for the assistant (optional)"
                value={settings.instructions}
                onChange={(e) => setSettings({ ...settings, instructions: e.target.value })}
              />
              <Flex align="center" justify="between" gap="2" mt="1">
                <Text size="2" weight="medium">
                  Phone calls
                </Text>
                <HelpDialog {...OPENAI_SIP_HELP} label="How to enable" size="1" />
              </Flex>
              <Text size="1" color="gray">
                OpenAI&apos;s SIP endpoint lets the assistant join calls placed from the Assistant page: it needs the
                project ID and the signing secret of a webhook for realtime.call.incoming. Twilio must be connected.
              </Text>
              <TextField.Root
                aria-label="OpenAI project ID"
                placeholder="Project ID, proj_..."
                autoComplete="off"
                value={settings.project_id}
                onChange={(e) => setSettings({ ...settings, project_id: e.target.value })}
              />
              <TextField.Root
                aria-label="OpenAI webhook secret"
                placeholder={
                  connection ? "Webhook secret, whsec_... (leave empty to keep)" : "Webhook secret, whsec_..."
                }
                type="password"
                autoComplete="off"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
              <TextField.Root
                aria-label="Call model"
                placeholder="Call model"
                value={settings.call_model}
                onChange={(e) => setSettings({ ...settings, call_model: e.target.value })}
              />
              {save.error && (
                <Text size="2" color="red">
                  {save.error instanceof ApiError && save.error.code === "bad_request"
                    ? "That does not look like an OpenAI key."
                    : errorText(save.error)}
                </Text>
              )}
              <Flex gap="2" justify="end">
                <HelpDialog {...OPENAI_HELP} />
                {connection && (
                  <Button type="button" variant="soft" color="gray" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" loading={save.isPending}>
                  Save
                </Button>
              </Flex>
            </Flex>
          </form>
        )}
      </Flex>
    </Card>
  );
}

function LightwaveCard({ connection }: { connection: Connection | undefined }) {
  const [basic, setBasic] = useState("");
  const [refresh, setRefresh] = useState("");
  const [editing, setEditing] = useState(false);
  const save = useSave(() => api.connectLightwave(basic.trim(), refresh.trim()));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined, {
      onSuccess: () => {
        setBasic("");
        setRefresh("");
        setEditing(false);
      },
    });
  };
  const open = editing || !connection;
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center" wrap="wrap" gap="2">
          <Heading size="4">Lightwave</Heading>
          <Status connection={connection} provider="lightwave" />
        </Flex>
        <Text size="2" color="gray">
          Lights and dimmers through the Lightwave Link Plus API. Both tokens come from my.lightwaverf.com, Settings,
          API.
        </Text>
        {connection && !open && (
          <Button size="1" variant="soft" onClick={() => setEditing(true)} style={{ alignSelf: "flex-start" }}>
            Replace tokens
          </Button>
        )}
        {open && (
          <form onSubmit={submit}>
            <Flex direction="column" gap="3">
              <TextField.Root
                placeholder="Basic token"
                aria-label="Lightwave basic token"
                type="password"
                autoComplete="off"
                value={basic}
                onChange={(e) => setBasic(e.target.value)}
                required
              />
              <TextField.Root
                placeholder="Refresh token"
                aria-label="Lightwave refresh token"
                type="password"
                autoComplete="off"
                value={refresh}
                onChange={(e) => setRefresh(e.target.value)}
                required
              />
              {save.error && (
                <Text size="2" color="red">
                  {save.error instanceof ApiError && save.error.code === "lightwave_rejected"
                    ? `Lightwave refused the tokens (${save.error.detail ?? "no detail"}). A refresh token works once: open my.lightwaverf.com, Settings, API Integration, Get Token for a fresh pair and paste both again.`
                    : errorText(save.error)}
                </Text>
              )}
              <Flex gap="2" justify="end">
                <HelpDialog {...LIGHTWAVE_HELP} />
                {connection && (
                  <Button type="button" variant="soft" color="gray" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" loading={save.isPending}>
                  Save
                </Button>
              </Flex>
            </Flex>
          </form>
        )}
        {connection && <Lights />}
      </Flex>
    </Card>
  );
}

function Lights() {
  const client = useQueryClient();
  const lights = useQuery({ queryKey: ["lights"], queryFn: api.lights, retry: false, refetchInterval: 30_000 });
  const [notice, setNotice] = useState<{ tone: "red" | "grass"; text: string } | null>(null);
  const toggle = useMutation({
    mutationFn: ({ light, on }: { light: Light; on: boolean }) => api.setFeature(light.switch, on ? 1 : 0),
    onMutate: async ({ light, on }) => {
      await client.cancelQueries({ queryKey: ["lights"] });
      const previous = client.getQueryData<Light[]>(["lights"]);
      client.setQueryData<Light[]>(["lights"], (all) => all?.map((l) => (l.id === light.id ? { ...l, on } : l)));
      setNotice(null);
      return { previous };
    },
    onError: (err, { light, on }, context) => {
      client.setQueryData(["lights"], context?.previous);
      setNotice({ tone: "red", text: `${light.name} could not be switched ${on ? "on" : "off"}. ${explain(err)}` });
    },
    onSuccess: (_result, { light, on }) => {
      setNotice({ tone: "grass", text: `${light.name} is ${on ? "on" : "off"}.` });
      window.setTimeout(() => client.invalidateQueries({ queryKey: ["lights"] }), 1500);
    },
  });
  if (lights.error) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Text>Lights are unavailable right now. {explain(lights.error)}</Callout.Text>
      </Callout.Root>
    );
  }
  if (!lights.data) {
    return null;
  }
  return (
    <Flex direction="column" gap="2">
      <Text size="2" weight="medium">
        Lights
      </Text>
      {notice && (
        <Callout.Root color={notice.tone} size="1" role="status">
          <Callout.Text>{notice.text}</Callout.Text>
        </Callout.Root>
      )}
      {lights.data.length === 0 && (
        <Text size="2" color="gray">
          No switchable lights found.
        </Text>
      )}
      {lights.data.map((light) => (
        <Flex key={light.id} justify="between" align="center">
          <Text size="2">
            {light.name}
            {light.dim_level !== null && <Text color="gray"> · {light.dim_level}%</Text>}
          </Text>
          <Switch
            checked={light.on}
            aria-label={`${light.name} on`}
            disabled={toggle.isPending && toggle.variables?.light.id === light.id}
            onCheckedChange={(on) => toggle.mutate({ light, on })}
          />
        </Flex>
      ))}
    </Flex>
  );
}

/** Lightwave's own words when it gave any, otherwise a plain sentence; never a status code. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "no_lightwave_connection") {
      return "Connect Lightwave first.";
    }
    if (err.detail) {
      return `Lightwave said: ${err.detail}`;
    }
    return err.status >= 500 ? "Lightwave did not respond." : `The request was refused (${err.code}).`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

const DEFAULT_TWILIO: TwilioSettings = {
  from_number: "",
  whatsapp_from: "",
  my_number: "",
  sip_domain: "",
  country_code: "+44",
};
const NO_NUMBER = "none";

function TwilioCard({ connection }: { connection: Connection | undefined }) {
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [settings, setSettings] = useState<TwilioSettings>({ ...DEFAULT_TWILIO, ...connection?.settings });
  const [editing, setEditing] = useState(false);
  const numbers = useQuery({
    queryKey: ["twilio-numbers"],
    queryFn: api.twilioNumbers,
    enabled: !!connection,
    retry: false,
  });
  const save = useSave(() =>
    api.connectTwilio(sid.trim(), token.trim(), {
      ...settings,
      my_number: settings.my_number ? (toE164(settings.my_number, settings.country_code) ?? settings.my_number) : "",
      whatsapp_from: settings.whatsapp_from.replace(/^whatsapp:/, "").trim()
        ? `whatsapp:${toE164(settings.whatsapp_from.replace(/^whatsapp:/, ""), settings.country_code) ?? settings.whatsapp_from}`
        : "",
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const first = !connection;
    save.mutate(undefined, {
      onSuccess: () => {
        setSid("");
        setToken("");
        // The first save stores the credentials; the number and your mobile come next, in the same card
        setEditing(first);
      },
    });
  };
  const open = editing || !connection;
  const set = (patch: Partial<TwilioSettings>) => setSettings({ ...settings, ...patch });
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center" wrap="wrap" gap="2">
          <Heading size="4">Twilio</Heading>
          <Status connection={connection} provider="twilio" />
        </Flex>
        <Text size="2" color="gray">
          Calls, group calls, texts and WhatsApp from your own number, and incoming calls to the speaker.
        </Text>
        {connection && !open && (
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2">
              {connection.settings.from_number
                ? `Calls and texts from ${connection.settings.from_number}`
                : "No number chosen yet"}
              {connection.settings.my_number
                ? `, your phone ${connection.settings.my_number}`
                : ", your mobile not set"}
              {connection.settings.whatsapp_from ? ", WhatsApp on" : ""}
              {connection.settings.sip_domain ? ", speakers take calls" : ""}
            </Text>
            <Button size="1" variant="soft" onClick={() => setEditing(true)}>
              Change
            </Button>
          </Flex>
        )}
        {open && (
          <form onSubmit={submit}>
            <Flex direction="column" gap="3">
              <TextField.Root
                placeholder={connection ? "Account SID (leave empty to keep)" : "Account SID"}
                aria-label="Twilio account SID"
                autoComplete="off"
                value={sid}
                onChange={(e) => setSid(e.target.value)}
                required={!connection}
              />
              <TextField.Root
                placeholder={connection ? "Auth token (leave empty to keep)" : "Auth token"}
                aria-label="Twilio auth token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required={!connection}
              />
              {connection && (
                <>
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="medium">
                      Phone number
                    </Text>
                    <Select.Root
                      value={settings.from_number || NO_NUMBER}
                      onValueChange={(v) => set({ from_number: v === NO_NUMBER ? "" : v })}
                    >
                      <Select.Trigger aria-label="Twilio phone number" />
                      <Select.Content>
                        <Select.Item value={NO_NUMBER}>No number</Select.Item>
                        {numbers.data?.map((n) => (
                          <Select.Item key={n.sid} value={n.phone_number}>
                            {n.phone_number} ({n.friendly_name || `${n.voice ? "voice" : ""}${n.sms ? " sms" : ""}`})
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                    {numbers.data?.length === 0 && (
                      <Text size="1" color="gray">
                        This account owns no numbers yet: buy one in the Twilio console (see Help).
                      </Text>
                    )}
                    {numbers.error && (
                      <Text size="1" color="red">
                        {errorText(numbers.error)}
                      </Text>
                    )}
                  </Flex>
                  <TextField.Root
                    placeholder="Your mobile number, e.g. 07700 900123"
                    aria-label="Your mobile number"
                    type="tel"
                    value={settings.my_number}
                    onChange={(e) => set({ my_number: e.target.value })}
                  />
                  <TextField.Root
                    placeholder="WhatsApp sender, e.g. +14155238886 for the sandbox"
                    aria-label="WhatsApp sender"
                    value={settings.whatsapp_from}
                    onChange={(e) => set({ whatsapp_from: e.target.value })}
                  />
                  <TextField.Root
                    placeholder="Speaker SIP domain, e.g. alexsay.sip.twilio.com"
                    aria-label="Speaker SIP domain"
                    value={settings.sip_domain}
                    onChange={(e) => set({ sip_domain: e.target.value })}
                  />
                  <TextField.Root
                    placeholder="Country code for local numbers"
                    aria-label="Default country code"
                    value={settings.country_code}
                    onChange={(e) => set({ country_code: e.target.value })}
                    style={{ maxWidth: 220 }}
                  />
                </>
              )}
              {save.error && (
                <Text size="2" color="red">
                  {twilioError(save.error)}
                </Text>
              )}
              <Flex gap="2" justify="end">
                <HelpDialog {...TWILIO_HELP} />
                {connection && (
                  <Button type="button" variant="soft" color="gray" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                )}
                <Button type="submit" loading={save.isPending}>
                  Save
                </Button>
              </Flex>
            </Flex>
          </form>
        )}
        {connection && <NumberRouting from={connection.settings.from_number ?? ""} numbers={numbers.data} />}
        {connection && <RecentCalls />}
      </Flex>
    </Card>
  );
}

/**
 * Where Twilio sends calls to the chosen number right now. A TwiML app, SIP trunk or another URL set in the
 * console means calls never reach this app; Repair points the number back here.
 */
function NumberRouting({ from, numbers }: { from: string; numbers: PhoneNumber[] | undefined }) {
  const client = useQueryClient();
  const repair = useMutation({
    mutationFn: api.repairNumber,
    onSuccess: () => client.invalidateQueries({ queryKey: ["twilio-numbers"] }),
  });
  const number = numbers?.find((n) => n.phone_number === from);
  if (!from || !number) {
    return null;
  }
  const ours = `${window.location.origin}/v1/twilio/voice`;
  const routedHere = number.voice_url === ours && !number.voice_application_sid && !number.trunk_sid;
  const elsewhere = number.trunk_sid
    ? `a SIP trunk (${number.trunk_sid})`
    : number.voice_application_sid
      ? `a TwiML app (${number.voice_application_sid})`
      : number.voice_url
        ? `another URL (${number.voice_url})`
        : "nothing";
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Text size="2">
          Incoming calls to {from}:{" "}
          {routedHere ? (
            <Text color="grass">reach this app (the Assistant page, your speakers and your mobile).</Text>
          ) : (
            <Text color="amber">go to {elsewhere}, not to this app.</Text>
          )}
        </Text>
        {!routedHere && (
          <Button size="1" variant="soft" onClick={() => repair.mutate()} loading={repair.isPending}>
            Point at this app
          </Button>
        )}
      </Flex>
      {repair.error && (
        <Text size="2" color="red">
          {errorText(repair.error)}
        </Text>
      )}
    </Flex>
  );
}

/** What happened to the last calls, including where an incoming one rang, so a silent phone has an answer. */
function RecentCalls() {
  const recent = useQuery({ queryKey: ["recent-calls"], queryFn: api.recentCalls, refetchInterval: 20_000 });
  if (!recent.data || recent.data.length === 0) {
    return null;
  }
  return (
    <Flex direction="column" gap="1">
      <Text size="2" weight="medium">
        Recent calls
      </Text>
      {recent.data
        .filter((call) => call.role !== "assistant")
        .map((call) => (
          <Flex key={call.id} justify="between" gap="3" wrap="wrap">
            <Text size="1">
              {call.direction === "in" ? "From" : call.kind === "conference" ? "Group call with" : "To"}{" "}
              {call.contact ?? call.phone}
              {call.detail ? <Text color="gray"> · {call.detail}</Text> : null}
            </Text>
            <Text size="1" color="gray">
              {call.status || "placed"} · {ago(call.at)}
            </Text>
          </Flex>
        ))}
    </Flex>
  );
}

function twilioError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "twilio_rejected") {
      return `Twilio refused the credentials (${err.detail ?? "no detail"}). Copy the Account SID and Auth Token from the console home page and try again.`;
    }
    if (err.code === "number_not_found") {
      return "That number is not in this Twilio account any more.";
    }
    if (err.code === "bad_request") {
      return "Check the numbers: international form such as +447700900123, the SIP domain ending in .sip.twilio.com.";
    }
  }
  return errorText(err);
}

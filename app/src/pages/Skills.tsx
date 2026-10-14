import { BellIcon, TrashIcon } from "@radix-ui/react-icons";
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  Flex,
  Heading,
  IconButton,
  Select,
  Switch,
  Table,
  Text,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Alarm, type AlarmEvent, type AlarmsPage, api, type Skill } from "../api";
import { alarmTitle } from "../format";

const EVENT_COLORS: Record<AlarmEvent["event"], "grass" | "amber" | "red"> = {
  stopped: "grass",
  snoozed: "amber",
  missed: "red",
};

/** Optional abilities of the assistant, each with its own page; Alarms is the first. */
export function Skills() {
  const client = useQueryClient();
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setSkill(id, enabled),
    onSuccess: () => client.invalidateQueries({ queryKey: ["skills"] }),
  });
  const alarmsOn = skills.data?.find((s) => s.id === "alarms")?.enabled ?? false;

  return (
    <Flex direction="column" gap="5">
      <Heading size="7">Skills</Heading>
      <Flex direction="column" gap="3">
        {skills.data?.map((skill) => (
          <SkillCard key={skill.id} skill={skill} onToggle={(enabled) => toggle.mutate({ id: skill.id, enabled })} />
        ))}
      </Flex>
      {alarmsOn && <Alarms />}
    </Flex>
  );
}

function SkillCard({ skill, onToggle }: { skill: Skill; onToggle: (enabled: boolean) => void }) {
  return (
    <Card size="2">
      <Flex align="center" justify="between" gap="4">
        <Flex direction="column" gap="1">
          <Text weight="bold">{skill.name}</Text>
          <Text size="2" color="gray">
            {skill.description}
          </Text>
        </Flex>
        <Switch checked={skill.enabled} onCheckedChange={onToggle} aria-label={`${skill.name} on`} />
      </Flex>
    </Card>
  );
}

function Alarms() {
  const client = useQueryClient();
  const page = useQuery({ queryKey: ["alarms"], queryFn: api.alarms, refetchInterval: 15_000 });
  const refresh = () => client.invalidateQueries({ queryKey: ["alarms"] });
  const update = useMutation({
    mutationFn: ({ id, ...changes }: { id: string; enabled?: boolean; device_id?: string }) =>
      api.updateAlarm(id, changes),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeAlarm, onSuccess: refresh });
  const stop = useMutation({ mutationFn: api.stopAlarm });

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="2">
        <BellIcon />
        <Heading size="5">Alarms</Heading>
      </Flex>
      <Text size="2" color="gray">
        Ask the assistant: "set a timer for 10 minutes", "wake me at 7 on weekdays", "remind me to call Mum tomorrow at
        6". Alarms ring on a speaker; "Alexsay, stop" or "Alexsay, snooze" while they ring.
      </Text>
      {page.data && page.data.alarms.length === 0 && (
        <Card size="2">
          <Text color="gray">Nothing set.</Text>
        </Card>
      )}
      {page.data && page.data.alarms.length > 0 && (
        <Card size="1">
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Next</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>What</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Repeats</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Speaker</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>On</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {page.data.alarms.map((alarm) => (
                <AlarmRow
                  key={alarm.id}
                  alarm={alarm}
                  speakers={page.data.speakers}
                  onChange={(changes) => update.mutate({ id: alarm.id, ...changes })}
                  onStop={() => stop.mutate(alarm.id)}
                  onRemove={() => remove.mutate(alarm.id)}
                />
              ))}
            </Table.Body>
          </Table.Root>
        </Card>
      )}
      {page.data && <Recent page={page.data} />}
    </Flex>
  );
}

function AlarmRow({
  alarm,
  speakers,
  onChange,
  onStop,
  onRemove,
}: {
  alarm: Alarm;
  speakers: AlarmsPage["speakers"];
  onChange: (changes: { enabled?: boolean; device_id?: string }) => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  return (
    <Table.Row align="center">
      <Table.RowHeaderCell>
        {alarm.when ?? <Text color="gray">off</Text>}
        {alarm.snoozed && (
          <Badge ml="2" color="amber">
            snoozed
          </Badge>
        )}
      </Table.RowHeaderCell>
      <Table.Cell>
        <Flex gap="2" align="center">
          <Badge variant="soft" color="gray">
            {alarm.kind}
          </Badge>
          {alarmTitle(alarm)}
        </Flex>
      </Table.Cell>
      <Table.Cell>{alarm.repeat ?? <Text color="gray">once</Text>}</Table.Cell>
      <Table.Cell>
        <Select.Root
          size="1"
          value={alarm.device_id ?? undefined}
          onValueChange={(device_id) => onChange({ device_id })}
        >
          <Select.Trigger placeholder="Choose a speaker" aria-label="Speaker" />
          <Select.Content>
            {speakers.map((s) => (
              <Select.Item key={s.id} value={s.id}>
                {s.name || "unnamed"}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Table.Cell>
      <Table.Cell>
        <Switch
          size="1"
          checked={alarm.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label={`${alarmTitle(alarm)} on`}
        />
      </Table.Cell>
      <Table.Cell justify="end">
        <Flex gap="3" justify="end" align="center">
          <Button size="1" variant="ghost" onClick={onStop}>
            Stop ringing
          </Button>
          <AlertDialog.Root>
            <AlertDialog.Trigger>
              <IconButton size="1" variant="ghost" color="red" aria-label={`Delete ${alarmTitle(alarm)}`}>
                <TrashIcon />
              </IconButton>
            </AlertDialog.Trigger>
            <AlertDialog.Content maxWidth="420px">
              <AlertDialog.Title>Delete {alarmTitle(alarm)}?</AlertDialog.Title>
              <AlertDialog.Description size="2">It will not ring again.</AlertDialog.Description>
              <Flex gap="3" mt="4" justify="end">
                <AlertDialog.Cancel>
                  <Button variant="soft" color="gray">
                    Keep
                  </Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button color="red" onClick={onRemove}>
                    Delete
                  </Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Flex>
      </Table.Cell>
    </Table.Row>
  );
}

function Recent({ page }: { page: AlarmsPage }) {
  if (page.recent.length === 0) {
    return null;
  }
  return (
    <Flex direction="column" gap="2">
      <Text weight="bold" size="2">
        Last {page.recent.length}
      </Text>
      <Card size="1">
        <Flex direction="column" gap="2">
          {page.recent.map((event) => (
            <Flex key={`${event.alarm_id}-${event.at}-${event.event}`} gap="3" align="center" wrap="wrap">
              <Text size="2" color="gray" style={{ minWidth: 150 }}>
                {event.when}
              </Text>
              <Badge color={EVENT_COLORS[event.event]}>{event.event}</Badge>
              <Text size="2">{alarmTitle({ kind: event.kind ?? "alarm", label: event.label })}</Text>
              {event.speaker && (
                <Text size="2" color="gray">
                  on {event.speaker}
                </Text>
              )}
            </Flex>
          ))}
        </Flex>
      </Card>
    </Flex>
  );
}

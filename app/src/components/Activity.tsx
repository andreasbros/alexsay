import {
  CheckCircledIcon,
  ChevronDownIcon,
  CrossCircledIcon,
  DotFilledIcon,
  LightningBoltIcon,
} from "@radix-ui/react-icons";
import { Badge, Box, Card, Flex, IconButton, Text } from "@radix-ui/themes";
import { useState } from "react";
import type { ActivityKind } from "../lib/live";

export interface ActivityEntry {
  at: Date;
  kind: ActivityKind;
  text: string;
}

const ICONS: Record<ActivityKind, { icon: typeof DotFilledIcon; color: string }> = {
  info: { icon: DotFilledIcon, color: "var(--gray-9)" },
  tool: { icon: LightningBoltIcon, color: "var(--amber-9)" },
  result: { icon: CheckCircledIcon, color: "var(--grass-9)" },
  error: { icon: CrossCircledIcon, color: "var(--red-9)" },
};

const time = (at: Date) => at.toLocaleTimeString(undefined, { hour12: false });

/** The conversation's event log: collapsed to one line with counts, a timestamped list when opened. */
export function Activity({ entries }: { entries: ActivityEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) {
    return null;
  }
  const tools = entries.filter((e) => e.kind === "result").length;
  const errors = entries.filter((e) => e.kind === "error").length;
  const latest = entries[entries.length - 1];
  return (
    <Card size="1" className="activity">
      <Flex align="center" justify="between" gap="3" className="activity-head" onClick={() => setOpen((o) => !o)}>
        <Flex align="center" gap="2" minWidth="0">
          <Text size="2" weight="medium">
            Activity
          </Text>
          {tools > 0 && <Badge color="grass">{tools} done</Badge>}
          {errors > 0 && <Badge color="red">{errors} failed</Badge>}
          {!open && latest && (
            <Text size="1" color="gray" truncate>
              {latest.text}
            </Text>
          )}
        </Flex>
        <IconButton variant="ghost" color="gray" size="1" aria-label={open ? "Collapse activity" : "Expand activity"}>
          <ChevronDownIcon style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </IconButton>
      </Flex>
      {open && (
        <Box mt="2" className="activity-list">
          {entries.map((entry, index) => {
            const { icon: Icon, color } = ICONS[entry.kind];
            return (
              <Flex
                // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
                key={index}
                align="start"
                gap="2"
                className="activity-entry"
              >
                <Text size="1" color="gray" className="mono activity-time">
                  {time(entry.at)}
                </Text>
                <Icon style={{ color, flexShrink: 0, marginTop: 2 }} />
                <Text size="1" className="mono" style={{ overflowWrap: "anywhere" }}>
                  {entry.text}
                </Text>
              </Flex>
            );
          })}
        </Box>
      )}
    </Card>
  );
}

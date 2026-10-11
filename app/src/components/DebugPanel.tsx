import { Button, Flex, Text } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { clearDebug, debugLines, subscribeDebug } from "../lib/debug";

/** The debug log at the bottom of the assistant screen, with Copy and Clear. */
export function DebugPanel() {
  const [, bump] = useState(0);
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => subscribeDebug(() => bump((n) => n + 1)), []);
  useEffect(() => {
    if (pre.current) {
      pre.current.scrollTop = pre.current.scrollHeight;
    }
  });
  const copy = async () => {
    const text = debugLines().join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy the log:", text);
    }
  };
  return (
    <div className="debug">
      <Flex align="center" justify="between" gap="2" mb="1">
        <Text size="1" weight="medium" color="gray">
          Debug log ({debugLines().length} lines)
        </Text>
        <Flex gap="2">
          <Button size="1" variant="soft" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="1" variant="soft" color="gray" onClick={clearDebug}>
            Clear
          </Button>
        </Flex>
      </Flex>
      <pre ref={pre} className="debug-lines">
        {debugLines().join("\n")}
      </pre>
    </div>
  );
}

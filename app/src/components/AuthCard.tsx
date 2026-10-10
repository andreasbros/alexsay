import { Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";
import { Logo } from "./Logo";

/** The centred card both sign-in screens share. */
export function AuthCard({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <Flex className="screen" align="center" justify="center">
      <Card size="4" style={{ width: "100%", maxWidth: 380 }}>
        <Flex direction="column" gap="4">
          <Flex align="center" gap="2">
            <Box style={{ color: "var(--accent-9)" }}>
              <Logo size={28} />
            </Box>
            <Heading size="6">{title}</Heading>
          </Flex>
          <Text color="gray" size="2">
            {lead}
          </Text>
          {children}
        </Flex>
      </Card>
    </Flex>
  );
}

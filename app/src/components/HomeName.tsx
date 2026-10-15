import { Button, Card, Flex, Heading, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../api";

/** The home's name, renamed by its admins; members see which home they are in. On the Settings page. */
export function HomeNameCard() {
  const client = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: api.home });
  const [name, setName] = useState("");
  useEffect(() => setName(home.data?.name ?? ""), [home.data?.name]);
  const rename = useMutation({
    mutationFn: api.renameHome,
    onSuccess: () => client.invalidateQueries({ queryKey: ["home"] }),
  });
  const data = home.data;
  if (!data) {
    return null;
  }
  return (
    <Card size="3">
      <Flex direction="column" gap="3">
        <Heading size="4">Home</Heading>
        <Text size="2" color="gray">
          Everything belongs to the home: its speakers, connections, memories, contacts, alarms and conversations.
          Everyone in it shares them.
        </Text>
        {data.role === "admin" ? (
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
          <Text size="2">You are a member of {data.name}.</Text>
        )}
      </Flex>
    </Card>
  );
}

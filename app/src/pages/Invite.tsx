import { Button, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api } from "../api";
import { AuthCard } from "../components/AuthCard";
import { useSignIn } from "../session";
import { linkToken } from "./EmailLink";

const MESSAGES: Record<string, string> = {
  expired: "This invitation has expired, was used already or was withdrawn. Ask for a new one.",
  home_has_members:
    "Your own home has other people in it. Remove them (or let them leave) before joining another home.",
};

/** Opened from an invitation email: shows whose home it is, then one click signs in and joins. */
export function Invite() {
  const navigate = useNavigate();
  const [token] = useState(linkToken);
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteInfo(token), retry: false });
  const accept = useSignIn((t: string) => api.acceptInvite(t));

  const failure = accept.error ?? info.error;
  if (!token || failure) {
    const code = failure instanceof ApiError ? failure.code : "expired";
    return (
      <AuthCard title="Alexsay" lead="Invitation">
        <Callout.Root color="red" size="1">
          <Callout.Text>{MESSAGES[code] ?? MESSAGES.expired}</Callout.Text>
        </Callout.Root>
        <Button size="3" onClick={() => navigate("/", { replace: true })}>
          Go to Alexsay
        </Button>
      </AuthCard>
    );
  }
  if (!info.data) {
    return (
      <AuthCard title="Alexsay" lead="Invitation">
        <Spinner />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Alexsay" lead={`${info.data.invited_by} invited you to join ${info.data.home}.`}>
      <Flex direction="column" gap="4">
        <Text size="2" color="gray">
          You will share its speakers, its assistant and everything it remembers, as{" "}
          {info.data.role === "admin" ? "an admin" : "a member"}. Joining signs you in as {info.data.email}, and makes
          that account if there is none.
        </Text>
        <Button
          size="3"
          loading={accept.isPending}
          onClick={() => accept.mutate(token, { onSuccess: () => navigate("/home", { replace: true }) })}
        >
          Join {info.data.home}
        </Button>
      </Flex>
    </AuthCard>
  );
}

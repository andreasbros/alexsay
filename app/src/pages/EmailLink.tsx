import { Button, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api } from "../api";
import { AuthCard } from "../components/AuthCard";
import { useSignIn } from "../session";

/** The token travels after `#`, so it never reaches a server log; read once, then wiped from the address bar. */
export function linkToken(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
  if (token) {
    window.history.replaceState(null, "", window.location.pathname);
  }
  return token;
}

/** Opened from the sign-in email: posts the link's token (mail scanners fetch links but do not run this). */
export function EmailLink() {
  const navigate = useNavigate();
  const [token] = useState(linkToken);
  const signIn = useSignIn((t: string) => api.emailLink(t));
  const { mutate } = signIn;
  const started = useRef(false);
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      mutate(token, { onSuccess: () => navigate("/", { replace: true }) });
    }
  }, [token, mutate, navigate]);

  const failed = !token || signIn.isError;
  return (
    <AuthCard title="Alexsay" lead="Signing you in.">
      {failed ? (
        <Flex direction="column" gap="4">
          <Callout.Root color="red" size="1">
            <Callout.Text>
              {signIn.error instanceof ApiError && signIn.error.code === "expired"
                ? "This link has expired or was already used. Sign in again for a new one."
                : "This link does not work. Sign in again for a new one."}
            </Callout.Text>
          </Callout.Root>
          <Button size="3" onClick={() => navigate("/", { replace: true })}>
            Sign in
          </Button>
        </Flex>
      ) : (
        <Flex align="center" gap="3">
          <Spinner />
          <Text size="2" color="gray">
            One moment
          </Text>
        </Flex>
      )}
    </AuthCard>
  );
}

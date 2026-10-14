import { Button, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api";
import { AuthCard } from "../components/AuthCard";
import { Captcha } from "../components/Captcha";
import { Field } from "../components/Field";
import { useAuthConfig, useRegister } from "../session";
import { EmailSignIn } from "./Login";

const MESSAGES: Record<string, string> = {
  exists: "That username is taken.",
  captcha_failed: "Please complete the check above and try again.",
  too_many: "Too many new accounts from this address. Try again in an hour.",
  registration_closed: "This server does not take new accounts. Ask its owner to add you.",
  bad_request:
    "Use 2 to 32 lowercase letters, digits, dots, dashes or underscores, and at least 8 characters of password.",
};

export function Register() {
  const register = useRegister();
  const config = useAuthConfig();
  const captcha = config.data?.captcha ?? null;
  const [human, setHuman] = useState("");
  const [captchaRound, setCaptchaRound] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== repeat) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    register.mutate(
      { username, password, captcha: captcha ? human : undefined },
      { onSettled: () => setCaptchaRound((round) => round + 1) },
    );
  };
  const error = mismatch
    ? "The passwords differ."
    : register.error instanceof ApiError
      ? (MESSAGES[register.error.code] ?? `The account could not be created (${register.error.code}).`)
      : register.error?.message;

  // With email sign-in on, an address is all an account needs: the code makes it, no password to keep
  const lead = config.data?.email_login
    ? "Your email is all it takes: the code we send makes your account."
    : "A username and a password is all it takes.";
  return (
    <AuthCard title="Create account" lead={lead}>
      {config.isPending ? (
        <Flex justify="center" py="4">
          <Spinner />
        </Flex>
      ) : config.data?.email_login ? (
        <Flex direction="column" gap="4">
          <EmailSignIn captcha={captcha} />
          <Text size="2" color="gray" align="center">
            Already registered? <Link to="/login">Sign in</Link>
          </Text>
        </Flex>
      ) : (
        <form onSubmit={submit}>
          <Flex direction="column" gap="4">
            <Field
              id="username"
              label="Username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Field
              id="repeat"
              label="Repeat password"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
            />
            {captcha && <Captcha siteKey={captcha} resetKey={captchaRound} onToken={setHuman} />}
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Button size="3" type="submit" loading={register.isPending} disabled={Boolean(captcha) && !human}>
              Create account
            </Button>
            <Text size="2" color="gray" align="center">
              Already registered? <Link to="/login">Sign in</Link>
            </Text>
          </Flex>
        </form>
      )}
    </AuthCard>
  );
}

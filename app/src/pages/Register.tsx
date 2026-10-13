import { Button, Callout, Flex, Text } from "@radix-ui/themes";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api";
import { AuthCard } from "../components/AuthCard";
import { Field } from "../components/Field";
import { useRegister } from "../session";

const MESSAGES: Record<string, string> = {
  exists: "That username is taken.",
  too_many: "Too many new accounts from this address. Try again in an hour.",
  registration_closed: "This server does not take new accounts. Ask its owner to add you.",
  bad_request:
    "Use 2 to 32 lowercase letters, digits, dots, dashes or underscores, and at least 8 characters of password.",
};

export function Register() {
  const register = useRegister();
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
    register.mutate({ username, password });
  };
  const error = mismatch
    ? "The passwords differ."
    : register.error instanceof ApiError
      ? (MESSAGES[register.error.code] ?? `The account could not be created (${register.error.code}).`)
      : register.error?.message;

  return (
    <AuthCard title="Create account" lead="A username and a password is all it takes.">
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
          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          <Button size="3" type="submit" loading={register.isPending}>
            Create account
          </Button>
          <Text size="2" color="gray" align="center">
            Already registered? <Link to="/login">Sign in</Link>
          </Text>
        </Flex>
      </form>
    </AuthCard>
  );
}

import { Button, Callout, Flex, Text } from "@radix-ui/themes";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api";
import { AuthCard } from "../components/AuthCard";
import { Field } from "../components/Field";
import { useLogin } from "../session";

const MESSAGES: Record<string, string> = {
  invalid: "Wrong username or password.",
  locked: "Too many attempts. Try again in 15 minutes.",
};

export function Login() {
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ username, password });
  };
  const error = login.error instanceof ApiError ? MESSAGES[login.error.code] : login.error?.message;

  return (
    <AuthCard title="Alexsay" lead="Sign in to your speakers.">
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
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          <Button size="3" type="submit" loading={login.isPending}>
            Sign in
          </Button>
          <Text size="2" color="gray" align="center">
            New here? <Link to="/register">Create an account</Link>
          </Text>
        </Flex>
      </form>
    </AuthCard>
  );
}

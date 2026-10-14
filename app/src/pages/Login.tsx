import { Button, Callout, Flex, Spinner, Tabs, Text } from "@radix-ui/themes";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { ApiError, api } from "../api";
import { AuthCard } from "../components/AuthCard";
import { Captcha } from "../components/Captcha";
import { Field } from "../components/Field";
import { useAuthConfig, useLogin, useSignIn } from "../session";

const MESSAGES: Record<string, string> = {
  invalid: "Wrong username or password.",
  locked: "Too many attempts. Try again in 15 minutes.",
  wrong: "That code is not right. Check the latest email.",
  expired: "That code has expired. Send a new one.",
  too_many_attempts: "Too many wrong codes. Send a new one.",
  too_many: "Too many emails to this address. Try again in an hour.",
  email_login_off: "Email sign-in is switched off on this server.",
  captcha_failed: "Please complete the check above and try again.",
  bad_request: "Check the address and the six-digit code.",
};

function errorText(error: Error | null): string | undefined {
  return error instanceof ApiError ? (MESSAGES[error.code] ?? error.message) : error?.message;
}

export function Login() {
  const config = useAuthConfig();
  return (
    <AuthCard title="Alexsay" lead="Sign in to your speakers.">
      {config.isPending ? (
        <Flex justify="center" py="4">
          <Spinner />
        </Flex>
      ) : config.data?.email_login ? (
        <Tabs.Root defaultValue="email">
          <Tabs.List>
            <Tabs.Trigger value="email">Email</Tabs.Trigger>
            <Tabs.Trigger value="password">Password</Tabs.Trigger>
          </Tabs.List>
          <Flex direction="column" pt="4">
            <Tabs.Content value="email">
              <EmailSignIn captcha={config.data.captcha} />
            </Tabs.Content>
            <Tabs.Content value="password">
              <PasswordSignIn captcha={config.data.captcha} />
            </Tabs.Content>
          </Flex>
        </Tabs.Root>
      ) : (
        <PasswordSignIn captcha={config.data?.captcha ?? null} />
      )}
      {config.data?.registration !== false && (
        <Text size="2" color="gray" align="center">
          New here? <Link to="/register">Create an account</Link>
        </Text>
      )}
    </AuthCard>
  );
}

function PasswordSignIn({ captcha }: { captcha: string | null }) {
  const login = useLogin();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [human, setHuman] = useState("");
  const [captchaRound, setCaptchaRound] = useState(0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate(
      { username, password, captcha: captcha ? human : undefined },
      { onSettled: () => setCaptchaRound((round) => round + 1) },
    );
  };
  const error = errorText(login.error);

  return (
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
        {captcha && <Captcha siteKey={captcha} resetKey={captchaRound} onToken={setHuman} />}
        {error && (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Button size="3" type="submit" loading={login.isPending} disabled={Boolean(captcha) && !human}>
          Sign in
        </Button>
      </Flex>
    </form>
  );
}

/** Two steps: the address, then the six digits from the email (or its link, which signs in by itself). */
export function EmailSignIn({ captcha }: { captcha: string | null }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [human, setHuman] = useState("");
  const [captchaRound, setCaptchaRound] = useState(0);
  const send = useMutation({
    mutationFn: (address: string) => api.emailStart(address, captcha ? human : undefined).then(() => address),
    onSuccess: setSentTo,
    onSettled: () => setCaptchaRound((round) => round + 1),
  });
  const verify = useSignIn(({ address, digits }: { address: string; digits: string }) =>
    api.emailVerify(address, digits),
  );

  if (!sentTo) {
    const error = errorText(send.error);
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate(email.trim());
        }}
      >
        <Flex direction="column" gap="4">
          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {captcha && <Captcha siteKey={captcha} resetKey={captchaRound} onToken={setHuman} />}
          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          <Button size="3" type="submit" loading={send.isPending} disabled={Boolean(captcha) && !human}>
            Email me a code
          </Button>
        </Flex>
      </form>
    );
  }
  const error = errorText(verify.error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        verify.mutate({ address: sentTo, digits: code.trim() });
      }}
    >
      <Flex direction="column" gap="4">
        <Text size="2" color="gray">
          Check your inbox.
        </Text>
        <Field
          id="code"
          label="Code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
        />
        {error && (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Button size="3" type="submit" loading={verify.isPending}>
          Sign in
        </Button>
        <Button
          type="button"
          variant="ghost"
          color="gray"
          onClick={() => {
            setSentTo(null);
            setCode("");
            verify.reset();
          }}
        >
          Use another address or send a new code
        </Button>
      </Flex>
    </form>
  );
}

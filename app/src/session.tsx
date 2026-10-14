import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type User } from "./api";

export function useSession() {
  return useQuery<User | null>({
    queryKey: ["session"],
    queryFn: () =>
      api.me().catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          return null;
        }
        throw e;
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

type Credentials = { username: string; password: string };

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password, captcha }: Credentials & { captcha?: string }) =>
      api.login(username, password, captcha),
    onSuccess: (user) => client.setQueryData(["session"], user),
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password, captcha }: Credentials & { captcha?: string }) =>
      api.register(username, password, captcha),
    onSuccess: (user) => client.setQueryData(["session"], user),
  });
}

/** Any way of signing in that ends with the server's answer about who you are now. */
export function useSignIn<Args>(signIn: (args: Args) => Promise<User>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: signIn,
    onSuccess: (user) => {
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      client.setQueryData(["session"], user);
    },
  });
}

export function useAuthConfig() {
  return useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig, staleTime: 60_000 });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      client.setQueryData(["session"], null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    },
  });
}

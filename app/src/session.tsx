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
    mutationFn: ({ username, password }: Credentials) => api.login(username, password),
    onSuccess: (user) => client.setQueryData(["session"], user),
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ username, password }: Credentials) => api.register(username, password),
    onSuccess: (user) => client.setQueryData(["session"], user),
  });
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

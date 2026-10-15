import "@radix-ui/themes/styles.css";
import "./styles.css";
import { Theme } from "@radix-ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { healStyles } from "./lib/styles";
import { AppearanceProvider } from "./theme";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });
const root = document.getElementById("root");

if (root) {
  // A stylesheet cached wrongly during a deploy leaves the app bare: fetch it afresh and reload, once
  window.addEventListener("load", () => void healStyles());
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider>
          {(appearance) => (
            <Theme appearance={appearance} accentColor="indigo" grayColor="slate" radius="large" scaling="100%">
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </Theme>
          )}
        </AppearanceProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

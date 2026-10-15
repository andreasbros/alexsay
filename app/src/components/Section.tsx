import { ChevronRightIcon } from "@radix-ui/react-icons";
import { Box, Card, Flex, Heading } from "@radix-ui/themes";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

const STORAGE_PREFIX = "section-open:";

/** Whether the person left this section open last time; closed until they do. */
function remembered(id: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

function remember(id: string, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + id, open ? "1" : "0");
  } catch {
    // Private windows and blocked storage: the choice lasts for the page only
  }
}

interface SectionControls {
  /** Opens the section, for an action in its header whose result lives inside (adding a speaker). */
  open: () => void;
}

const SectionContext = createContext<SectionControls>({ open: () => undefined });

export const useSection = (): SectionControls => useContext(SectionContext);

/**
 * A card on the Home page that folds to its title. Closed by default; the browser remembers each one
 * the person opened. Actions in the header (Add device, a connection's status) stay reachable while closed.
 */
export function Section({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => remembered(id));
  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      remember(id, next);
    },
    [id],
  );
  const controls = useMemo(() => ({ open: () => set(true) }), [set]);
  const bodyId = `section-${id}`;
  return (
    <SectionContext.Provider value={controls}>
      <Card size="3">
        <Flex direction="column" gap="3">
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <Heading size="4">
              <button
                type="button"
                className="section-toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => set(!open)}
              >
                <ChevronRightIcon
                  aria-hidden
                  style={{ transition: "transform 0.15s", transform: open ? "rotate(90deg)" : undefined }}
                />
                {title}
              </button>
            </Heading>
            {actions && <Box>{actions}</Box>}
          </Flex>
          {open && (
            <Flex direction="column" gap="3" id={bodyId}>
              {children}
            </Flex>
          )}
        </Flex>
      </Card>
    </SectionContext.Provider>
  );
}

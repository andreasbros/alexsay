import { ExitIcon, MoonIcon, PersonIcon, SunIcon } from "@radix-ui/react-icons";
import { Box, Container, DropdownMenu, Flex, IconButton, Separator, TabNav, Text } from "@radix-ui/themes";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import type { User } from "../api";
import { useLogout } from "../session";
import { useAppearance } from "../theme";
import { Logo } from "./Logo";

const TABS: [string, string][] = [
  ["Devices", "/"],
  ["Assistant", "/assistant"],
  ["Connections", "/connections"],
];

export function Layout({ user }: { user: User }) {
  const { appearance, toggle } = useAppearance();
  const logout = useLogout();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Box>
      <Box style={{ background: "var(--color-panel-solid)", borderBottom: "1px solid var(--gray-a5)" }}>
        <Container size="4" px="4">
          <Flex align="center" justify="between" height="56px" gap="3">
            <Flex align="center" gap={{ initial: "3", xs: "5" }} minWidth="0">
              <Link to="/" style={{ color: "inherit", textDecoration: "none" }}>
                <Flex align="center" gap="2">
                  <Box style={{ color: "var(--accent-9)" }}>
                    <Logo size={24} />
                  </Box>
                  <Box display={{ initial: "none", xs: "block" }}>
                    <Text weight="bold" size="4">
                      Alexsay
                    </Text>
                  </Box>
                </Flex>
              </Link>
              <Box display={{ initial: "none", sm: "block" }}>
                <Tabs pathname={pathname} />
              </Box>
            </Flex>
            <Flex align="center" gap="3" flexShrink="0">
              <IconButton variant="ghost" color="gray" onClick={toggle} aria-label="Toggle theme">
                {appearance === "dark" ? <SunIcon /> : <MoonIcon />}
              </IconButton>
              <Separator orientation="vertical" />
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <IconButton variant="soft" radius="full" aria-label="Account">
                    {user.username.slice(0, 1).toUpperCase()}
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Label>
                    {user.username} · {user.role}
                  </DropdownMenu.Label>
                  <DropdownMenu.Separator />
                  {user.role === "admin" && (
                    <DropdownMenu.Item onSelect={() => navigate("/users")}>
                      <PersonIcon /> Users
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item onSelect={() => logout.mutate()}>
                    <ExitIcon /> Sign out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Flex>
          </Flex>
          {/* Phones get the tabs on their own row, so they never overlap the account buttons */}
          <Box display={{ initial: "block", sm: "none" }} pb="2">
            <Tabs pathname={pathname} />
          </Box>
        </Container>
      </Box>
      <Container size="4" px="4" className="page">
        <Outlet />
      </Container>
    </Box>
  );
}

function Tabs({ pathname }: { pathname: string }) {
  return (
    <TabNav.Root>
      {TABS.map(([label, to]) => (
        <TabNav.Link key={to} asChild active={to === "/" ? pathname === "/" : pathname.startsWith(to)}>
          <Link to={to}>{label}</Link>
        </TabNav.Link>
      ))}
    </TabNav.Root>
  );
}

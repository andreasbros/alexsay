import { Flex, Spinner } from "@radix-ui/themes";
import { Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { Assistant } from "./pages/Assistant";
import { EmailLink } from "./pages/EmailLink";
import { HomePage } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { Login } from "./pages/Login";
import { MemoryPage } from "./pages/Memory";
import { Register } from "./pages/Register";
import { Settings } from "./pages/Settings";
import { Skills } from "./pages/Skills";
import { Users } from "./pages/Users";
import { useSession } from "./session";

export function App() {
  const session = useSession();

  if (session.isPending) {
    return (
      <Flex className="screen" align="center" justify="center">
        <Spinner size="3" />
      </Flex>
    );
  }
  const user = session.data;
  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/sign-in/email" element={<EmailLink />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/sign-in/email" element={<EmailLink />} />
      <Route path="/invite" element={<Invite />} />
      <Route element={<Layout user={user} />}>
        <Route index element={<HomePage user={user} />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="connections" element={<Navigate to="/#connections" replace />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="skills" element={<Skills />} />
        <Route path="settings" element={<Settings user={user} />} />
        {user.role === "admin" && <Route path="users" element={<Users user={user} />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

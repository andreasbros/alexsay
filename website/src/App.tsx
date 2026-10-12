import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { metaFor } from "./content/routes";
import { Blog } from "./pages/Blog";
import { BlogPost } from "./pages/BlogPost";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";
import "./styles/components.css";
import "./styles/home.css";
import "./styles/blog.css";

function ScrollAndTitle() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    document.title = metaFor(pathname).title;
    const target = hash ? document.querySelector(hash) : null;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: 0 });
    }
  }, [pathname, hash]);
  return null;
}

export function App() {
  return (
    <>
      <ScrollAndTitle />
      <Header />
      <main id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/blog" element={<Blog />} />
          <Route path="/blog/:slug" element={<BlogPost />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}

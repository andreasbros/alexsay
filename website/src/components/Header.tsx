import { useEffect, useState } from "react";
import { Link } from "react-router";
import { APP_URL, GITHUB_URL } from "../content/site";
import { IconGitHub, IconMoon, IconSun } from "./Icons";
import { Logo } from "./Logo";

const THEME_KEY = "ay-theme";
const NAV: [string, string][] = [
  ["Features", "/#features"],
  ["Integrations", "/#integrations"],
  ["Open source", "/#open-source"],
];

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") ?? "dark");
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    setTheme(next);
  };
  return [theme, toggle];
}

function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return scrolled;
}

export function Header() {
  const [theme, toggleTheme] = useTheme();
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);

  return (
    <header className={`header${scrolled ? " header-scrolled" : ""}`}>
      <div className="container header-inner">
        <Link to="/" className="header-logo" aria-label="Alexsay home">
          <Logo />
        </Link>
        <nav className="header-nav" aria-label="Primary">
          {NAV.map(([label, href]) => (
            <a key={label} href={href} className="nav-link">
              {label}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <a className="btn btn-secondary header-wide" href={GITHUB_URL}>
            <IconGitHub /> GitHub
          </a>
          <a className="btn btn-primary header-wide" href={APP_URL}>
            Open the app
          </a>
          <button
            type="button"
            className={`burger${open ? " burger-open" : ""}`}
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
      {open && (
        <div className="header-menu">
          <div className="container">
            {NAV.map(([label, href]) => (
              <a key={label} href={href} className="menu-link" onClick={() => setOpen(false)}>
                {label}
              </a>
            ))}
            <div className="menu-actions">
              <a className="btn btn-secondary" href={GITHUB_URL}>
                <IconGitHub /> GitHub
              </a>
              <a className="btn btn-primary" href={APP_URL}>
                Open the app
              </a>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
